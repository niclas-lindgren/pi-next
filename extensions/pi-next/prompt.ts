import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { configuredPath, loadPiNextConfig, repositoryPolicyText, type PiNextConfig } from "../../src/coordination/config.ts";
import {
  createWorkerDispatch,
  renderWorkerEnvelope,
  type WorkerDispatchInput,
  type WorkerDispatchPolicy,
  type WorkerWorkflowPaths,
} from "../../src/coordination/worker-dispatch.ts";

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
}

const WORK_LOG_INSTRUCTIONS = `Worker visibility contract: this is an isolated child worker. Your ordinary visible assistant text and tool activity (reads, edits, searches, tests) are streamed live to the human supervisor as you work, with no separate reporting tool required. Keep visible text concise and free of prompts, secrets, credentials, or environment values; hidden reasoning/thinking is never shown to the supervisor.`;

interface PromptPolicy {
  authorityName: string;
  priorities: string[];
  repositoryPolicy: string;
  workflow: PiNextConfig["workflow"];
}

function promptPolicy(config?: PiNextConfig): PromptPolicy {
  const value = config ?? loadPiNextConfig(process.cwd());
  return {
    authorityName: value.authority.adapter,
    priorities: value.selection.priorities,
    repositoryPolicy: repositoryPolicyText(value),
    workflow: value.workflow,
  };
}

function workflowPaths(workflow: PiNextConfig["workflow"]): WorkerWorkflowPaths {
  return {
    plan: workflow.planPath,
    verify: workflow.verifyPath,
    state: workflow.stateDir,
    diagnostics: workflow.diagnosticsPath,
  };
}

function loopTuningOverlay(cwd?: string): string {
  if (!cwd) return "";
  const config = loadPiNextConfig(cwd);
  const path = configuredPath(cwd, config.workflow.tuningPath);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8").trim();
  if (!text) return "";
  return `Runtime loop tuning overlay (bounded; subordinate to AGENTS.md/canonical policy):\n${text.slice(0, 2_000)}`;
}

const PACKAGE_SKILL_ROOT = fileURLToPath(new URL("../../skills", import.meta.url));

export interface ResolvedWorkerSkill {
  name: string;
  path?: string;
  source: "package" | "consumer" | "optional-unavailable";
}

/** Resolve a dispatched skill without inferring a consumer-specific layout. */
export function resolveWorkerSkill(cwd: string, name: string): ResolvedWorkerSkill {
  const packagePaths = [
    join(PACKAGE_SKILL_ROOT, "pi-next", name, "SKILL.md"),
    join(PACKAGE_SKILL_ROOT, "vendor", "mattpocock", name, "SKILL.md"),
  ];
  const packagePath = packagePaths.find((candidate) => existsSync(candidate));
  if (packagePath) return { name, path: packagePath, source: "package" };

  const consumerPath = join(cwd, "skills", "vendor", "mattpocock", name, "SKILL.md");
  if (existsSync(consumerPath)) return { name, path: consumerPath, source: "consumer" };

  return { name, source: "optional-unavailable" };
}

function selectedSkillText(cwd: string, names: readonly string[]): string {
  const chunks: string[] = [];
  for (const name of names.slice(0, 3)) {
    const resolved = resolveWorkerSkill(cwd, name);
    if (!resolved.path) {
      chunks.push(`${name} (optional skill unavailable; continue with bounded kernel instructions)`);
      continue;
    }
    chunks.push(`${name} [${resolved.source}]:\n${stripFrontmatter(readFileSync(resolved.path, "utf8")).slice(0, 4_000)}`);
  }
  return chunks.length ? `Selected worker methodology (non-authoritative):\n${chunks.join("\n\n")}` : "";
}

export function buildPiNextPrompt(
  cwd: string,
  args: string,
  extraInstructions?: string,
  dispatchInput: WorkerDispatchInput = {},
): string {
  const config = loadPiNextConfig(cwd);
  const role = dispatchInput.phase || "planning";
  const policy = createWorkerDispatch({
    ...dispatchInput,
    phase: role,
    modelPolicy: dispatchInput.modelPolicy ?? config.workerDispatch.models[role as keyof typeof config.workerDispatch.models],
    workflowPaths: dispatchInput.workflowPaths ?? workflowPaths(config.workflow),
  });
  const userArgs = args.trim() || "(no arguments)";
  const kernel = `${repositoryPolicyText(config)}\n${renderWorkerEnvelope(policy)}\n${WORK_LOG_INSTRUCTIONS}`;
  return [kernel, selectedSkillText(cwd, policy.skills), `User: ${userArgs}`, extraInstructions?.trim()]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAutoPrompt(input?: {
  candidateShortlist?: string;
  candidateSearchExhausted?: boolean;
  config?: PiNextConfig;
}): string {
  const policy = promptPolicy(input?.config);
  const shortlist = input?.candidateShortlist?.trim()
    ? `\n\nController candidate shortlist (bounded P0/P1/P2/P3 buckets; verify canonical priority, readiness, dependencies, comments, and semantic fit before selection):\n${input.candidateShortlist.trim()}`
    : input?.candidateSearchExhausted
      ? "\n\nController shortlist is intentionally empty after querying all autonomous priority buckets. If no PLAN.md exists, report that no actionable issue remains instead of rediscovering excluded issues."
      : "";

  const prompt = `Pi-next managed auto transition. ${policy.repositoryPolicy} The configured ${policy.authorityName} authority is the autonomous work backlog. Use the four pi_next_* tools and start with pi_next_inspect(action="state").

Route from live state and complete exactly one bounded workflow unit:
- Active PLAN.md with unchecked tasks: implement only the first unchecked task, run the narrowest relevant tests/checks, commit source changes with explicit paths, mark the task done, commit PLAN.md progress, and leave a clean handoff.
- Active PLAN.md with no unchecked tasks: act as a fresh adversarial final verifier. Re-fetch the live issue and authoritative comments/decisions before judging completion; compare them with PLAN.md and current code/tests; try to disprove each criterion and inspect non-happy/legacy paths. Never narrow, rewrite, or reinterpret a requirement merely because available evidence is weaker. A checked PLAN checkbox is not evidence. Call pi_next_check(action="verify", reviews=[...]) with concrete evidence for ordinary semantic criteria only; omit run:/grep: entries because the verifier evaluates them mechanically; external: criteria can never self-pass. For a FAIL review, set failureDisposition=repair only for a concrete defect in the selected/current slice; set failureDisposition=defer_issue only when an authoritative live GitHub issue/comment explicitly defers or separately owns that unmet remainder, and include the concrete authority reference; set failureDisposition=reconcile when authoritative requirements are contradictory or materially changed, again with the concrete authority reference. Missing disposition fails safe to REPAIR. Semantic FAIL always remains FAIL: FAIL_DISPOSITION=REPAIR may append only its concrete bounded repair; FAIL_DISPOSITION=DEFER_ISSUE must not invent a repair or archive—commit the FAIL VERIFY.md, then use pi_next_update(action="defer_plan", issueNumber=..., reason=...) to park the unresolved plan so the next auto invocation reapplies live priority; FAIL_DISPOSITION=RECONCILE means reconcile authority/PLAN before implementation rather than guessing a solution. EXTERNAL/UNPROVEN means do not archive and leave/defer the issue as appropriate.
- No PLAN.md: select the highest-priority actionable live work item (${policy.priorities.join("→")}), preferring the controller shortlist when provided; verify comments/dependencies/readiness, then create and commit PLAN.md only. PLAN tasks are cohesive implementation or bounded repair slices only—never add final verification, issue evidence/status update, archive, or handoff as a task. Avoid micro-task fragmentation: keep semantically related edits together and record rationale before creating an unusually large task list. Locally deferred items remain excluded only while their authoritative version has not changed; a later authority update makes them eligible for fresh reconciliation.
- Quality/dirty-boundary recovery is mandatory: if a required quality gate fails after semantic PASS, first determine whether the failure is introduced by the current issue or already present on the committed baseline. A confirmed baseline failure is repository work, not a reason to report \`failed\`: preserve semantic evidence, repair it in the current bounded task when appropriate, or use an existing/created owning GitHub issue and report defer_issue with concrete authority so auto can continue. Rerun the failed gate; never waive it.
- Before any lifecycle result, inspect pi_next_inspect(action="drift", scope="all") and classify every dirty path as current work, generated/ephemeral residue, clearly stale agent-owned residue, or ambiguous human/other-agent work. Safely remove only reproducible generated/stale agent-owned residue, commit legitimate work, and leave ambiguous changes untouched; after bounded cleanup attempts, use \`blocked\` with the concrete reason.
- Unsafe state or a blocker requiring human/global intervention: stop and report it rather than inventing work.

Efficiency and safety:
- Read only evidence needed for this transition; do not reread broad policy or unrelated files unless required by the live task.
- Run focused tests first. Use quality=quick when appropriate; do not run standard/full on every task. Final completion still requires explicit quality=full.
- pi_next_check may reuse current-fingerprint passing command evidence; do not force reruns solely to duplicate identical evidence.
- For P0, payments/funds flow, authorization/security, schema/data migration, privacy/legal, or major architecture work, inspect the domain-specific behavior/decision boundary explicitly; green type/lint/test/build alone is not semantic acceptance evidence.
- Commit only explicit intended paths through pi_next_git. Never broad-stage the worktree.
- Preserve clean staged/unstaged/untracked boundaries, drift checks, code fingerprints, live-issue authority fingerprints, and archive safeguards.
- Do not post a final GitHub evidence/status comment between semantic verification and archive: that would change the authority fingerprint. Archive the verified state first, then update GitHub with the actual result.
- Do not start a second issue or a second implementation task in this invocation.

Return a concise status and the durable progress made.${shortlist}`;
  return prompt.replaceAll("GitHub", policy.authorityName).replaceAll("AGENTS.md and the canonical docs it references are authoritative.", policy.repositoryPolicy);
}

export function buildLoopPrompt(input: {
  cwd?: string;
  mode: "auto" | "resume";
  runId: string;
  step: number;
  maxSteps: number;
  remainingIssues: number;
  hasPlan: boolean;
  candidateShortlist?: string;
  candidateSearchExhausted?: boolean;
  planFreshness?: string;
  /** Controller-authored recovery context; never infer recovery from prose. */
  recoveryReason?: string;
  /** A malformed owned PLAN gets a planning-only, bounded repair turn. */
  planRepair?: {
    issueNumber: number;
    errors: string[];
    attempt: number;
    maxAttempts: number;
  };
  dispatch?: WorkerDispatchPolicy;
}): string {
  const policy = promptPolicy(input.cwd ? loadPiNextConfig(input.cwd) : undefined);
  const selection = input.hasPlan
    ? "Resume only the live PLAN.md work item and perform the next durable transition."
    : input.candidateSearchExhausted
      ? "The controller successfully queried all autonomous priority buckets and found no remaining candidates after this run's completed/deferred exclusions. Do not rediscover excluded issues; report idle."
      : `No PLAN.md exists. Select the best actionable live work item from the controller shortlist when available, read that item and its comments, then create and commit PLAN.md only. PLAN tasks are cohesive implementation or bounded repair work only; final verification, issue updates, archive, and handoff are lifecycle steps after tasks are complete. Avoid dozens of micro-tasks that each require a fresh worker; preserve semantic boundaries and explain unusually fragmented plans. Priority order: ${policy.priorities.join("→")}.`;
  const shortlist = input.candidateShortlist?.trim()
    ? `Controller candidate shortlist (fresh for this no-plan transition; bounded P0/P1/P2/P3 buckets; verify canonical priority, readiness, dependencies, comments, and semantic fit before selection):\n${input.candidateShortlist.trim()}`
    : input.candidateSearchExhausted
      ? "Controller shortlist is intentionally empty for this run."
      : `Controller shortlist unavailable because ${policy.authorityName} preselection could not be completed; query the live authority according to configured priority policy.`;
  const freshness = input.planFreshness?.trim()
    ? `Active-plan GitHub freshness gate:\n${input.planFreshness.trim()}`
    : "";
  const dispatch = input.dispatch
    ? { ...input.dispatch, workflowPaths: input.dispatch.workflowPaths ?? workflowPaths(policy.workflow) }
    : undefined;
  const overlay = loopTuningOverlay(input.cwd);

  return [
    `${policy.repositoryPolicy} Pi-next unattended workflow step. The configured ${policy.authorityName} authority is the only autonomous backlog.`,
    dispatch ? renderWorkerEnvelope(dispatch) : "",
    "Use the four pi_next_* tools for workflow state, checks, explicit-path commits, and loop reporting. Start with pi_next_inspect(action=\"state\").",
    WORK_LOG_INSTRUCTIONS,
    selection,
    shortlist,
    freshness,
    input.recoveryReason?.trim()
      ? `AUTOMATIC RECOVERY: The prior worker exited without a loop_result. The controller preserved the same issue lease and worktree. Inspect and continue the existing issue work; do not reset, stash, discard, or switch issues. Recovery note: ${input.recoveryReason.trim()}`
      : "",
    input.planRepair
      ? `PLAN REPAIR MODE (attempt ${input.planRepair.attempt}/${input.planRepair.maxAttempts}) for issue #${input.planRepair.issueNumber}: the canonical owned PLAN is structurally valid but task metadata is incomplete. Repair only the configured PLAN path and related workflow evidence. Do not edit product source, tests, or requirements; preserve completed checkboxes, logs, dirty issue-local work, and every task/acceptance criterion. Inspect the repository and live authority as needed to supply exact Files and Approach values for every listed defect:\n${input.planRepair.errors.map((error) => `- ${error}`).join("\\n")}\nDo not implement any product task. Revalidate the complete PLAN, commit only the workflow repair with explicit paths, and report loop_result=continue. If the metadata cannot be determined safely, leave the PLAN unchanged and report a concrete bounded failure.`
      : "",
    overlay,
    tokenSafeStepInstructions(input),
  ]
    .filter(Boolean)
    .map((part) => part.replaceAll("GitHub", policy.authorityName).replaceAll("AGENTS.md and the canonical docs it references are authoritative.", policy.repositoryPolicy))
    .join("\n\n");
}

export function buildLoopMaintenancePrompt(
  cwd: string,
  input: {
    issueNumber: number;
    completedCount: number;
    reasons: string[];
    summary: string;
  },
): string {
  const config = loadPiNextConfig(cwd);
  const policy = promptPolicy(config);
  const overlayPath = configuredPath(cwd, policy.workflow.tuningPath);
  const diagnosticsDir = configuredPath(cwd, policy.workflow.diagnosticsPath);
  const resultPath = join(cwd, ".pi", "runtime", "pi-next-loop-maintenance-result.json");
  const dispatch = createWorkerDispatch({
    phase: "maintenance",
    issueNumber: input.issueNumber,
    workflowPaths: workflowPaths(config.workflow),
  });
  const methodology = selectedSkillText(cwd, dispatch.skills);
  const prompt = `Pi-next issue-boundary maintenance checkpoint after archived issue #${input.issueNumber} (completed issue ${input.completedCount} in this loop).

This is NOT product work. The repository is at a clean no-PLAN issue boundary and the next issue will run in a separate fresh parentless session.

${renderWorkerEnvelope(dispatch)}

Bounded telemetry trigger(s):
${input.reasons.map((reason) => `- ${reason}`).join("\n")}
Latest completed-issue telemetry: ${input.summary}

Perform an evidence-based, bounded Pi-next telemetry review using the selected methodology below:
1. Inspect the supplied bounded runtime loop/quality telemetry and only the minimum Pi implementation evidence needed. If optional consumer methodology is unavailable, report insufficient_evidence rather than reading an inferred repository path.
2. Apply the causal-attribution gate. Protected workload surfaces (issue requirements/comments, product code requirements, legitimate product tests/fixtures, active/deferred/archived issue plans) are read-only for performance tuning.
3. Most checkpoints should make NO behavioral change. Change something only when evidence supports a concrete Pi/workflow root cause and a measurable regression guard.
4. If a change is justified, apply at most ONE bounded corrective action. Prefer runtime-effective surfaces such as ${overlayPath}, configured prompt/skill guidance, configured helper scripts, telemetry, or focused Pi infrastructure tests. Keep LOOP_TUNING.md under 1,200 characters. A TypeScript extension change may be committed when necessary, but acknowledge it will only affect a subsequently reloaded extension; do not pretend loaded module code hot-reloaded.
5. Preserve context/session safety, live authority, explicit-path commits, clean boundaries, evidence-backed final verification/archive requirements, issue deferral semantics, and legitimate tests.
6. Record a concise correction in the configured tuning path when behavior changes. Run the narrowest relevant Pi infrastructure tests/checks and commit tuning separately with an explicit perf(agent): or chore(agent): commit.
7. Keep .pi/runtime/** and .pi/logs/** ephemeral and ignored. Never commit locks, loop state, raw telemetry caches, result files, prompts, transcripts, or logs.
8. Promote meaningful sanitized evidence to Git history under ${diagnosticsDir}. Create or update one concise JSON file named YYYY-MM-DD-issue-${input.issueNumber}.json (add a short suffix only if that name already represents a distinct earlier assessment). Include only the issue/run reference, trigger metrics/reasons, bounded assessment findings, action/commit, regression guard, and evaluation state. Never include chain-of-thought, full prompts, transcripts, secrets, or large raw logs.
9. Commit tracked diagnostic changes separately with explicit paths using a commit like chore(agent): record pi-next diagnostic #${input.issueNumber}. Then publish it immediately using the current branch's configured upstream (or origin/<current-branch>), a normal non-force push, fetch, and merge-base reachability verification. If publication or verification fails, stop with an explicit failure. Never force-push or change branches.
10. After remote verification succeeds, finish with a clean worktree and no PLAN.md. Do not select or start the next product issue.
11. Before your final response, write exactly one compact JSON object to ${resultPath}. This runtime result is transient controller input; the controller validates and removes it. Use the existing maintenance result schema with a concise summary, bounded evidence, action.commit set to the remote-verified diagnostic commit, and evaluateAfterIssues=3. Use action.changed=false when no Pi behavior changed; audit metadata is still placed in action.commit after verification.

Return only a concise maintenance result after the tracked diagnostic is committed, pushed, verified on the remote branch, and the runtime JSON file has been written.

${methodology}`;
  return prompt.replaceAll("GitHub", policy.authorityName).replaceAll("AGENTS.md and the canonical docs it references are authoritative.", policy.repositoryPolicy);
}

export function tokenSafeStepInstructions(input: {
  runId: string;
  step: number;
  maxSteps: number;
  remainingIssues: number;
  hasPlan: boolean;
}): string {
  return `UNATTENDED STEP ${input.step}/${input.maxSteps} | run=${input.runId} | issues_remaining=${input.remainingIssues}
Perform exactly one durable transition: plan creation/reconciliation/repair, one implementation task, final verification, archive, or blocker/no-work result.

Rules:
- Read only state needed for this transition. Do not start a second task or issue.
- Live GitHub is authoritative over PLAN.md. If the controller freshness gate says the active plan is changed/untrusted/unverified, fetch the live issue and comments before using the plan. If material requirements, decisions, readiness, dependencies, or scope changed, reconcile and commit PLAN.md (or defer/block stale work) and make that the durable transition. If the live recheck proves no material plan change is required, continue with the normal single task/lifecycle transition rather than creating a no-op reconciliation commit.
- Planning: keep ## Tasks limited to implementation or bounded repair work. Never add final verification, issue evidence/status updates, archive, or handoff as plan tasks; those are lifecycle transitions after tasks are checked. PLAN acceptance checkboxes are workflow state, not proof.
- Task transitions: run focused relevant tests first. Use quality=quick only when appropriate; do not run standard/full whole-repo gates per task unless the task specifically requires them.
- Final verification: this lifecycle boundary is an adversarial review, not implementation self-attestation. Re-fetch/read the live issue and decision comments; compare them to PLAN/current code; try to disprove every criterion; never weaken/rephrase requirements to fit the environment. Supply concrete structured reviews to pi_next_check(action=\"verify\") for ordinary semantic criteria only; omit run:/grep: entries because the verifier evaluates them mechanically. external: is always unresolved. For every FAIL review classify only the next route: failureDisposition=repair for a concrete current-slice implementation defect; failureDisposition=defer_issue only when an authoritative live GitHub issue/comment explicitly defers or separately owns the unmet remainder and provide authority; failureDisposition=reconcile for contradictory/materially changed authority and provide authority. Missing classification defaults to REPAIR. This routing never changes semantic FAIL into PASS.
- Route final semantic failure by pi_next_check's FAIL_DISPOSITION. REPAIR: append only the concrete bounded repair exposed by evidence. DEFER_ISSUE: do not append a repair or archive; commit the FAIL VERIFY.md so the step is durable, then report outcome=\"defer_issue\" with issueNumber and the authoritative reason—the controller parks PLAN.md and reselects from fresh live priority. RECONCILE: reconcile the live authority/PLAN and commit that reconciliation rather than guessing implementation. EXTERNAL/UNPROVEN: do not create a fake repair or mark it PASS; defer/leave the issue open as appropriate.
- Archive only while the live issue/comments fingerprint still matches VERIFY.md. Do not post the final GitHub issue evidence/status comment until after archive, because that comment itself changes the authority fingerprint.
- Commit all intended source/workflow changes through pi_next_git with explicit paths. Successful continue/done/archive transitions must advance durable Git state and finish clean with no continuation marker.
- If exactly one issue is blocked by credentials, production evidence, an external dependency, an explicitly deferred remainder, or a decision that does not prevent work on other issues, leave the repository clean and report outcome=\"defer_issue\" with that issueNumber and a concrete reason. Do not move/delete PLAN.md yourself; the controller parks a clean active plan deterministically.
- A required quality failure confirmed as pre-existing repository debt must never be reported as \`failed\` solely because it pre-existed. Record bounded repair evidence, route to the owning live issue (or a bounded repair task when no owner exists), rerun the gate, and continue/defer rather than terminating auto.
- Dirty boundaries require provenance inspection and bounded cleanup before terminal routing: generated or stale agent-owned residue may be safely removed, legitimate current work must be committed, and ambiguous human/other-agent changes must be protected. Use \`blocked\` only after those attempts fail or when a repository-wide, safety, workflow-state, or genuinely global human dependency means unattended work should stop rather than skip one issue.
- Before the final response call pi_next_update(action=\"loop_result\") exactly once with runId=\"${input.runId}\" and step=${input.step}.
- Outcomes: continue=plan/task remains; done=all tasks checked or verification completed and the next lifecycle transition is required; archived=archive committed and clean (include issueNumber); defer_issue=one clean skippable issue blocker or authoritatively deferred remainder (include issueNumber and reason); block_issue=one clean issue-local blocker to park without closing the issue (include issueNumber and reason); blocked=global/safety blocker; idle=no actionable issue; failed=unrecoverable tool/gate failure. Inability to close the current issue is not by itself a reason to stop the unattended loop: use defer_issue or block_issue at a clean boundary so the controller can refresh candidates and continue; reserve blocked for loop-global safety conditions.
- Finish with exactly one matching STATUS line and nothing after it: STATUS: CONTINUE | DONE | ARCHIVED | DEFERRED | BLOCKED | IDLE | FAILED.`;
}
