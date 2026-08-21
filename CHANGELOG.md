# Changelog

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
