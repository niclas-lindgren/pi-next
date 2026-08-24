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
| 8 | Authority changes after implementation before closure | `historical: authority changes after implementation before closure`; also finalization tests and `test/checkpoint.test.ts` controller finalization-request provenance regressions | Pre-close authority changes prevent stale closure. |
| 9 | Workflow-only/commit-budget limit collides with finalization | `historical: workflow-only commit budget cannot block finalization`; also `test/workflow-commit-policy.test.ts` | Optimization budgets cannot block correctness-required terminal transitions. |
| 10 | Candidate reaches main but external verification pending | `historical: completed candidate on main while external verification pending`; also crash-boundary replay | Main reachability is not external verification success. |
| 11 | Blocked/deferred issue stops loop despite other eligible work | `historical: blocked issue does not stop loop when eligible work remains`; also auto-progress/scheduler tests | Blocked/deferred disposition is issue-local, not a global stop when work remains. |
| 12 | Invalid consumer integration discovered after expensive worker launch | `historical: invalid consumer integration fails before worker launch`; also workflow-state preflight tests | Static preflight failures launch no expensive worker. |
| 13 | Crash after push before cleanup/final disposition | `historical: crash after push before cleanup and final disposition`; also `test/fixtures/replay/crash-boundaries.json` | Restart proves reachability and must not push/merge again. |
| 14 | Stale worker tries to close after authority/ownership changed | `historical: stale worker cannot close after authority owner changed`; also finalizer/authority tests | Stale worker output cannot close or mutate after ownership/current-authority mismatch. |
| 15 | Bootstrap finalizer collapsed nested untracked candidate directories to unknown paths (#141/#81) | `test/bootstrap-finalize.test.ts` (`#81 bootstrap path shape finalizes without untracked directory placeholders`) | Verification handoff and finalization use the same file-level candidate path identity; unrelated paths still fail closed. |
| 16 | Campsty #647 visible worker/controller/footer identity divergence (#146) | `test/lifecycle-kernel-parity.test.ts` (`canonical projection prevents Campsty #647-style footer/worker contradiction`) and `test/production-lifecycle.test.ts` (`production footer/status projects the current unified lifecycle run, not stale historical state`) | Worker/controller/footer projections come from one active issue/run/phase state; stale historical runs cannot report another issue as current while a worker is live. |
| 17 | Completed implementation worker produced zero candidate delta while checks passed for unchanged repo (#146/#149) | `test/bootstrap-self-host.test.ts` (`worker no-op with passing checks launches one fresh bounded implementation retry, then exhausts cleanly`; `zero-delta implementation retry that produces a candidate verifies through the normal path`) | A zero-delta unproven completed implementation spends exactly one fresh implementation retry instead of requiring a second operator command, without treating unchanged checks as satisfaction proof. |
| 18 | Stale durable verified-candidate proof conflicted with a newer live candidate (#146/#156) | `test/bootstrap-finalize.test.ts` (`stale integrated proof cannot override newer clean committed live candidate`; `stale proof with newer dirty live candidate blocks without deleting or resetting work`) and `test/lifecycle-kernel-parity.test.ts` | Historical proof is exact-candidate evidence only; a newer canonical live candidate takes precedence when clean and blocks safely when dirty, without a repeated `CANDIDATE_STALE` loop. |
| 19 | Dirty baseline branch was mistaken for an integrated candidate after origin/main advanced (#157/#158) | `historical: dirty baseline branch was mistaken for integrated candidate`; also `test/bootstrap-finalize.test.ts` (`advanced main cannot make a dirty baseline HEAD look integrated (#157 incident shape)`) and `test/lifecycle-kernel-parity.test.ts` | Raw ancestry of the branch HEAD is never completion evidence while dirty/staged/untracked candidate work exists; the exact dirty candidate is committed/verified or safely blocked before closure/cleanup. |
| 20 | Already-integrated candidate on advanced main bypassed required exact-main reverification (#157) | `test/bootstrap-finalize.test.ts` (`#157 regression: already integrated candidate is reverified against current main before closure`; `post-integration recovery rechecks the merge commit produced after concurrent main advance`; `post-integration reverification repeats within bound when main advances during checks`; `failed post-integration required check keeps issue open and preserves integrated candidate`; `durable exact integrated-main proof resumes without rerunning post-integration checks`) and `test/checkpoint.test.ts` (`production promotion recovery runs required post-integration checks before closing an already integrated candidate`) | Candidate reachability/integration is not exact-main verification evidence; closure waits for bounded mechanical checks on the still-current integrated main SHA. |
| 21 | Bootstrap self-host selector rejected completed dependencies absent from the development roadmap (#132; historical #108/#113/#114 shape) | `test/bootstrap-self-host.test.ts` (`historical #108 regression permits completed #113/#114 follow-up dependencies outside #73 roadmap`; `--next-only uses out-of-roadmap dependency authority without lifecycle mutation or model calls`) | Development roadmap membership controls what may be selected, while live authority for referenced dependencies controls readiness; completed out-of-roadmap dependencies satisfy candidates without being queued. |
| 22 | Pi worker prompt resolved in under one second with 0 tools, 0 tokens, no changes, and no successful terminal model result (#151; #145/#132 self-host shape) | `test/bootstrap-self-host.test.ts` (`#145/#132 regression: a resolved prompt with zero tools/tokens and no terminal model result is not misclassified as completed`); `test/worker-adapter-bridge.test.ts`; `test/worker-terminal-result.test.ts` | Resolved worker transport is not completion evidence; missing/error terminal model results become typed worker execution failures and do not enter the normal zero-delta retry path. |

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
