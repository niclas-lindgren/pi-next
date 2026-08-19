import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { configuredPath, loadPiNextConfig, repositoryPolicyText, type PiNextConfig } from "../../src/coordination/config.ts";

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

function loopTuningOverlay(cwd?: string): string {
  if (!cwd) return "";
  const config = loadPiNextConfig(cwd);
  const path = configuredPath(cwd, config.workflow.tuningPath);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8").trim();
  if (!text) return "";
  return `Runtime loop tuning overlay (bounded; subordinate to AGENTS.md/canonical policy):\n${text.slice(0, 2_000)}`;
}

export function buildPiNextPrompt(
  cwd: string,
  args: string,
  extraInstructions?: string,
): string {
  const config = loadPiNextConfig(cwd);
  const skillPath = configuredPath(cwd, config.workflow.skillPath);
  const skill = existsSync(skillPath)
    ? stripFrontmatter(readFileSync(skillPath, "utf8"))
    : "# pi-next\nFollow the repository pi-next workflow.";
  const userArgs = args.trim() || "(no arguments)";
  return [skill, WORK_LOG_INSTRUCTIONS, `User: ${userArgs}`, extraInstructions?.trim()]
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
- No PLAN.md: select the highest-priority actionable live work item (${policy.priorities.join("→")}), preferring the controller shortlist when provided; verify comments/dependencies/readiness, then create and commit PLAN.md only. PLAN tasks are implementation or bounded repair work only—never add final verification, issue evidence/status update, archive, or handoff as a task. Locally deferred items remain excluded only while their authoritative version has not changed; a later authority update makes them eligible for fresh reconciliation.
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
}): string {
  const policy = promptPolicy(input.cwd ? loadPiNextConfig(input.cwd) : undefined);
  const selection = input.hasPlan
    ? "Resume only the live PLAN.md work item and perform the next durable transition."
    : input.candidateSearchExhausted
      ? "The controller successfully queried all autonomous priority buckets and found no remaining candidates after this run's completed/deferred exclusions. Do not rediscover excluded issues; report idle."
      : `No PLAN.md exists. Select the best actionable live work item from the controller shortlist when available, read that item and its comments, then create and commit PLAN.md only. PLAN tasks are implementation or bounded repair work only; final verification, issue updates, archive, and handoff are lifecycle steps after tasks are complete. Priority order: ${policy.priorities.join("→")}.`;
  const shortlist = input.candidateShortlist?.trim()
    ? `Controller candidate shortlist (fresh for this no-plan transition; bounded P0/P1/P2/P3 buckets; verify canonical priority, readiness, dependencies, comments, and semantic fit before selection):\n${input.candidateShortlist.trim()}`
    : input.candidateSearchExhausted
      ? "Controller shortlist is intentionally empty for this run."
      : `Controller shortlist unavailable because ${policy.authorityName} preselection could not be completed; query the live authority according to configured priority policy.`;
  const freshness = input.planFreshness?.trim()
    ? `Active-plan GitHub freshness gate:\n${input.planFreshness.trim()}`
    : "";
  const overlay = loopTuningOverlay(input.cwd);

  return [
    `${policy.repositoryPolicy} Pi-next unattended workflow step. The configured ${policy.authorityName} authority is the only autonomous backlog.`,
    "Use the four pi_next_* tools for workflow state, checks, explicit-path commits, and loop reporting. Start with pi_next_inspect(action=\"state\").",
    WORK_LOG_INSTRUCTIONS,
    selection,
    shortlist,
    freshness,
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
  const policy = promptPolicy(loadPiNextConfig(cwd));
  const overlayPath = configuredPath(cwd, policy.workflow.tuningPath);
  const resultPath = join(cwd, ".pi", "runtime", "pi-next-loop-maintenance-result.json");
  const diagnosticsDir = join(cwd, ".agents", "diagnostics", "pi-next", "assessments");
  const prompt = `Pi-next issue-boundary maintenance checkpoint after archived issue #${input.issueNumber} (completed issue ${input.completedCount} in this loop).

This is NOT product work. The repository is at a clean no-PLAN issue boundary and the next issue will run in a separate fresh parentless session.

Bounded telemetry trigger(s):
${input.reasons.map((reason) => `- ${reason}`).join("\n")}
Latest completed-issue telemetry: ${input.summary}

Perform an evidence-based Pi performance/tuning review:
1. Read .agents/skills/pi-performance/SKILL.md, its SNAPSHOT/TUNING evidence when relevant, bounded .pi/runtime loop/quality telemetry, and only the minimum Pi implementation evidence needed.
2. Apply the causal-attribution gate. Protected workload surfaces (GitHub issue requirements/comments, product code requirements, legitimate product tests/fixtures, active/deferred/archived issue plans) are read-only for performance tuning.
3. Most checkpoints should make NO behavioral change. Change something only when evidence supports a concrete Pi/workflow root cause and a measurable regression guard.
4. If a change is justified, apply at most ONE bounded corrective action. Prefer runtime-effective surfaces such as ${overlayPath}, prompt/skill guidance loaded from disk, helper scripts, telemetry, or focused Pi infrastructure tests. Keep LOOP_TUNING.md under 1,200 characters. A TypeScript extension change may be committed when necessary, but acknowledge it will only affect a subsequently reloaded extension; do not pretend loaded module code hot-reloaded.
5. Preserve context/session safety, live-GitHub authority, explicit-path commits, clean boundaries, evidence-backed final verification/archive requirements, issue deferral semantics, and legitimate tests.
6. Record an accepted/superseded/disproven correction in .agents/skills/pi-performance/TUNING.md when behavior changes. Run the narrowest relevant Pi infrastructure tests/checks. Commit tuning separately with an explicit perf(agent): or chore(agent): commit.
7. Keep .pi/runtime/** and .pi/logs/** ephemeral and ignored. Never commit locks, loop state, raw telemetry caches, result files, prompts, transcripts, or logs.
8. Promote meaningful sanitized evidence to Git history under ${diagnosticsDir}. A meaningful event is: this anomaly-triggered review, any tuning proposed/applied/rejected/rolled back, or an evaluation of a previous tuning. Create or update one concise JSON file named YYYY-MM-DD-issue-${input.issueNumber}.json (add a short suffix only if that name already represents a distinct earlier assessment). The tracked diagnostic should contain only: issue/run reference, trigger metrics/reasons, structured assessment conclusion/root causes/evidence/confidence, action and commit if any, regression guard, and evaluation state/horizon/results when available. Never include chain-of-thought, full prompts, transcripts, secrets, or large raw logs. If an older tracked diagnostic has a pending evaluation and bounded current evidence is sufficient to resolve it, update that diagnostic in this checkpoint.
9. Commit tracked diagnostic changes separately with explicit paths using a commit like chore(agent): record pi-next diagnostic #${input.issueNumber}. The diagnostic commit is maintenance metadata, not product work. Then publish it immediately: determine the current branch and configured upstream (prefer the existing upstream; otherwise use origin/<current-branch>), push the current branch with a normal non-force push, fetch/update that remote ref, and verify the diagnostic commit is reachable from the remote branch (for example with git merge-base --is-ancestor <diagnostic-commit> <remote>/<branch>). Do not report the checkpoint complete while the diagnostic exists only in local Git history. If push or remote-reachability verification fails, stop maintenance with an explicit failure instead of continuing to the next product issue. Never force-push or change branches during this publication step.
10. After remote verification succeeds, finish with a clean worktree and no PLAN.md. Do not select or start the next product issue.
11. Before your final response, write exactly one compact JSON object to ${resultPath}. This runtime result is transient controller input; the controller will validate/bound it and remove it. Use this schema:
{
  "status": "healthy_no_change | insufficient_evidence | change_applied | change_requires_reload | change_rejected_by_regression_guard | previous_tuning_rolled_back",
  "summary": "short conclusion",
  "rootCauses": ["bounded causal findings"],
  "evidence": ["bounded concrete observations/metrics, including remote publication verification"],
  "confidence": "low | medium | high",
  "action": {
    "changed": true,
    "files": ["paths actually changed"],
    "commit": "remote-verified diagnostic commit sha",
    "description": "what changed or why no change was made; state that diagnostic publication was verified",
    "expectedEffect": "measurable next-run expectation"
  },
  "regressionGuard": {
    "protected": ["workload/correctness surfaces protected"],
    "successCriteria": ["measurable criteria for retaining the change"]
  },
  "evaluateAfterIssues": 3
}
Use action.changed=false when no Pi behavior changed; the diagnostic commit itself is audit metadata and should still be placed in action.commit after remote verification. Keep every string concise and every array small. The controller validates/bounds this result and will later compare subsequent completed-issue telemetry against the triggering issue; that directional comparison is an audit signal, not proof of causality.

Return only a concise maintenance result after the tracked diagnostic is committed, pushed, verified on the remote branch, and the runtime JSON file has been written.`;
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
