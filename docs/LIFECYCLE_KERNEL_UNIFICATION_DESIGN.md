# Lifecycle kernel unification — design proposal (issue #146)

Status: proposal, not yet implemented. Written after landing the worker-adapter
convergence (`src/coordination/worker-adapter.ts`, `SdkSessionWorkerAdapter`) and
after reading production's verification/commit/finalize code directly rather than
inferring from the issue text. Confirmed via `gh api .../branches/main/protection`
that `main` in this repo is **not** branch-protected — no required PR, no required
CI check. That fact changes the recommendation below materially, so it's called out
up front.

## 1. Current-state inventory

Four independent "land this on main" implementations exist today, not two:

| Implementation | Where | Integration strategy | Used by |
|---|---|---|---|
| `finalizeIssue()` | `src/coordination/finalize.ts` | direct `git merge --no-ff` + `git push origin HEAD:main`, no PR, no CI wait. Lease + authority-fingerprint reconciliation, race-safe promotion retry, pending-external-verification support. | **Nothing.** Zero callers in `extensions/pi-next/`. Only its own tests and `src/coordination/cli.ts`. |
| `promoteCheckpoint()` | `extensions/pi-next/checkpoint.ts:231` | Same direct-push pattern as `finalizeIssue()`, independently implemented. Requires a `VERIFY.md`-style evidence file with `STATUS: PASS` + fingerprint match + commit-evidence reachability (`promotionReadiness()`, line 198). Emits its own journal/checkpoint events. | Production's checkpoint-commit flow. |
| `runBootstrapFinalize()` | `scripts/bootstrap-finalize.ts` | PR-based: push branch → create/find PR → poll `gh pr checks` → `gh pr merge` → prove reachability → close issue. Also reimplements pending-external-verification via structured HTML-comment markers on the issue (`PENDING_VERIFICATION_MARKER`), independently of `finalizeIssue()`'s typed `PendingVerificationRecord`. | `npm run bootstrap:self-host` only. |
| Ad hoc via `commit-safety.ts` | `extensions/pi-next/commit-safety.ts` | No integration function at all. `commitExplicitPaths()` (line 253) and `assertArchiveReady()`/`archiveAndCommit()` (lines 86, 393) are *guardrails* — path classification, a `WORKFLOW_ONLY_COMMIT_LIMIT` budget, staged-path/conflict checks, live-fingerprint + quality-gate-freshness re-checks — that the AI worker's own `git`/`gh` invocations must satisfy. There is no single call that merges/closes; the model issues the commands. | Production's general "the worker itself commits/pushes/closes" path outside checkpoint promotion. |

Verification is two structurally different mechanisms, not two implementations of
one concept:

- **Bootstrap** (`src/bootstrap/verification.ts`): a command runner. Runs
  `npm run typecheck` and `npm test`, returns `CheckReport[]` (`exitCode`,
  `passed`, `failureEvidence`). Answers "does it build and pass tests."
- **Production** (`extensions/pi-next/acceptance-verification.ts`): a criterion-
  evidence classifier. `evaluateManualAcceptanceCriterion()` (line 232) turns a
  model-supplied `ManualAcceptanceReview` into `PASS/FAIL/EXTERNAL/UNPROVEN` per
  acceptance criterion, with regex-based external-gate detection
  (`isExternalAcceptanceCriterion`, line 138) and a separate `VERIFY.md`
  structural/authority validator (`verificationReportAuthorityErrors`, line 319).
  Answers "does it satisfy what the issue actually asked for," which mechanical
  checks cannot determine on their own.

These are complementary, not redundant — see §2.

Failure/disposition typing is three non-overlapping enums:

- Bootstrap `Disposition` (`src/bootstrap/types.ts`): `pass | already-satisfied |
  no-change | repairable-failure | blocked` — outer lifecycle-attempt result.
- `VerificationFailureDisposition` (`extensions/pi-next/verification-failure-
  disposition.ts`): `REPAIR | DEFER_ISSUE | RECONCILE` — routes *why a semantic
  acceptance-criterion FAIL happened* (real defect vs. belongs to another issue
  vs. authority changed underneath it). Pure, small, well-factored.
- `WorkerFailureClassification` (`extensions/pi-next/worker-failure.ts`):
  `runtime | repository | work | external | transient` — routes *why the worker
  process itself died* (crash/OOM vs. repo-state problem vs. legitimate task
  failure vs. external dependency vs. transient/retryable). Already maps
  reasonably onto the `WorkerAdapter.failure.code` seam from the #151/worker-
  adapter work.

`checkpoint.ts` already consumes `src/coordination/lifecycle-checkpoints.ts`
(`emitLifecycleCheckpoint`) — that convergence already happened and doesn't need
revisiting.

## 2. Target shape

One canonical **lifecycle result** feeding one canonical **finalizer**, with the
two verification mechanisms kept as separate, composable *evidence sources* rather
than forced into a single check-runner:

```
                    ONE LIFECYCLE KERNEL
   ┌──────────────────────────────────────────────────────┐
   │ WorkerAdapter.run() → WorkerTerminalResult             │  (done — #146 step 1)
   │        │ ok / failure.code                             │
   │        ▼                                                │
   │ mechanical verification (CHECKS: typecheck/test)        │  bootstrap today
   │        │ passed/failed + CheckReport[]                  │
   │        ▼                                                │
   │ criterion verification (acceptance-evidence, optional)  │  production today
   │        │ PASS/FAIL/EXTERNAL/UNPROVEN per criterion       │
   │        ▼                                                │
   │ ONE outer LifecycleDisposition                          │  ← new, this proposal
   │        │                                                 │
   │        ▼                                                │
   │ ONE finalizer: finalizeIssue()                           │  ← promote to canonical
   └──────────────────────────────────────────────────────┘
        │              │                │
   bootstrap:self-host  /pi-next auto   checkpoint promotion
```

### 2a. One outer `LifecycleDisposition`

Do not delete `VerificationFailureDisposition` or `WorkerFailureClassification` —
they answer different, real questions and neither one is redundant with bootstrap's
`Disposition`. Instead, define one outer type that both feed into, and that
subsumes bootstrap's `Disposition`:

```ts
type LifecycleDisposition =
  | "pass"                 // mechanical + criterion evidence both clear, integrated
  | "already-satisfied"    // authority says closed/done, no candidate needed
  | "no-change"            // completed worker turn, zero candidate delta
  | "repairable-failure"   // mechanical checks failed; repair loop eligible
  | "semantic-repair"      // mechanical pass, criterion FAIL, disposition=REPAIR
  | "defer-issue"          // criterion FAIL, disposition=DEFER_ISSUE (not this issue's defect)
  | "reconcile"            // criterion FAIL, disposition=RECONCILE (authority moved)
  | "worker-failed"        // WorkerAdapter ok:false — see failure.code for WorkerFailureClassification
  | "blocked";             // foreign owner / stale lease / cancellation
```

`VerificationFailureDisposition` becomes the *reason field* on `semantic-repair` /
`defer-issue` / `reconcile`, not a competing top-level type. `WorkerFailureClassification`
becomes the reason field on `worker-failed`. This is additive to both existing
files — no behavioral change to either classifier, just a place both results land.

### 2b. Verification stays two composable layers, both mechanical where possible

Bootstrap's `CHECKS` runner is kept as-is and becomes mandatory everywhere — it is
cheap, fast, deterministic, and already proven. Production's criterion-evidence
layer is kept **as an optional second stage**, run only when the issue has explicit
acceptance criteria requiring evidence review, exactly as it does today. Neither
side needs to imitate the other; they get sequenced under one result type instead
of living in two disconnected controllers.

### 2c. One finalizer: promote `finalizeIssue()`

Recommendation: **`src/coordination/finalize.ts`'s `finalizeIssue()` becomes the
one mechanical finalizer for every entry point**, not bootstrap's PR-based flow.
Reasons, now that Campsty compatibility is explicitly not a constraint:

1. **`main` has no branch protection in this repo** (confirmed via the GitHub API
   just now — 404 "Branch not protected"). Two of the four existing
   implementations (`finalizeIssue()`, `promoteCheckpoint()`) already push
   directly to `main` with no PR and no CI wait, and that is not a shortcut — it's
   consistent with how the repository is actually configured. Bootstrap's PR+CI
   flow is solving a constraint that doesn't exist here.
2. `finalizeIssue()` is the most mature of the four: lease-ownership
   revalidation, authority-fingerprint reconciliation immediately before close,
   promotion-race retry with reachability proof, and typed
   `pendingVerification` support with a real `PendingVerificationRecord`, all
   under deterministic tests today.
3. It already takes an injected `IssueLeaseAuthority` + `WorkAuthorityAdapter` —
   the same abstractions production's controller already uses to claim issues.
   Wiring it in is parameter-passing, not new infrastructure.
4. Dropping the PR/CI step removes an entire class of complexity from bootstrap's
   finalizer (`scripts/bootstrap-finalize.ts` is 389 lines; a large fraction of
   it — `GhAuthority.createPullRequest`/`waitForChecks`/`mergePullRequest`,
   `classifyCiEvidence`, `evaluateGhPrChecks`, `requiredStatusContexts` — exists
   only to serve the PR+CI path and can be deleted outright once nothing needs
   it, satisfying the issue's "duplicated legacy code is removed, not silently
   kept" acceptance criterion).

What to fold in from the two implementations being retired:

- From `promoteCheckpoint()`/`promotionReadiness()`: the `VERIFY.md`-with-
  `STATUS: PASS`-and-fingerprint-and-commit-evidence-reachability gate is a good
  idea and isn't in `finalizeIssue()` today. Add it as an optional pre-check
  `finalizeIssue()` runs before it starts mutating anything, rather than leaving
  it as a separate caller-side gate two of the four implementations reimplement
  differently.
- From `runBootstrapFinalize()`: the local-worktree cleanup and local-`main`
  fast-forward-sync steps (`cleanIntegratedWorkspace`, `synchronizeLocalMain`)
  are genuinely useful and orthogonal to the merge strategy — keep them as a
  separate post-finalize step any caller can invoke, same as today.
- The bootstrap-only HTML-comment pending-verification markers
  (`PENDING_VERIFICATION_MARKER`/`PENDING_VERIFICATION_RESULT_MARKER`) get
  deleted in favor of `finalizeIssue()`'s typed `PendingVerificationRecord`,
  which is a strictly better mechanism (structured, validated, not
  string-parsed from issue comments).

Open question for you: should the PR+CI path be kept as an *opt-in* policy flag
on `finalizeIssue()` (for a future repo that does have branch protection), or
deleted outright since nothing here needs it? Leaning toward deleting it now and
re-adding if a real need appears — carrying unused generality forward is exactly
the kind of thing #146 is trying to stop doing.

### 2d. Repair/retry: bootstrap's zero-delta policy becomes canonical

No production equivalent to `zero-delta-retry-policy.ts` was found. It's small,
pure, and well-tested (`decideZeroDeltaImplementationRetry`). Production adopts it
directly rather than growing its own version. Nothing to redesign here, just wire
it in when the controller migrates.

## 3. Migration plan

Phased so each step is independently testable and revertable, per the issue's own
"prefer incremental convergence" guidance — but now allowed to change production
behavior outright rather than staying behind a compatibility shim:

1. **Define `LifecycleDisposition`** in `src/coordination/` (new file), covering
   §2a. Pure types + a translation function from bootstrap's current
   `Disposition` and from `(VerificationFailureDisposition, WorkerFailureClassification)`
   pairs. No behavioral change yet — additive, tested in isolation.
2. **Extend `finalizeIssue()`** with the optional evidence-file pre-check from
   `promotionReadiness()`. Deterministic tests using disposable Git + fake
   authority, no model calls, following the existing pattern in
   `src/coordination/finalize.ts`'s own test suite.
3. **Point `checkpoint.ts`'s `promoteCheckpoint()` at `finalizeIssue()`** instead
   of its own inline git sequence, keeping its journal-event emission wrapped
   around the call. This retires the second of four finalizers.
4. **Point `scripts/bootstrap-finalize.ts` at `finalizeIssue()`**, dropping the
   PR/CI machinery per the decision in §2c (pending your answer on keeping it as
   an opt-in flag). Bootstrap's own deterministic test suite
   (`test/bootstrap-finalize.test.ts`, `test/bootstrap-self-host.test.ts`) is the
   regression net — it already covers reachability, staleness, already-merged,
   and pending-verification scenarios and will need updating to the new call
   shape, not new coverage invented from scratch.
5. **Wire production's live commit/close path through `finalizeIssue()`.** This
   is the one step that actually touches `extensions/pi-next/`'s live control
   flow: replace the AI-worker-issues-raw-git/gh-under-guardrails pattern with a
   controller-invoked `finalizeIssue()` call once `commitExplicitPaths()`'s
   guardrails confirm the candidate is ready. This is the step that most needs a
   second look from you before landing, since it changes what the worker is and
   isn't allowed to do directly (it currently can push/merge/close itself; after
   this it wouldn't be able to).
6. **Verification convergence**: introduce the two-stage mechanical-then-
   criterion verification sequence from §2b as the one path both bootstrap and
   production's controller call, replacing production's standalone
   `acceptance-verification.ts` invocation site (not the file itself — its
   classifier logic is kept, just sequenced under the shared result type).
7. **Delete retired code**: `runBootstrapFinalize()`'s PR/CI machinery (per §2c),
   `promoteCheckpoint()`'s inline git sequence, the HTML-comment pending-
   verification markers. No fallback path kept, per the issue's acceptance
   criteria.
8. **Qualify** through #83 once steps 1-7 land, same as the issue's original
   plan.

Steps 1-4 are low-risk (bootstrap/coordination-only, fully covered by existing
deterministic test patterns). Step 5 is the one with real behavioral
consequences and deserves its own focused review before I touch it — I'd suggest
treating it as a separate follow-up once 1-4 are done and you've seen them work,
rather than bundling it into the same pass.

## 4. What this proposal deliberately does not resolve yet

- The exact shape of "the controller invokes `finalizeIssue()` instead of the
  worker doing it" for production (step 5) — that's a real design decision about
  what capabilities the worker keeps vs. loses, not just a refactor, and belongs
  in its own review once the groundwork (1-4) is in place.
- `/pi-next auto` becoming a thin scheduler (issue #146's own step 2) — unrelated
  to verification/finalization convergence and can proceed independently once
  this lands.
