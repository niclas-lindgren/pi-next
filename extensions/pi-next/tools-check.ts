import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  ACCEPTANCE_EVIDENCE_POLICY,
  evaluateManualAcceptanceCriterion,
  isFinalVerificationExternalCriterion,
  isMechanicalAcceptanceCriterion,
  missingAuthoritativeAcceptanceCriteria,
  validateManualAcceptanceReviews,
  type ManualAcceptanceReview,
} from "./acceptance-verification.ts";
import { getLiveIssueFingerprint } from "./issue-freshness.ts";
import { recordCurrentPiLifecycleJournal } from "./lifecycle-journal.ts";
import { runCandidateReviewGate } from "./candidate-review.ts";
import { currentGeneration } from "./supervisor-status.ts";
import { recordTransition } from "./workflow-commit-policy.ts";
import { acceptanceCriteria, issueNumber } from "./plan.ts";
import {
  aggregateVerificationFailureDisposition,
  reviewFailureDisposition,
  validateFailureDispositionReviews,
  type FailureDispositionReview,
  type VerificationFailureDisposition,
} from "./verification-failure-disposition.ts";
import {
  combineSignals,
  diffSummary,
  errorOutput,
  failureEvidence,
  runVerificationCommand,
  planFile,
  QUALITY_MAX_AGE_MS,
  readQualityEvidence,
  safetyFindings,
  verifyFile,
  workingFingerprint,
  git,
  writeLog,
  writeQualityEvidence,
  safeToolUpdate,
  type QualityCommandEvidence,
} from "./util.ts";

const scopeSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("staged"),
  Type.Literal("unstaged"),
]);

const reviewSchema = Type.Object({
  criterion: Type.String({ minLength: 1 }),
  verdict: Type.Union([
    Type.Literal("pass"),
    Type.Literal("fail"),
    Type.Literal("external"),
  ]),
  evidence: Type.String(),
  scope: Type.Optional(
    Type.Union([Type.Literal("local"), Type.Literal("composed/system-level")]),
  ),
  failureDisposition: Type.Optional(
    Type.Union([
      Type.Literal("repair"),
      Type.Literal("defer_issue"),
      Type.Literal("reconcile"),
    ]),
  ),
  authority: Type.Optional(Type.String()),
});

type SemanticReview = ManualAcceptanceReview & FailureDispositionReview;

function readPlan(cwd: string): string {
  const file = planFile(cwd);
  if (!existsSync(file)) throw new Error(`PLAN.md not found at ${file}`);
  return readFileSync(file, "utf8");
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function reusableCommand(
  evidence: ReturnType<typeof readQualityEvidence>,
  fingerprint: string,
  command: string,
): QualityCommandEvidence | undefined {
  if (!evidence || evidence.fingerprint !== fingerprint) return undefined;
  const found = evidence.commands?.find(
    (item) => item.command === command && item.ok,
  );
  if (!found) return undefined;
  const age = Date.now() - Date.parse(found.completedAt);
  if (!Number.isFinite(age) || age < 0 || age > QUALITY_MAX_AGE_MS) {
    return undefined;
  }
  return found;
}

export function registerCheckTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_next_check",
    label: "Pi Next Check",
    description:
      "Run quality gates, complete-worktree safety scanning, deterministic diff review, or evidence-backed semantic verification. Checked PLAN.md criteria are workflow state, never verification proof. Final verification binds structured evidence to the current live GitHub issue/comments fingerprint and rejects omitted/reworded issue-body acceptance criteria. FAIL reviews may classify routing as repair, defer_issue, or reconcile; routing never converts FAIL into PASS, and defer/reconcile require concrete authoritative GitHub evidence.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("quality"),
        level: Type.Optional(
          Type.Union([
            Type.Literal("quick"),
            Type.Literal("standard"),
            Type.Literal("full"),
          ]),
        ),
      }),
      Type.Object({
        action: Type.Literal("safety"),
        scope: Type.Optional(scopeSchema),
      }),
      Type.Object({
        action: Type.Literal("diff"),
        scope: Type.Optional(scopeSchema),
      }),
      Type.Object({
        action: Type.Literal("verify"),
        reviews: Type.Optional(Type.Array(reviewSchema)),
      }),
    ]),
    async execute(_id, params, _signal, onUpdate, ctx) {
      // Route every progress update through the shared lifecycle-aware host
      // boundary (#583): once the owning extension generation is disposed,
      // a stale update is suppressed rather than delivered to a replacement
      // session/tool call.
      const isDisposed = () => currentGeneration()?.isDisposed() ?? false;
      const update = <T>(value: T) =>
        safeToolUpdate(onUpdate, value, isDisposed);
      if (params.action === "quality") {
        recordTransition(
          ctx.cwd,
          issueNumber(readPlan(ctx.cwd)),
          "verification",
        );
        const packagePath = `${ctx.cwd}/package.json`;
        const scripts = existsSync(packagePath)
          ? (
              JSON.parse(readFileSync(packagePath, "utf8")) as {
                scripts?: Record<string, string>;
              }
            ).scripts || {}
          : {};
        const level = params.level || "quick";
        const wanted =
          level === "quick"
            ? ["verify:quick"]
            : level === "full"
              ? ["verify:full"]
              : ["verify"];
        const commands = wanted
          .filter((name) => scripts[name])
          .map((name) => `npm run ${name}`);
        if (!commands.length) commands.push("npm test");

        const fingerprintBefore = await workingFingerprint(ctx.cwd);
        const prior = readQualityEvidence(ctx.cwd);
        const results: Array<{
          command: string;
          ok: boolean;
          durationMs: number;
          completedAt: string;
          reused: boolean;
          output: string;
        }> = [];

        for (const command of commands) {
          const reusable = reusableCommand(prior, fingerprintBefore, command);
          if (reusable) {
            update({
              content: [
                {
                  type: "text",
                  text: `Reusing ${command} evidence for current fingerprint...`,
                },
              ],
            });
            results.push({
              command,
              ok: true,
              durationMs: reusable.durationMs,
              completedAt: reusable.completedAt,
              reused: true,
              output: `Reused passing evidence from ${reusable.completedAt}`,
            });
            continue;
          }

          update({
            content: [{ type: "text", text: `Running ${command}...` }],
          });
          const started = Date.now();
          try {
            const generation = currentGeneration();
            // Combine the host's per-call signal with the owning extension
            // generation's signal (#583) so a torn-down/replaced generation
            // can actually kill an in-flight verification subprocess rather
            // than only relying on host-level tool-call cancellation, and
            // register the run so generation teardown diagnostics reflect
            // real in-flight subprocess work.
            const commandPromise = runVerificationCommand(
              ctx.cwd,
              command.replace(/^npm run /, ""),
              command,
              {
                signal: combineSignals([_signal, generation?.signal]),
                onHeartbeat: (text) =>
                  update({
                    content: [{ type: "text", text }],
                  }),
              },
            );
            const result = await (generation
              ? generation.track(commandPromise, { kind: "subprocess" })
              : commandPromise);
            results.push({
              command,
              ok: result.ok,
              durationMs: Date.now() - started,
              completedAt: new Date().toISOString(),
              reused: false,
              output: result.output.trim(),
            });
            if (!result.ok) break;
          } catch (error) {
            results.push({
              command,
              ok: false,
              durationMs: Date.now() - started,
              completedAt: new Date().toISOString(),
              reused: false,
              output: errorOutput(error),
            });
            break;
          }
        }

        const fingerprintAfter = await workingFingerprint(ctx.cwd);
        const fingerprintStable = fingerprintAfter === fingerprintBefore;
        const allRequiredRan = results.length === commands.length;
        const ok =
          fingerprintStable &&
          allRequiredRan &&
          results.length > 0 &&
          results.every((result) => result.ok);

        const logPath = writeLog(
          ctx.cwd,
          `quality-${level}`,
          [
            ...results.map(
              (result) =>
                `## ${result.command}\nstatus=${result.ok ? "PASS" : "FAIL"}\nreused=${result.reused ? "yes" : "no"}\nduration_ms=${result.durationMs}\ncompleted_at=${result.completedAt}\n\n${result.output}`,
            ),
            fingerprintStable
              ? ""
              : `## fingerprint\nstatus=FAIL\nbefore=${fingerprintBefore}\nafter=${fingerprintAfter}\nQuality commands changed the working fingerprint; rerun the gate on the resulting state.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );

        const merged = new Map<string, QualityCommandEvidence>();
        if (prior?.fingerprint === fingerprintBefore) {
          for (const command of prior.commands || []) {
            if (reusableCommand(prior, fingerprintBefore, command.command)) {
              merged.set(command.command, command);
            }
          }
        }
        if (fingerprintStable) {
          for (const result of results) {
            merged.set(result.command, {
              command: result.command,
              ok: result.ok,
              durationMs: result.durationMs,
              completedAt: result.completedAt,
              reused: result.reused,
            });
          }
        } else {
          merged.clear();
        }

        const requiredCompleted = results
          .filter((result) => result.ok)
          .map((result) => Date.parse(result.completedAt))
          .filter(Number.isFinite);
        const completedAt =
          ok && requiredCompleted.length === commands.length
            ? new Date(Math.min(...requiredCompleted)).toISOString()
            : new Date().toISOString();

        writeQualityEvidence(ctx.cwd, {
          level,
          ok,
          fingerprint: fingerprintAfter,
          completedAt,
          logPath,
          commands: [...merged.values()],
        });

        const lines = [
          `STATUS: ${ok ? "PASS" : "FAIL"}`,
          ...results.map(
            (result) =>
              `${result.ok ? "✓" : "✗"} ${result.command} — ${result.reused ? "reused" : `${(result.durationMs / 1000).toFixed(1)}s`}`,
          ),
          ...(fingerprintStable
            ? []
            : [
                "✗ Working fingerprint changed during quality gate; rerun required",
              ]),
          `Fingerprint: ${fingerprintAfter}`,
          `Full log: ${logPath}`,
        ];
        const failed = results.find((result) => !result.ok);
        if (failed) {
          lines.push("", "Failure evidence:", failureEvidence(failed.output));
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ok,
            level,
            fingerprint: fingerprintAfter,
            logPath,
            results: results.map(
              ({
                command,
                ok: passed,
                durationMs,
                completedAt: at,
                reused,
              }) => ({
                command,
                ok: passed,
                durationMs,
                completedAt: at,
                reused,
              }),
            ),
          },
        };
      }

      if (params.action === "safety") {
        const scope = params.scope || "all";
        const { findings, files } = await safetyFindings(ctx.cwd, scope);
        return {
          content: [
            {
              type: "text",
              text: findings.length
                ? `STATUS: FAIL\n${findings.map((finding) => `- ${finding}`).join("\n")}`
                : `STATUS: PASS\nScanned ${files.length} changed file(s) across ${scope}.`,
            },
          ],
          details: { ok: !findings.length, scope, findings, files },
        };
      }

      if (params.action === "diff") {
        const scope = params.scope || "all";
        const summary = await diffSummary(ctx.cwd, scope);
        const warnings: string[] = [];
        if (!summary.files.length) warnings.push("No diff to review.");
        if (summary.files.length > 20) {
          warnings.push(
            `Large change set: ${summary.files.length} files changed.`,
          );
        }
        if (/\.only\(/.test(summary.text))
          warnings.push("Focused test marker found.");
        if (/console\.log\(/.test(summary.text))
          warnings.push("console.log found.");
        if (/TODO|FIXME|placeholder|not implemented/i.test(summary.text)) {
          warnings.push("TODO/FIXME/placeholder text found.");
        }
        if (/as any\b|: any\b/.test(summary.text)) {
          warnings.push("TypeScript any usage found.");
        }
        const ok =
          !warnings.length ||
          (warnings.length === 1 && warnings[0] === "No diff to review.");
        return {
          content: [
            {
              type: "text",
              text: [
                `STATUS: ${ok ? "PASS" : "WARN"}`,
                `Scope: ${scope}`,
                summary.stat,
                ...warnings.map((warning) => `- ${warning}`),
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: {
            ok,
            scope,
            warnings,
            files: summary.files,
            stat: summary.stat,
          },
        };
      }

      const plan = readPlan(ctx.cwd);
      recordTransition(ctx.cwd, issueNumber(plan), "verification");
      const checks = acceptanceCriteria(plan);
      const reviews = (params.reviews ?? []) as SemanticReview[];
      const semanticReviews = reviews.filter(
        (review) => !isMechanicalAcceptanceCriterion(review.criterion),
      );

      const githubIssue = issueNumber(plan);
      let issueFingerprint: string | undefined;
      let issueUpdatedAt: string | undefined;
      let liveAcceptanceCriteria: string[] = [];
      let issueRisk: "low" | "normal" | "high" | "critical" = "normal";
      let authorityVerified = false;
      if (githubIssue) {
        try {
          const live = await getLiveIssueFingerprint(ctx.cwd, githubIssue);
          issueFingerprint = live.fingerprint;
          issueUpdatedAt = live.githubUpdatedAt;
          liveAcceptanceCriteria = live.acceptanceCriteria;
          issueRisk = live.risk;
          authorityVerified = true;
        } catch {
          authorityVerified = false;
        }
      }

      if (authorityVerified && issueFingerprint && githubIssue) {
        await runCandidateReviewGate({
          ctx,
          issueNumber: githubIssue,
          authorityFingerprint: issueFingerprint,
          risk: issueRisk,
        });
      }

      const reviewErrors = [
        ...validateManualAcceptanceReviews(
          checks,
          semanticReviews,
          authorityVerified ? liveAcceptanceCriteria : [],
        ),
        ...validateFailureDispositionReviews(semanticReviews),
      ];
      if (reviewErrors.length) {
        throw new Error(
          `Invalid semantic verification reviews:\n${reviewErrors.map((error) => `- ${error}`).join("\n")}`,
        );
      }

      const missingAuthorityCriteria = authorityVerified
        ? missingAuthoritativeAcceptanceCriteria(liveAcceptanceCriteria, checks)
        : [];
      const rows: string[] = missingAuthorityCriteria.map(
        (criterion) =>
          `| ${tableCell(`GitHub authority: ${criterion}`)} | FAIL | authoritative issue criterion is missing or reworded in PLAN.md |`,
      );
      const failureDispositions: VerificationFailureDisposition[] = [];
      if (missingAuthorityCriteria.length)
        failureDispositions.push("RECONCILE");
      let failed = missingAuthorityCriteria.length > 0;
      let unresolved = !checks.length || !authorityVerified;
      let externalCount = 0;
      let unprovenCount = 0;
      let reviewedPassCount = 0;

      for (const criterion of checks) {
        const check = criterion.text;
        // The final-verification classifier is the semantic boundary here:
        // only criteria it identifies as genuinely external may enter the
        // provenance-only path. Meta/regression criteria must continue to the
        // ordinary repository-evidence evaluator below.
        const requiresExternalEvidence =
          isFinalVerificationExternalCriterion(check);
        if (requiresExternalEvidence) {
          const result = evaluateManualAcceptanceCriterion(
            criterion,
            semanticReviews,
          );
          externalCount += 1;
          unresolved = true;
          rows.push(
            `| ${tableCell(check)} | ${result.verdict} | ${tableCell(result.evidence)} |`,
          );
          continue;
        }

        if (check.startsWith("run:")) {
          try {
            const generation = currentGeneration();
            const commandPromise = runVerificationCommand(
              ctx.cwd,
              "acceptance-run",
              check.slice(4).trim(),
              {
                shell: true,
                signal: combineSignals([_signal, generation?.signal]),
                onHeartbeat: (text) =>
                  update({
                    content: [{ type: "text", text }],
                  }),
              },
            );
            const result = await (generation
              ? generation.track(commandPromise, { kind: "subprocess" })
              : commandPromise);
            if (!result.ok) throw new Error(result.output);
            rows.push(`| ${tableCell(check)} | PASS | exit 0 |`);
          } catch (error) {
            failed = true;
            failureDispositions.push("REPAIR");
            rows.push(
              `| ${tableCell(check)} | FAIL | ${tableCell(failureEvidence(errorOutput(error)).slice(0, 220))} |`,
            );
          }
          continue;
        }

        if (check.startsWith("grep:")) {
          const body = check.slice(5).trim();
          const match = body.match(/^(.*?)\s+contains\s+(.+)$/);
          const target = match?.[1]?.trim();
          const pattern = match?.[2]?.trim();
          const ok = Boolean(
            target &&
            pattern &&
            existsSync(`${ctx.cwd}/${target}`) &&
            readFileSync(`${ctx.cwd}/${target}`, "utf8").includes(pattern),
          );
          if (!ok) {
            failed = true;
            failureDispositions.push("REPAIR");
          }
          rows.push(
            `| ${tableCell(check)} | ${ok ? "PASS" : "FAIL"} | ${ok ? "matched" : "not matched"} |`,
          );
          continue;
        }

        const result = evaluateManualAcceptanceCriterion(
          criterion,
          semanticReviews,
        );
        if (result.verdict === "FAIL") {
          failed = true;
          failureDispositions.push(
            reviewFailureDisposition(
              semanticReviews.find((review) => review.criterion === check),
            ),
          );
        }
        if (result.verdict === "EXTERNAL") {
          externalCount += 1;
          unresolved = true;
        } else if (result.verdict === "UNPROVEN") {
          unprovenCount += 1;
          unresolved = true;
        } else if (result.verdict === "PASS") {
          reviewedPassCount += 1;
        }
        rows.push(
          `| ${tableCell(check)} | ${result.verdict} | ${tableCell(result.evidence)} |`,
        );
      }

      const status = failed ? "FAIL" : unresolved ? "NEEDS_REVIEW" : "PASS";
      const failureDisposition =
        aggregateVerificationFailureDisposition(failureDispositions);
      const fingerprint = await workingFingerprint(ctx.cwd);
      const authorityAcceptanceStatus = !authorityVerified
        ? "UNVERIFIED"
        : missingAuthorityCriteria.length
          ? "MISMATCH"
          : "MATCHED";
      const report = `# Verification Report\n\nSTATUS: ${status}\nFAIL_DISPOSITION: ${failureDisposition ?? "NONE"}\nEVIDENCE_POLICY: ${ACCEPTANCE_EVIDENCE_POLICY}\nFINGERPRINT: ${fingerprint}\nGITHUB_ISSUE: ${githubIssue ? `#${githubIssue}` : "unknown"}\nISSUE_FINGERPRINT: ${issueFingerprint ?? "unverified"}\nISSUE_UPDATED_AT: ${issueUpdatedAt ?? "unverified"}\nAUTHORITY_STATUS: ${authorityVerified ? "VERIFIED" : "UNVERIFIED"}\nAUTHORITY_ACCEPTANCE_STATUS: ${authorityAcceptanceStatus}\nGENERATED_AT: ${new Date().toISOString()}\n\nA checked PLAN.md acceptance checkbox is workflow state only and is never verification evidence. GitHub issue-body acceptance wording remains authoritative; ordinary semantic criteria require concrete structured review evidence; \`external:\` criteria cannot self-pass. Failure disposition controls only the next workflow route and never turns semantic FAIL into PASS.\n\n| Criterion | Verdict | Evidence |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
      const reportPath = verifyFile(ctx.cwd);
      writeFileSync(reportPath, report);
      const headSha = await git(ctx.cwd, ["rev-parse", "HEAD"]).catch(() => undefined);
      const journalCriteriaIds = checks.slice(0, 64).map((check) => `criterion:${createHash("sha256").update(check.text).digest("hex").slice(0, 16)}`);
      const journalCwd = process.env.PI_NEXT_COORDINATION_CWD?.trim() || ctx.cwd;
      recordCurrentPiLifecycleJournal(journalCwd, {
        event: "verification_finished",
        issueNumber: githubIssue || undefined,
        idempotencyKey: `verification:${githubIssue || "unknown"}:${fingerprint}:${status}`,
        payload: {
          verification: status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "unproven",
          ...(headSha ? { candidateSha: headSha, headSha } : {}),
          authorityFingerprint: issueFingerprint,
          criteriaIds: journalCriteriaIds,
        },
      });
      if (status === "NEEDS_REVIEW") {
        recordCurrentPiLifecycleJournal(journalCwd, {
          event: "pending_verification_recorded",
          issueNumber: githubIssue || undefined,
          idempotencyKey: `pending-verification:${githubIssue || "unknown"}:${fingerprint}`,
          payload: {
            ...(headSha ? { mainSha: headSha } : {}),
            criteriaIds: journalCriteriaIds,
          },
        });
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `STATUS: ${status}`,
              `FAIL_DISPOSITION: ${failureDisposition ?? "NONE"}`,
              `Evidence policy: ${ACCEPTANCE_EVIDENCE_POLICY}`,
              `Authority: ${authorityVerified ? `issue #${githubIssue} @ ${issueFingerprint}` : "UNVERIFIED"}`,
              `Authority acceptance: ${authorityAcceptanceStatus}${missingAuthorityCriteria.length ? ` (${missingAuthorityCriteria.length} missing/reworded)` : ""}`,
              `Criteria: ${checks.length} (reviewed-pass=${reviewedPassCount}, external=${externalCount}, unproven=${unprovenCount})`,
              `Fingerprint: ${fingerprint}`,
              `Report: ${reportPath}`,
            ].join("\n"),
          },
        ],
        details: {
          status,
          failureDisposition,
          failed,
          unresolved,
          count: checks.length,
          reviewedPassCount,
          externalCount,
          unprovenCount,
          missingAuthorityCriteria,
          fingerprint,
          issueNumber: githubIssue,
          issueFingerprint,
          authorityVerified,
          authorityAcceptanceStatus,
        },
      };
    },
  });
}
