# Historical incident regression corpus

Pi-next keeps a small sanitized corpus of real lifecycle/controller/recovery failures so a bug is expensive once. The principle follows SWE-bench's reproducible-fixture/gold-grading pattern: preserve enough normalized state to replay and grade behavior independently, without preserving the model conversation that originally exposed the problem.

## How to run

No LLM/provider credentials and no hosted Git mutation are required:

```sh
npm run eval:replay -- test/fixtures/replay/historical-incidents.json
npm test -- test/lifecycle-replay.test.ts
```

Replay failures include the stable fixture `name` (for example, `historical: missing loop_result requires safe reconciliation`) so a broken invariant points back to the incident.

## Corpus index

Fixture file: [`test/fixtures/replay/historical-incidents.json`](../test/fixtures/replay/historical-incidents.json).

| # | Historical regression | Fixture or equivalent regression | Previously failed invariant |
| --- | --- | --- | --- |
| 1 | Session ended without required `loop_result` | `historical: missing loop_result requires safe reconciliation`; also `test/worker-recovery.test.ts` | Missing worker result is reconciled, never accepted as success. |
| 2 | Worker exits code 1 with insufficient diagnostics | `historical: worker exit code 1 keeps bounded diagnostics`; also `test/worker-failure.test.ts` | Non-zero exit is classified with bounded diagnostics. |
| 3 | Stale/fresh `controller.lock` recovery | `historical: stale controller.lock is recovered but fresh lock fails closed`; also `test/bootstrap-lifecycle-lock.test.ts`, `test/loop-status.test.ts` | Stale lock can be recovered; fresh/ambiguous owner is not stolen. |
| 4 | Two harnesses select/claim same issue race | `historical: two harnesses racing same issue loses claim locally`; also `test/lifecycle-scenarios.test.ts`, `test/scheduler-claim-race.test.ts` | Claim loser creates no second owner and scheduling can continue. |
| 5 | Issue already leased by fresh owner | `historical: issue already leased by fresh owner is skipped`; also `test/candidate-discovery-bounds.test.ts` | Fresh foreign ownership is a candidate-local skip. |
| 6 | Canonical worktree takeover after prior agent parks/releases | `historical: canonical worktree takeover after prior agent parked release`; also workspace recovery tests | Takeover requires live ownership plus canonical `.worktrees/issue-N`; preserved work is not discarded. |
| 7 | PLAN/local summary narrower than authority/comments | `historical: PLAN summary narrower than current authority`; also plan recovery tests | PLAN is evidence, not authority; live authority widening must be reconciled. |
| 8 | Authority changes after implementation before closure | `historical: authority changes after implementation before closure`; also finalization tests | Pre-close authority changes prevent stale closure. |
| 9 | Workflow-only/commit-budget limit collides with finalization | `historical: workflow-only commit budget cannot block finalization`; also `test/workflow-commit-policy.test.ts` | Optimization budgets cannot block correctness-required terminal transitions. |
| 10 | Candidate reaches main but external verification pending | `historical: completed candidate on main while external verification pending`; also crash-boundary replay | Main reachability is not external verification success. |
| 11 | Blocked/deferred issue stops loop despite other eligible work | `historical: blocked issue does not stop loop when eligible work remains`; also auto-progress/scheduler tests | Blocked/deferred disposition is issue-local, not a global stop when work remains. |
| 12 | Invalid consumer integration discovered after expensive worker launch | `historical: invalid consumer integration fails before worker launch`; also workflow-state preflight tests | Static preflight failures launch no expensive worker. |
| 13 | Crash after push before cleanup/final disposition | `historical: crash after push before cleanup and final disposition`; also `test/fixtures/replay/crash-boundaries.json` | Restart proves reachability and must not push/merge again. |
| 14 | Stale worker tries to close after authority/ownership changed | `historical: stale worker cannot close after authority owner changed`; also finalizer/authority tests | Stale worker output cannot close or mutate after ownership/current-authority mismatch. |

## Fixture policy

A fixture may contain only bounded, sanitized facts needed to reconstruct protocol state:

- normalized authority/work-item state;
- canonical branch/worktree, PLAN/runtime/journal state;
- scripted worker result when relevant;
- lifecycle/fault ordering;
- expected final invariant and safe next action;
- stable incident name plus short provenance note.

Do **not** store private prompts, hidden reasoning, credentials, raw user issue bodies/comments that are not required, huge terminal transcripts, provider output, or hosted remote mutation details.

## Adding a new incident

1. Reproduce the outermost path that failed where technically feasible (supervisor, scheduler, recovery, finalizer, adapter boundary, etc.).
2. Add a minimized replay case to `test/fixtures/replay/historical-incidents.json`, or link an existing deterministic outer-path test in this index if it is already equivalent.
3. Include:
   - `name`: `historical: <stable incident name>`;
   - `provenance`: one sanitized sentence about where the failure shape came from;
   - `invariant`: the rule that previously failed;
   - bounded journal `events`, `observed` facts, and `expect`ed safe action.
4. Run `npm run eval:replay -- test/fixtures/replay/historical-incidents.json`, `npm run typecheck`, and `npm test` as appropriate.

Template: [`test/fixtures/replay/TEMPLATE.historical-incident.json`](../test/fixtures/replay/TEMPLATE.historical-incident.json).

Maintenance rule: a real lifecycle/controller/recovery bug is not considered fully fixed until its outer-path ordering is captured as a deterministic scenario/replay/property regression where technically feasible.
