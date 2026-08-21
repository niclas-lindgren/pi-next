# Changelog

## 0.2.63 - pending release

Restart recovery reliability release.

### Material changes

- Reactivate explicitly recoverable `restart_required` memory stops even when the prior step was already settled.
- Re-baseline current-process host memory before recovery and preserve the exact issue lease/worktree when pressure remains critical.
- Report truthful recovered, immediately re-stopped, blocked, and no-op recovery outcomes.

### Compatibility/configuration/schema

- Existing loop-state and lease contracts remain compatible; bounded historical memory samples are retained while recovery starts a fresh baseline.
- No new configuration is required.

### Breaking/behavior changes

- Generic operator-stopped runs are no longer automatically reactivated merely because they retain an issue lease.

### Security/safety

- Recovery remains authority-first and canonical-workspace-bound; no product/workflow files are reset, stashed, or auto-committed.
- Current critical host pressure re-stops the run before another worker/model turn and preserves recovery ownership.

### Upgrade guidance

- Restarted memory-pressure runs resume their preserved issue automatically when the new process is below the critical threshold.

## 0.2.62 - pending release

Bound auto-footer session handoff release.

### Material changes

- Preserve the exact bound `/pi-next auto` footer run across repeated host session replacements.
- Repaint replacement sessions immediately without weakening conservative ambiguous-run selection.
- Add repeated lifecycle regression coverage for session isolation and heartbeat-independent repaint.

### Compatibility/configuration/schema

- Existing loop state, lease, and footer status contracts remain compatible.
- No new configuration is required.

### Breaking/behavior changes

- Active bound auto status remains visible continuously across `ctx.newSession()` transitions.

### Security/safety

- Footer binding is presentation-only and never grants workflow authority or changes lease ownership.
- Session-file and run identity matching prevents one session from borrowing another session's status.

### Upgrade guidance

- No consumer action is required.

## 0.2.61 - pending release

Parent-host memory safety release.

### Material changes

- Record bounded, payload-free parent memory samples across supervisor, session, worker, and issue boundaries.
- Stop before a new worker under sustained heap pressure and preserve the active lease/worktree for restart recovery.
- Release the final live host-context bridge after the last supervisor settles and cap unterminated worker stream/parser state.

### Compatibility/configuration/schema

- Existing loop state remains compatible; memory health is optional and runtime samples remain outside workflow artifacts.
- Optional environment overrides are available for diagnostics: `PI_NEXT_HOST_MEMORY_HIGH_RATIO`, `PI_NEXT_HOST_MEMORY_CRITICAL_RATIO`, and `PI_NEXT_HOST_MEMORY_CRITICAL_STREAK`.

### Breaking/behavior changes

- Critical parent heap pressure settles the run as `stopped` with `restart_required` evidence instead of launching another worker.

### Security/safety

- Memory telemetry contains only numeric resource observations and bounded lifecycle identifiers; prompts, transcripts, and tool payloads are never persisted.
- Dirty issue work and authoritative recovery ownership are preserved across the pressure stop.

### Upgrade guidance

- Restart Pi and use normal abandoned-run recovery after a `restart_required` stop.

## 0.2.60 - pending release

Scheduler claim-race handling release.

### Material changes

- Treat fresh-owner races while claiming newly selected issues as bounded scheduler skips and continue with other eligible work.
- Preserve requested capacity and avoid worker/model turns for candidate-local ownership conflicts.

### Compatibility/configuration/schema

- Existing lease CAS, canonical worktree, and persisted loop-state contracts remain compatible.
- No new configuration is required.

### Breaking/behavior changes

- A fresh foreign lease no longer aborts an unattended queue run during normal candidate selection.

### Security/safety

- Foreign ownership remains authoritative and is never stolen or mutated.
- Persisted active-issue resume conflicts remain fail-closed.

### Upgrade guidance

- No consumer action is required.

## 0.2.59 - pending release

PLAN repair execution-boundary release.

### Material changes

- Allow the outer loop controller preflight to reach bounded planning-only repair for owned task metadata defects.
- Preserve pre-existing issue-local work across repair turns while rejecting product-source mutations from planning repair workers.

### Compatibility/configuration/schema

- Existing PLAN ownership, lease, canonical worktree, and workflow-path contracts remain unchanged.
- No new configuration is required.

### Breaking/behavior changes

- A correctly owned PLAN missing only task `Files:`/`Approach:` metadata is no longer contained by the outer preflight before repair can run.

### Security/safety

- Foreign, ambiguous, and otherwise malformed PLAN ownership remains fail-closed.
- Planning-only repair cannot add or rewrite product-source paths.

### Upgrade guidance

- No consumer action is required.

## 0.2.58 - pending release

Bounded PLAN repair recovery release.

### Material changes

- Persist pending PLAN-repair state transitions to the run-scoped loop state file before dispatching planning-only repair workers.
- Reset the bounded repair-attempt budget when the invalid PLAN fingerprint changes, while retaining the bound for an unchanged defect.

### Compatibility/configuration/schema

- Existing PLAN ownership, lease, worktree, workflow-path, and loop-state contracts remain unchanged.
- No new configuration is required.

### Breaking/behavior changes

- Owned task-metadata defects now receive a durable bounded planning repair attempt without inheriting attempts from a different defect fingerprint.

### Security/safety

- Foreign or ambiguous PLAN ownership remains fail-closed, and repair workers remain restricted to the planning role until metadata validates.

### Upgrade guidance

- No consumer action is required.

## 0.2.57 - pending release

Scheduler-only convergence yield persistence release.

### Material changes

- Persist post-baseline hard-budget yields to the run-scoped loop state file so genuine convergence exhaustion remains durable and non-destructive.
- Add a controller-path regression proving zero-worker scheduler accounting and preservation of issue workflow state.

### Compatibility/configuration/schema

- Existing convergence baselines, policy versions, loop-state compatibility, and configured workflow paths remain unchanged.
- No new configuration is required.

### Breaking/behavior changes

- Scheduler-only convergence yields now complete as run-local yielded state instead of attempting to rename a temporary file over the runtime directory.

### Security/safety

- Budget exhaustion continues to preserve the PLAN/worktree and does not mark the authoritative issue failed or blocked.

### Upgrade guidance

- No consumer action is required.

## 0.2.56 - pending release

Configured workflow dispatch release.

### Material changes

- Bind worker prompts and dispatch envelopes to exact configured PLAN/VERIFY/diagnostics contracts.
- Represent provider-backed state explicitly so workers do not invent uppercase STATE or DIAGNOSTICS files.

### Compatibility/configuration/schema

- Existing workflow configuration remains authoritative, including custom state-provider and diagnostics paths.
- No new configuration is required; helper-provider failures remain typed and fail closed.

### Breaking/behavior changes

- Normal Pi-next worker guidance no longer authorizes fallback probing of root, uppercase conventional, or other-harness workflow artifacts.

### Security/safety

- Pi-next and foreign harness workflow namespaces remain isolated; `.ps-next` state is never fallback authority.

### Upgrade guidance

- No consumer action is required.

## 0.2.55 - pending release

Streaming worker display release.

### Material changes

- Preserve visible whitespace and newlines across streamed assistant text deltas so live worker prose remains readable.
- Keep visible delta redaction, control-character handling, allowlisting, and bounded buffers intact.

### Compatibility/configuration/schema

- No configuration or schema changes.
- Completed assistant messages continue to replace live previews authoritatively.

### Breaking/behavior changes

- Stream fragments are no longer independently trimmed or whitespace-collapsed before display concatenation.

### Security/safety

- Thinking and tool-call deltas remain excluded; visible secrets, URLs, paths, and unsafe controls remain sanitized.

### Upgrade guidance

- No consumer action is required.

## 0.2.54 - pending release

Canonical checkpoint branch release.

### Material changes

- Keep checkpoint commits on the leased `agent/issue-N` branch instead of creating per-run `pi-next/issue-N/<run>` branches.
- Preserve run attribution through checkpoint metadata and lifecycle telemetry while keeping one issue workspace identity.

### Compatibility/configuration/schema

- Existing canonical lease, worktree, promotion, and explicit-path contracts remain unchanged.
- Legacy per-run branches are no longer selected by checkpoint recovery.

### Breaking/behavior changes

- Checkpointing from a canonical issue worktree no longer switches to a second branch namespace.

### Security/safety

- Foreign branches and coordination `main` remain fail-closed; checkpoint commits continue to stage only explicit paths.

### Upgrade guidance

- No consumer action is required.

## 0.2.53 - pending release

Bounded legacy worktree attribution release.

### Material changes

- Recover clean divergent legacy commits from canonical configured PLAN/VERIFY issue identity when commit subjects omit `#N`.
- Evaluate the complete divergent commit set before replay and report the attribution evidence for each commit.

### Compatibility/configuration/schema

- Existing lease, branch, and worktree identities remain unchanged.
- Attribution follows the configured workflow PLAN/VERIFY paths; no new configuration is required.

### Breaking/behavior changes

- Ambiguous, foreign, or mixed legacy history remains contained and is never partially salvaged.

### Security/safety

- Automatic adoption remains fail-closed and preserves the legacy checkout when ownership evidence is incomplete or conflicting.

### Upgrade guidance

- No consumer action is required.

## 0.2.52 - prepared release

Bounded PLAN recovery follow-up release.

### Material changes

- Ship bounded recovery for correctly owned canonical PLAN files missing task `Files:` and `Approach:` metadata.
- Preserve issue-local progress while planning-only repair revalidates workflow state before implementation.

### Compatibility/configuration/schema

- Loop-state v1 remains compatible; no new consumer configuration is required.
- Existing authority adapters and configured workflow paths remain authoritative.

### Breaking/behavior changes

- Owned task metadata defects receive bounded planning repair instead of immediate containment; foreign or ambiguous artifacts remain fail-closed.

### Security/safety

- Repair remains lease- and canonical-worktree-bound, preserves requirements and dirty work, and records bounded recovery telemetry.

### Upgrade guidance

- Upgrade promptly for the PLAN-recovery correctness fix; no manual migration is required.

## 0.2.51 - prepared release

Bounded PLAN recovery and workflow safety release.

### Material changes

- Repair correctly owned canonical PLAN task metadata through a bounded planning-only worker before containing an otherwise ready issue.
- Preserve completed task state, logs, dirty issue-local work, and live authority identity while recovering missing `Files:` and `Approach:` fields.

### Compatibility/configuration/schema

- Loop-state v1 remains compatible; optional bounded PLAN-repair state is ignored by older readers.
- No new consumer configuration is required; repair workers use the existing configured workflow paths and authority adapter.

### Breaking/behavior changes

- Missing task `Files:`/`Approach:` metadata no longer immediately makes an owned ready issue ineligible.
- Foreign, ambiguous, or otherwise unsafe PLAN ownership remains fail-closed, and repeated invalid repairs are contained after a bounded budget.

### Security/safety

- Planning repair runs only after canonical lease/worktree ownership and live-authority reconciliation; implementation workers never start while task metadata remains invalid.
- Repair telemetry is bounded and sanitized; no workspace reset, stash, deletion, or requirement narrowing is performed.

### Upgrade guidance

- Upgrade promptly for the PLAN-recovery correctness fix; no manual migration or configuration change is required.

## 0.2.50 - pending release

Convergence budget compatibility release.

### Material changes

- Establish explicit convergence policy baselines so historical issue telemetry is not charged against newly activated budgets.
- Preserve fairness yields while preventing zero-worker budget preflights from consuming global worker steps.
- Expose bounded token consumption, baseline, wall-time, transition, and policy details in loop status.

### Compatibility/configuration/schema

- Loop-state v1 remains compatible; optional convergence baseline fields migrate deterministically when absent or when the policy version changes.
- Default token thresholds are calibrated for several ordinary worker turns while remaining configurable.

### Breaking/behavior changes

- Convergence token, transition, and wall-time limits measure post-activation consumption rather than cumulative historical counters.
- A pure scheduler budget yield no longer advances the global worker/model step counter.

### Security/safety

- Baselines are explicit durable state and policy upgrades reset the activation epoch instead of guessing from timestamps.
- Budget yields remain non-destructive and run-local; PLAN/worktree state is preserved.

### Upgrade guidance

- Existing runs resume with a baseline established from their current telemetry; no manual migration is required.

## 0.2.49 - pending release

Stable scheduler/display lifecycle release.

### Material changes

- Keep one supervisor-owned worker display across issue-cycle boundaries and remove the misleading empty `worker alive` placeholder.
- Render scheduler/controller activity separately from actual child-worker lifecycle state.
- Classify convergence-budget yields distinctly from recovery retry exhaustion.

### Compatibility/configuration/schema

- No configuration or schema changes.
- Existing worker activity, recovery, and session replacement interfaces remain compatible.

### Breaking/behavior changes

- Empty scheduler transitions no longer paint or clear a worker widget, and convergence budget yields no longer appear as retry failures.

### Security/safety

- Worker liveness remains grounded in actual worker events/process state; controller activity is bounded and cannot create a fake worker row.
- Widget lifecycle remains session-safe and bounded across supervisor issue transitions.

### Upgrade guidance

- No consumer action is required; review the updated controller wording if terminal output is parsed by tooling.

## 0.2.48 - pending release

Worker liveness watchdog release.

### Material changes

- Add configurable soft/hard worker idle and wall-clock watchdogs with truthful activity telemetry.
- Bound process-group termination and preserve existing issue recovery state after a stall.

### Compatibility/configuration/schema

- Add optional `workerWatchdog` defaults and worker-role overrides with conservative compatibility defaults.
- Existing worker and controller abort behavior remains supported.

### Breaking/behavior changes

- Silent workers now surface suspected stalls and are terminated at bounded hard limits instead of occupying a controller indefinitely.

### Security/safety

- Watchdog diagnostics are bounded and issue/run scoped; termination uses SIGTERM, grace, then SIGKILL without resetting or stashing work.
- Explicit user/controller aborts remain distinct from watchdog timeouts.

### Upgrade guidance

- Review role-specific watchdog limits for providers or verification commands that legitimately remain silent for long periods.

## 0.2.47 - pending release

Per-issue convergence budget release.

### Material changes

- Add durable per-issue transition, worker, time, token, task, fingerprint, and commit convergence metrics.
- Add configurable soft checkpoints and hard fairness yields that preserve PLAN/worktree state.

### Compatibility/configuration/schema

- Add optional `convergence` configuration with soft/hard transition, wall-time, token, and PLAN task warning limits.
- Existing configuration remains compatible through conservative defaults.

### Breaking/behavior changes

- A single issue can now yield at a bounded run-local fairness boundary instead of monopolizing an unattended loop.

### Security/safety

- Budget exhaustion is scheduler yield only; it does not mark the authority issue blocked, deferred, failed, or closed.
- Existing run-wide step and ownership safety bounds remain in force.

### Upgrade guidance

- Review convergence limits for repositories with unusually large but cohesive issues; later runs resume preserved PLAN state.

## 0.2.46 - pending release

Live authority eligibility gate release.

### Material changes

- Reapply configured readiness, blocker, closed, deferred, and authority-availability policy before active PLAN transitions.
- Preserve issue PLAN/worktree state and yield safely when live authority becomes ineligible.

### Compatibility/configuration/schema

- Add controller-facing authority eligibility dispositions and a run-local yielded transition.
- Existing configuration remains compatible; readiness and blocker policy continue to be consumer-configured.

### Breaking/behavior changes

- Active plans no longer launch autonomous workers when live authority is blocked, closed, deferred, not ready, or unavailable.

### Security/safety

- Lease ownership cannot override a live authoritative stop condition; dirty issue work is preserved without destructive cleanup.

### Upgrade guidance

- Consumers should review configured readiness and blocker states before enabling unattended execution.

## 0.2.45 - pending release

Release-gate Git fixture portability release.

### Material changes

- Make temporary bare repositories advertise `main` and use explicit HEAD
  refspecs so the exact-tag gate is portable across Git runner defaults.
- Preserve exact-tag verification, authenticated authority checks, and the
  deterministic package smoke gate.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The supported Node.js 22.19+ and Pi 0.84.2+ compatibility range is unchanged.

### Breaking/behavior changes

- No runtime or consumer configuration behavior changes are intended.
- Test-only Git fixture setup is explicit about its default branch.

### Security/safety

- Exact release verification remains bound to the immutable tag commit.
- GitHub Actions uses its built-in read token and consumers remain pinned to
  immutable revisions.

### Upgrade guidance

- Consumers may wait for a later bundled runtime release. Review the release
  notes and run the documented immutable pin plus fresh-process checks when
  upgrading.

## 0.2.44 - 2026-08-21

Release-gate test cleanup reliability release.

### Material changes

- Keep finalize integration fixture cleanup at process exit so temporary bare
  remotes remain available for every hosted test case.
- Preserve exact-tag verification, authenticated authority checks, and the
  deterministic package smoke gate.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The supported Node.js 22.19+ and Pi 0.84.2+ compatibility range is unchanged.

### Breaking/behavior changes

- No runtime or consumer configuration behavior changes are intended.
- Test-only temporary-directory cleanup is deferred until the test process exits.

### Security/safety

- Exact release verification remains bound to the immutable tag commit.
- GitHub Actions uses its built-in read token and consumers remain pinned to
  immutable revisions.

### Upgrade guidance

- Consumers may wait for a later bundled runtime release. Review the release
  notes and run the documented immutable pin plus fresh-process checks when
  upgrading.

## 0.2.43 - 2026-08-21

Release-gate fixture cleanup release.

### Material changes

- Make finalize integration fixtures retain their temporary repositories until
  the suite completes, preventing cleanup races in the hosted release gate.
- Preserve exact-tag verification, authenticated authority checks, and the
  deterministic package smoke gate.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The supported Node.js 22.19+ and Pi 0.84.2+ compatibility range is unchanged.

### Breaking/behavior changes

- No runtime or consumer configuration behavior changes are intended.
- Only test fixture lifecycle and release evidence behavior changed.

### Security/safety

- Exact release verification remains bound to the immutable tag commit.
- GitHub Actions uses its built-in read token and consumers remain pinned to
  immutable revisions.

### Upgrade guidance

- Consumers may wait for a later bundled runtime release. Review the release
  notes and run the documented immutable pin plus fresh-process checks when
  upgrading.

## 0.2.42 - 2026-08-21

Release-gate fixture reliability release.

### Material changes

- Keep the exact-tag release gate green by serializing the finalize integration
  fixture suite and preserving deterministic temporary-repository cleanup.
- Retain authenticated GitHub CLI authority checks and no-remote fixture
  handling from the previous release-gate follow-up.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The supported Node.js 22.19+ and Pi 0.84.2+ compatibility range is unchanged.

### Breaking/behavior changes

- No runtime behavior or consumer configuration changes are intended.
- Test execution is more conservative to avoid nondeterministic fixture races.

### Security/safety

- The release workflow uses only its built-in read token and verifies the exact
  immutable tag commit.
- Pinned consumers and downstream ownership remain unchanged.

### Upgrade guidance

- This is verification infrastructure work. Consumers may wait for a later
  bundled runtime release; follow the documented immutable pin and smoke-test
  workflow when upgrading.

## 0.2.41 - 2026-08-21

Release-gate reliability follow-up.

### Material changes

- Make the hosted release gate authenticate GitHub CLI calls and run the
  temporary-repository test suite deterministically, including serializing the
  finalize integration fixture suite.
- Treat a local checkout without a GitHub remote as an ordinary absent lease
  during coordination status checks.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The supported Node.js 22.19+ and Pi 0.84.2+ compatibility range is unchanged.

### Breaking/behavior changes

- The default test scripts serialize test files, and the finalize integration
  fixture suite serializes its nested cases to avoid shared temporary cleanup
  races; runtime worker behavior is unchanged.

### Security/safety

- GitHub Actions receives only its built-in read token for authority-bound
  checks; no credential is stored in the repository.
- Release verification remains tied to an immutable tag commit and pinned
  consumers remain unchanged.

### Upgrade guidance

- This is release-gate reliability work. Consumers may wait for a later bundled
  runtime release; when upgrading, inspect notes and run pin plus fresh-process
  checks as documented.

## 0.2.40 - 2026-08-21

Release-evidence and consumer-release governance release.

### Material changes

- Add an exact-tag GitHub Actions release gate that repeats the authoritative
  typecheck, test suite, and fresh-consumer/package smoke checks.
- Make release preparation require bounded notes for both the shipped release
  and the next consumer-facing release.
- Document release batching, urgent-fix handling, and the deterministic
  downstream immutable-pin workflow.

### Compatibility/configuration/schema

- No Pi API, package/config schema, or authority contract changes are intended.
- The release workflow requires Node.js 22.19+ and the locked npm dependency
  tree, matching the supported development environment.

### Breaking/behavior changes

- Release preparation now fails before changing package.json or creating a tag
  when required release-note metadata is absent.
- No runtime worker or consumer configuration behavior changes.

### Security/safety

- Release verification is tied to the exact immutable tag commit and does not
  trust a moving branch.
- Pinned consumers remain responsible for reviewing notes and running their own
  fresh-process integration checks; no floating or automatic upgrade is added.

### Upgrade guidance

- This is a maintainer/release-process improvement. Consumers may wait for the
  next bundled runtime change, but should use the documented immutable
  pin-bump and fresh-process checks for every upgrade.

## 0.2.39 - 2026-08-21

Bounded consumer release covering the compatible 0.2.x work since 0.1.5.

### Material changes

- Added issue-queue status and self-assessment visibility for operators.
- Hardened worker, recovery, state-provider, and lifecycle behavior across the
  0.2.x maintenance releases.
- Added pending-verification handling and stronger authority/finalization
  fences for issue completion.

### Compatibility/configuration/schema

- Pi 0.84.2+ and Node.js 22.19+ remain supported.
- Configuration and authority contracts remain version 1; no package install
  or consumer pin format change is required.

### Breaking/behavior changes

- Minor pre-1.0 behavior changes are documented in the individual commits and
  should be reviewed before upgrading; no intentional breaking schema change
  is included in this bounded release.

### Security/safety

- Ownership, freshness, worktree recovery, and terminal completion remain
  fail-closed; consumers continue to install immutable revisions.

### Upgrade guidance

- Consumers should upgrade when they want the bundled 0.2.x fixes, inspect
  compatibility notes, then run their integration and fresh-process checks.
  Non-urgent consumers may wait for a later bundled release.

## 0.1.5 - 2026-08-20

Operational issue-boundary learning release.

- Feed complexity-normalized peer metrics into live maintenance decisions and
  enforce a maintenance-overhead budget.
- Prevent stacked tuning after inconclusive evaluations and automatically roll
  back known reversible tuning overlays after measured regressions.
- Persist held corrective findings for non-reversible or failed rollbacks, with
  behavioral coverage for normalized outliers and evaluation gating.

## 0.1.4 - 2026-08-20

Self-assessment governance conformance release.

- Derive finding publication, held, approval, rejection, and supersession states
  from the configured authority policy.
- Verify newly published findings are held before treating publication as
  successful, and suppress duplicate recurrence comments.
- Add regression coverage proving custom-label findings remain held until
  explicitly approved.

## 0.1.3 - 2026-08-19

Package-owned terminal archive release.

- Removed the hidden `pi-next-archive.sh` consumer-helper dependency.
- Archive/final bookkeeping now uses configured state/archive paths directly in
  package-owned TypeScript and remains recoverable after a failed archive step.
- Added fresh-consumer archive regression coverage with no legacy helper files.

## 0.1.2 - 2026-08-19

Fresh-host migration gate completion release.

- Integrated bounded adversarial review into high-risk semantic verification;
  configured candidates are reviewed by independent read-only Pi workers before
  final verification and concrete findings block until a new candidate exists.
- Wired typed worker/controller/crash failures through a bounded runtime
  reporter and local sanitized JSONL sink with recurrence escalation and
  deduplication.
- Added actual fresh Pi RPC-host consumer coverage for command registration,
  doctor/status, package-origin activation, exact revision reporting, and the
  disposable memory-adapter lease/worktree transition.

## 0.1.1 - 2026-08-19

Migration-ready pinned package release.

- Added bounded, independent adversarial review execution for configured
  high-risk work, with read-only reviewer contexts, exact candidate/authority
  binding, repair invalidation, and a maximum of two rounds.
- Hardened structured runtime feedback with versioned sanitized error shapes,
  path/URL/credential redaction, stable fingerprints, bounded recurrence,
  deduplicated sink escalation, pending state, and recursion containment.
- Added the versioned fresh-consumer fixture and disposable end-to-end smoke
  test covering exact Git package installation, fresh package activation,
  discovery, claim/worktree, checkpoint/recovery, completion, and remote
  isolation.
- Documented v0.1.1 compatibility (Pi 0.84.2+, Node 22.19+), package/config
  schema version 1, immutable installation, migration, and pre-1.0 limits.

Known limitations: Pi-next is not an OS sandbox; workers retain the host's
shell/file/Git permissions. The GitHub adapter and credentials remain
consumer-owned, and the deterministic consumer smoke uses an in-memory fake.

## 0.1.0 - 2026-08-19

- Add deterministic worker-role dispatch with selective skills, capability
  profiles, candidate/authority binding, provider-neutral model routing, and
  bounded role metadata in worker telemetry.
- Bound bookkeeping commits across workflow and lifecycle paths, defensively
  classify explicit commit contents, and add sanitized recurring runtime
  feedback primitives with optional consumer sinks.

All notable changes to pi-next are documented here. The project is pre-1.0;
minor releases may change public behavior and breaking changes are called out.

- Added the pinned, allowlisted Matt Pocock engineering skill packs with a
  deterministic non-interactive sync/check CLI, SHA-256 provenance, preserved
  MIT license, companion-file validation, and an explicit local trust-boundary
  overlay (#7).
- Ported the guarded terminal-completion primitive (`finalize`) and the
  `status`/`claim`/`renew`/`release`/`workspace`/`prepare`/`finalize` JSON
  coordination CLI from a consumer's local copy (#19). `finalize`'s
  close/comment step goes through the `WorkAuthorityAdapter` boundary
  instead of being hardcoded to GitHub.
- Fixed a terminal-safety defect where a `finalize` retry with nothing new
  to integrate could close on a live main tree that was never actually
  reverified (#20). Retrying after a `requiresReverification: true` result
  now requires the caller to pass back that result's `mergeSha` as
  `verifiedIntegratedMain`; a mismatch (another commit landed since)
  returns `requiresReverification: true` again instead of closing.
- Added public quick-start, command, architecture, recovery, and security
  documentation.
- Added `/pi-next-doctor` for package/configuration/workflow diagnostics.
- Added contribution, support, and threat-model guidance.

The release is tested with Pi 0.84.2+ and Node 22.19+. It is experimental;
consumers must pin this tag and review the host-permission threat model.

Configuration and authority contracts are version 1. Migration from copied
extensions requires removing the copy and installing the native package.
