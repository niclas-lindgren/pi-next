# PS-next context packet: verifier

Built mechanically from durable artifacts by ps-packet. No model
conversation was summarized to produce this. If something you need is
missing, read it from the referenced artifact — do not assume it was
covered by an earlier conversation you cannot see.

## Work item

- id: none
- workspace: /Users/niclasl/src/pi-next
- plan file: /Users/niclasl/src/pi-next/.ps-next/PLAN.md
- ps_dir: /Users/niclasl/src/pi-next/.ps-next

## Authoritative requirements

Source of truth for this work item (refreshed by ps-authority-refresh —
this supersedes the plan wherever the two disagree):

# Authoritative Work Item

- id: 1
- title: Lifecycle status/footer projection convergence — Make /pi-next auto's status and footer a faithful typed projection of the shared lifecycle scheduler's disposition (idle/completed/budget-yield/blocked) instead of collapsing states into "stopped".
- status: open
- priority: 
- updated_at: unknown
- dependencies: 
- source: local-markdown
- source_reference: 1

## Requirements

Lifecycle status/footer projection convergence — Make /pi-next auto's status and footer a faithful typed projection of the shared lifecycle scheduler's disposition (idle/completed/budget-yield/blocked) instead of collapsing states into "stopped".

(No separate description document supplied by the work source.)

## Project instructions (read these, they are not inlined)

- /Users/niclasl/src/pi-next/.ps-next/PROJECT.md

## Acceptance criteria (verbatim)

- [ ] The status footer output contains distinct lifecycle states (idle, completed, budget-yield, blocked, cancelled, failed) instead of collapsing them all into "stopped".
- [ ] Running /pi-next-loop stop against a live fresh scheduler run causes it to exit via the shared lifecycle scheduler's AbortSignal and report the exact boundary at which it stopped, not via ForegroundSupervisor.
- [ ] Running /pi-next-loop resume on unified-scheduler-produced state calls runProductionLifecycleScheduler or runSingleIssueLifecycle and does not re-enter ForegroundSupervisor; resume on unsupported legacy state fails with an explicit, actionable migration error instead of silently launching ForegroundSupervisor.
- [ ] After the migration, extensions/pi-next/foreground-supervisor.ts and loop-controller.ts's duplicate state machine are removed, and the codebase contains no remaining references to ForegroundSupervisor outside a bounded, explicitly rejected legacy-state error path.
- [ ] All new deterministic regression tests (scripted workers, fake authority, disposable git, deterministic clocks) pass, covering idle/completed/budget-yield/blocked reporting, stop/cancel boundaries, and legacy-state rejection, with zero LLM/model token consumption.

## Independence rule

Checked-off plan tasks are not evidence. Judge the authoritative
requirements above against the change set below. An implementation that
satisfies its own plan but misses an authoritative requirement fails.

## Change set

- range: e1890b8c3026e2b329e3b8b675c4f84bd1155b91..HEAD

b7aad1f chore(pi-next): remove dead code left by ForegroundSupervisor/loop-controller deletion
94288f4 chore(pi-next): backfill commit hash in PLAN.md log
ecb1b7a test(pi-next): add terminal-disposition and completed-scheduler coverage
49581d8 refactor(pi-next): delete ForegroundSupervisor and loop-controller.ts
d66d878 chore(release): v0.3.3
dc2e5fc diagnostics
7c6b3f9 Merge branch 'main' of https://github.com/niclas-lindgren/pi-next
b822d23 feat(pi-next): route resume through the shared scheduler or reject legacy state (issue #165)
a7f6732 chore(release): v0.3.2
7026e0a diagnostics
788a65e feat(pi-next): enforce stop-intent checks at scheduler boundaries (issue #165)
4ea5245 feat(pi-next): add in-process AbortController wiring for /pi-next-loop stop (issue #165)
d702453 fix(pi-next): resolve authoritative live run for fresh-scheduler runs (issue #166)
da2cc8c fix(pi-next): render distinct budget-yield phase and hide stale elapsed time on terminal runs (issue #166)
83b6a1f test: keep consumer RPC cwd coherent
93fc8a3 fix(pi-next): map scheduler disposition to real LoopStatus (issue #166)

 .../2026-08-25T16-47-28.525Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-22-13.489Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-27-02.803Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-34-27.574Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-39-51.407Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-46-56.615Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-52-07.154Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-55-32.868Z-69982a575fa4.json     |   58 +
 .../2026-08-25T19-59-30.703Z-69982a575fa4.json     |   58 +
 .pi-next/diagnostics/incidents/last.json           |    8 +-
 .ps-next-locator                                   |    1 +
 .ps-next/.continue-here.md                         |   16 +
 ...-25-converge-auto-loop-onto-the-shared-lifec.md |   87 +
 .ps-next/BACKLOG.md                                |   13 +
 .ps-next/PLAN.md                                   |  102 ++
 .ps-next/PROJECT.md                                |   27 +
 CHANGELOG.md                                       |   24 +
 extensions/pi-next/auto-progress.ts                |   17 +-
 extensions/pi-next/commands-recovery.ts            |  237 +--
 extensions/pi-next/commands.ts                     |   66 +-
 extensions/pi-next/foreground-supervisor.ts        |  538 ------
 extensions/pi-next/loop-controller.ts              | 1741 --------------------
 extensions/pi-next/loop-state.ts                   |    7 +-
 extensions/pi-next/loop-status.ts                  |    4 +-
 extensions/pi-next/loop.ts                         |  567 ++-----
 extensions/pi-next/production-lifecycle.ts         |   12 +-
 extensions/pi-next/run-cancellation.ts             |   58 +
 extensions/pi-next/supervisor-status.ts            |  189 +++
 extensions/pi-next/tools-check.ts                  |    2 +-
 package-lock.json                                  |    4 +-
 package.json                                       |    2 +-
 scripts/file-size-allowlist.json                   |    2 -
 src/lifecycle/scheduler.ts                         |   22 +-
 test/abandoned-recovery.test.ts                    |  283 +---
 test/auto-progress.test.ts                         |    9 -
 test/auto-status.test.ts                           |    2 +-
 test/consumer-smoke.test.ts                        |    5 +-
 test/convergence-persistence.test.ts               |  110 --
 test/host-memory.test.ts                           |  169 +-
 test/host-retention.test.ts                        |    9 -
 test/lifecycle-kernel-parity.test.ts               |   85 +
 test/lifecycle-scenarios.test.ts                   |   96 --
 test/loop-resume.test.ts                           |  164 ++
 test/loop-status.test.ts                           |   24 +
 test/plan-recovery-controller.test.ts              |  575 -------
 test/production-lifecycle.test.ts                  |   22 +
 test/run-cancellation.test.ts                      |   57 +
 test/worker-recovery.test.ts                       |  184 ---
 test/workflow-state-preflight.test.ts              |   17 +-
 49 files changed, 1610 insertions(+), 4469 deletions(-)

## Baseline state

- RECONCILED (supplied by the caller; do not re-check the repository yourself)

## Excluded

Deliberately not in this packet — request precisely what you need instead
of assuming it was withheld by accident:

- implementation-transcript
- plan-log-rationale
- planner-transcript
- other-work-items

