import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

import {
  runBoundedAdversarialReview,
  type AdversarialReviewPolicy,
  type ReviewFinding,
  type ReviewResult,
} from "../../src/coordination/adversarial-review.ts";
import { createWorkerDispatch, type WorkerDispatchPolicy } from "../../src/coordination/worker-dispatch.ts";
import { configuredPath, loadPiNextConfig } from "../../src/coordination/config.ts";
import { sanitizeFeedbackText } from "../../src/coordination/feedback.ts";
import { writeJsonAtomic, git, runtimeDir } from "./util.ts";
import { runIssueWorker, type IssueWorkerRunner } from "./util-core.ts";

const MAX_DIFF = 24_000;
const MAX_RECORDS = 50;

export class CandidateReviewRequiredError extends Error {
  readonly code = "candidate_review_required";
  constructor(readonly findings: readonly ReviewFinding[], readonly candidateSha: string) {
    super(`Candidate ${candidateSha.slice(0, 12)} requires owner repair after adversarial review: ${findings.map((item) => item.summary).join("; ")}`);
    this.name = "CandidateReviewRequiredError";
  }
}

export interface CandidateReviewGateInput {
  ctx: ExtensionCommandContext;
  issueNumber: number;
  authorityFingerprint: string;
  risk: "low" | "normal" | "high" | "critical";
  worker?: IssueWorkerRunner;
  policy?: AdversarialReviewPolicy;
  fixedPointSha?: string;
}

function reviewRecordPath(cwd: string): string {
  return configuredPath(cwd, ".pi/runtime/pi-next-review.json");
}

function extractAssistantText(output: string): string {
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; message_end?: { message?: { content?: Array<{ type?: string; text?: string }> } }; turn_end?: { message?: { content?: Array<{ type?: string; text?: string }> } } };
      const events = value.type === "message_end" || value.type === "turn_end"
        ? [{ message: value.message }]
        : [value.message_end, value.turn_end];
      for (const event of events) {
        for (const part of event?.message?.content || []) if (part.type === "text" && part.text) texts.push(part.text);
      }
    } catch {
      // Worker stdout is expected to be JSONL; malformed lines are handled as a failed review.
    }
  }
  return texts.at(-1)?.trim() || "";
}

function parseReviewOutput(text: string, request: { issueNumber: number; candidateSha: string; fixedPointSha: string; authorityFingerprint: string; axis: "spec" | "standards" | "risk"; round: number }, reviewerId: string): ReviewResult {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("reviewer did not return structured JSON");
  const value = JSON.parse(json) as { verdict?: unknown; findings?: unknown };
  const findings = Array.isArray(value.findings)
    ? value.findings.slice(0, 5).map((raw): ReviewFinding => {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const severity = item.severity === "blocking" ? "blocking" : "non-blocking";
        return {
          summary: sanitizeFeedbackText(item.summary).slice(0, 240) || "Unspecified review finding",
          evidence: sanitizeFeedbackText(item.evidence).slice(0, 500),
          severity,
          concrete: item.concrete === true,
        };
      })
    : [];
  return {
    ...request,
    reviewerId,
    verdict: value.verdict === "findings" ? "findings" : "pass",
    findings,
  };
}

function reviewPrompt(axis: string, request: { issueNumber: number; candidateSha: string; fixedPointSha: string; authorityFingerprint: string }, diff: string): string {
  const focus = axis === "spec"
    ? "Challenge whether the candidate satisfies the authoritative work item and preserves authority/security invariants."
    : axis === "standards"
      ? "Challenge engineering correctness, regression risk, tests, error paths, and maintainability."
      : "Challenge the configured risk/domain boundary and unsafe or integrity-sensitive behavior.";
  return `You are a read-only adversarial reviewer. You cannot edit, run tools, claim work, promote, close, or change ownership. ${focus}
Review exact issue #${request.issueNumber}, candidate ${request.candidateSha}, fixed point ${request.fixedPointSha}, authority ${request.authorityFingerprint}.
Return ONLY JSON matching {"verdict":"pass"|"findings","findings":[{"summary":"...","evidence":"path or concrete diff evidence","severity":"blocking"|"non-blocking","concrete":true|false}]}.
Only concrete evidence-backed defects may be blocking; style preferences are non-blocking.

Exact candidate diff (bounded):
${diff}`;
}

/** Invoke the review gate immediately before semantic verification. */
export async function runCandidateReviewGate(input: CandidateReviewGateInput): Promise<void> {
  const config = loadPiNextConfig(input.ctx.cwd);
  const policy = input.policy || config.adversarialReview;
  if (!policy.enabled || (input.risk !== "high" && input.risk !== "critical")) return;

  const candidateSha = await git(input.ctx.cwd, ["rev-parse", "HEAD"]);
  let fixedPointSha = input.fixedPointSha || await git(input.ctx.cwd, ["rev-parse", "main"]).catch(() => git(input.ctx.cwd, ["rev-parse", "HEAD^"]));
  if (fixedPointSha === candidateSha) fixedPointSha = await git(input.ctx.cwd, ["rev-parse", "HEAD^"]);
  const diff = (await git(input.ctx.cwd, ["diff", "--no-ext-diff", fixedPointSha, candidateSha])).slice(0, MAX_DIFF);
  const worker = input.worker || runIssueWorker;
  const results: ReviewResult[] = [];
  const review = await runBoundedAdversarialReview({
    binding: { issueNumber: input.issueNumber, candidateSha, fixedPointSha, authorityFingerprint: input.authorityFingerprint },
    risk: input.risk,
    policy,
    dispatch: (axis, binding, round): WorkerDispatchPolicy => createWorkerDispatch({
      phase: `review-${axis}`,
      issueNumber: binding.issueNumber,
      candidateSha: binding.candidateSha,
      fixedPointSha: binding.fixedPointSha,
      authorityFingerprint: binding.authorityFingerprint,
      risk: input.risk,
      task: `read-only candidate review round ${round}`,
      boundInputs: axis === "spec"
        ? { specEvidence: `authority:${binding.authorityFingerprint}` }
        : { standardsSources: "AGENTS.md,repository-policy,changed-paths" },
      modelPolicy: config.workerDispatch.models[`review-${axis}` as "review-spec" | "review-standards"],
    }),
    execute: async (request, context) => {
      const execution = await worker(input.ctx.cwd, reviewPrompt(request.axis, request, diff), {
        issueNumber: input.issueNumber,
        phase: request.axis === "spec" ? "review-spec" : request.axis === "standards" ? "review-standards" : "review-standards",
        dispatch: request.dispatch,
        readOnly: true,
      });
      if (!execution.ok) {
        return {
          ...request,
          reviewerId: context.reviewerId,
          verdict: "findings",
          findings: [{ summary: "Reviewer process failed", evidence: sanitizeFeedbackText(execution.output).slice(-500), severity: "blocking", concrete: true }],
        };
      }
      return parseReviewOutput(extractAssistantText(execution.output), request, context.reviewerId);
    },
  });
  results.push(...review.results);
  const record = {
    version: 1,
    issueNumber: input.issueNumber,
    candidateSha: review.binding.candidateSha,
    fixedPointSha: review.binding.fixedPointSha,
    authorityFingerprint: review.binding.authorityFingerprint,
    status: review.status,
    rounds: review.telemetry.rounds,
    reviewers: review.telemetry.reviewerIds.slice(0, MAX_RECORDS),
    axes: review.telemetry.axes,
    blockingFindings: review.telemetry.blockingFindings,
    results: results.map((item) => ({ axis: item.axis, round: item.round, verdict: item.verdict, reviewerId: item.reviewerId, findings: item.findings })),
    recordedAt: new Date().toISOString(),
  };
  writeJsonAtomic(reviewRecordPath(input.ctx.cwd), record);
  if (review.status === "blocked") {
    throw new CandidateReviewRequiredError(results.flatMap((item) => item.findings.filter((finding) => finding.severity === "blocking" && finding.concrete)), candidateSha);
  }
}

export function candidateReviewRecordExists(cwd: string): boolean {
  return existsSync(reviewRecordPath(cwd));
}