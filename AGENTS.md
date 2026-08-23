# Repository agent instructions

These instructions are mandatory for issue-oriented work in this repository.
Always process GitHub issues as a bounded, serial loop: implement one open issue,
land it safely, clean up its workspace, and then re-query the live issue queue
before selecting the next issue.

## Architectural invariants

- **One canonical issue identity.** An owned issue has exactly one canonical
  branch/workspace identity: `.worktrees/issue-N` on `agent/issue-N`. Planning,
  implementation, verification, checkpointing, recovery, lifecycle bookkeeping,
  and promotion preparation must not invent or require a second issue branch or
  workspace identity.
- **Authority and scheduling are separate.** Losing ownership of an active or
  resumed issue is fail-closed. Losing a race to claim a newly selected
  candidate is candidate-local: do not touch that issue, exclude it from the
  current selection pass as appropriate, and continue with other eligible work.
- **Persisted workflow state is recoverable state, never authority.** PLAN,
  VERIFY, runtime state, worktrees, branch names, timestamps, telemetry, and
  historical controller records cannot grant ownership. Live configured
  authority remains decisive at every mutable boundary.
- **Recovery preserves before repairing.** Never reset, stash, delete, rewrite,
  or silently replace dirty, unique, ambiguous, or unintegrated issue work.
  Repair or reconcile only after issue identity, ownership, and the canonical
  workspace are mechanically established.
- **Workflow-quality defects are not automatically ownership defects.** A
  canonically owned PLAN with repairable structure or task-metadata defects
  should receive bounded deterministic repair or planning-only replanning before
  containment. Foreign, conflicting, or ambiguous workflow identity remains
  fail-closed.
- **Optimization limits cannot prevent correctness.** Commit budgets,
  convergence budgets, context limits, checkpoint policies, and similar
  anti-churn controls may coalesce, yield, or delay work, but must not make a
  correctness-required authority reconciliation, recovery transition,
  verification transition, or terminal lifecycle transition impossible.
- **Persisted-state semantics require migration discipline.** Any change that
  starts interpreting already-persisted runtime, worktree, PLAN, lease,
  telemetry, journal, or budget state differently must include upgrade
  compatibility. New limits and counters must be baselined or migrated rather
  than applied retroactively to historical measurements unless that behavior is
  explicitly safe and tested.
- **The worker harness is not lifecycle authority.** Pi is the current/default
  worker adapter, not the identity of the kernel. Worker adapters may execute a
  bounded role in an already-authorized canonical workspace; they must not
  discover/claim work, grant ownership, choose another workspace, weaken live
  authority, promote/close work, or make model self-report authoritative. Keep
  Pi-specific session/process behavior below the worker-adapter boundary. See
  `docs/WORKER_ADAPTER.md` and `docs/WORKERS.md`.
- **Host-session lifetime and worker-context freshness are separate.** For the
  current Pi adapter, normal `/pi-next auto` execution keeps one stable parent
  Pi host session while fresh model context comes from isolated child worker
  processes and explicit durable state/authority rehydration. Do not generalize
  that Pi-specific mechanism into the kernel worker contract. Reserve Pi
  `ctx.newSession()` for genuine Pi/user lifecycle operations and use the
  replacement context afterward. See `docs/HOST_SESSION_LIFECYCLE.md`.
- **Reference-driven reliability before reinvention.** Before adding a
  non-trivial lifecycle, persistence, context, execution, evaluation, or
  recovery mechanism, inspect mature implementations of that narrow problem and
  record an `adopt`, `adapter`, or `reject` decision in
  `docs/EVALUATION_AND_RELIABILITY.md`. Reuse useful proven invariants without
  importing an unnecessary orchestration platform.
- **Independent grading.** Worker completion prose is never sufficient evidence
  that a task is correct. Real-worker evaluation must separate candidate
  generation from hidden/mechanical grading and lifecycle assertions.

## Required issue loop

1. **Discover live work.** Query GitHub immediately before selecting work (for
   example, `gh issue list --state open --limit 100`). Do not rely on a stale
   issue list, local PLAN files, or memory. Follow the repository's configured
   priority and readiness labels/states.
2. **Isolate the issue.** Refresh `main`, claim the issue through the configured
   authority, and work only in its canonical disposable worktree
   `.worktrees/issue-N` on `agent/issue-N`. Never implement issue work directly
   in the coordination checkout or on `main`.
3. **Plan, implement, and verify.** Read the issue and applicable repository
   policy, keep a durable issue plan, make the smallest complete change, and
   run the required typecheck/tests (plus issue-specific checks) before
   integration. A model's report or a checked plan is not completion evidence.
4. **Re-query before finalization.** Fetch the complete live issue again after
   implementation and verification, immediately before closing it. Compare the
   title, body, comments, labels/status, and other authority data with the
   snapshot used for verification. This check must happen even when the issue
   appeared unchanged during the worker run.
5. **Commit, merge, and push in that order.** Create a reviewable candidate
   commit on `agent/issue-N`. Use the guarded finalization path to re-check
   ownership, freshness, candidate identity, and authority state; merge it into
   `main` without rewriting history; push `main` to `origin`; and prove the
   candidate is reachable from `origin/main`. The finalization path must make
   one more fresh authority read after the push and immediately before closure.
   Never force-push. Do not close or mark the issue complete before the pushed
   integration and this final query are both proven.
6. **Close through authority.** After the pushed commit and final verification
   are current, close the GitHub issue (or use the configured authority's
   completion operation) and leave a useful closing comment when appropriate.
   If the pre-close query finds any addition or change—including a new comment,
   label, body/title edit, or status change—do not close. Reconcile the new
   requirements, update the implementation/plan, create and verify a new
   candidate, integrate it, and repeat the fresh query immediately before
   attempting closure again. If authority or verification changed, leave the
   issue open and preserve the recovery evidence instead of claiming success.
7. **Clean up only after integration.** Remove completed workflow artifacts and
   the local issue worktree/branch only after the worktree is clean, no active
   plan or verification artifact remains, and integration into `origin/main` is
   proven. Preserve the remote branch when it is useful for audit or recovery.
   Never delete dirty, unintegrated, foreign, or ambiguous workspaces.
8. **Reset the issue worker context, not the parent host lifecycle.** After
   every completed or explicitly deferred issue, release its lease and clean or
   preserve its workspace according to the cleanup rule above, then terminate
   the current isolated issue worker/context before selecting another issue.
   Start the next issue in a fresh bounded worker context and re-read the live
   issue and repository policy from scratch. Do not carry the prior issue's
   plan, transcript, assumptions, or authority snapshot into the next worker.
   For the Pi adapter, do not call `ctx.newSession()` merely to achieve this
   freshness; the `/pi-next auto` parent Pi host session should remain stable
   during ordinary progression. Another worker adapter may implement freshness
   differently while preserving the same kernel contract.
9. **Continue safely.** Re-query open GitHub issues after every completed,
   explicitly deferred, yielded, or safely contained issue and only after any
   required worker-context reset. Continue for issue-local failures that have
   been safely preserved/released, repairable-but-contained workflow defects,
   convergence yields, unavailable candidates, and fresh-owner conflicts that
   occur while claiming **newly selected candidates**. Such claim races are
   scheduler-local and must not terminate unrelated queue work. Stop globally
   for loss of ownership of the **active/resumed issue**, ambiguous authority,
   unsafe canonical-workspace identity, inability to preserve unique work,
   controller integrity failures, or unsafe verification/merge/push/finalizer
   state. At exhaustion, report what was completed, deferred, yielded, blocked,
   or skipped and leave `git status` clean.

Prefer `/pi-next auto` for this loop while Pi remains the configured/default
worker host. For manual operation or future worker adapters, use the same kernel
sequence and coordination/finalization tooling; do not replace its safety
checks with ad-hoc `git merge`, `git push --force`, issue closure, or workspace
deletion commands.

## Controller and recovery regression testing

A real lifecycle/controller/recovery bug is not considered fully fixed until its
outer-path ordering is captured as a deterministic scenario, replay fixture, or
property regression where technically feasible. Use the historical incident
corpus/index in `docs/HISTORICAL_INCIDENT_REGRESSIONS.md` and add sanitized
fixtures or equivalent linked outer-path tests as part of the bug-fix workflow.

Changes to scheduling, recovery, leases, PLAN handling, checkpoints,
convergence, lifecycle, worker supervision, adapter dispatch,
command/session orchestration, or persisted event/replay state must include a
regression through the **outermost production path that originally failed**.
Helper or unit tests are necessary but are not sufficient when a higher-level
preflight, supervisor, command wrapper, session boundary, adapter, or lifecycle
guard can bypass or contradict the helper.

Most protocol regressions should use a scripted worker rather than a real LLM.
Real-worker tests belong in the independent canary/evaluation layer after
protocol and Git integration tests pass. Use fault injection and historical
incident replay where the failure involved a partial transition or restart.

For a live reproducer, preserve the real ordering in at least one behavioral
regression. Examples include:

- `/pi-next auto` -> supervisor -> candidate claim -> canonical worktree ->
  workspace validation -> repair/recovery worker;
- shortlist -> concurrent foreign claim -> local lease CAS loses -> candidate
  skipped -> next candidate selected;
- restart -> abandoned-run discovery -> authority reconciliation -> canonical
  worktree resume;
- upgrade from prior persisted state -> new scheduler/budget semantics applied
  only after explicit baseline or migration;
- 20+ ordinary Pi worker/controller transitions -> fresh isolated child workers
  -> unchanged parent Pi host-session identity -> zero Pi-next-initiated
  `ctx.newSession()` calls;
- genuine external Pi host-session replacement -> old context rejected/stale ->
  replacement context rebound safely;
- the same provider-neutral dispatch executed by a scripted/non-Pi adapter ->
  identical kernel authority/workspace/finalization semantics;
- injected crash after push -> restart -> reachability/finalization/cleanup
  continues idempotently without duplicate unsafe side effects.

A fix is not complete merely because the new helper behaves correctly in
isolation while an earlier outer guard still rejects the same real execution
path.

## Repository checks

Before handing off any change, run:

```sh
npm run typecheck
npm test
```

Keep commits focused and update tests/documentation for behavior changes. Do
not expose credentials, tokens, prompts, transcripts, hidden reasoning, or
private issue data.
