# Optional engineering skills

Pi-next can consume a small, repository-owned allowlist of external engineering
skills. The current managed allowlist vendors `code-review`, `tdd`,
`diagnosing-bugs`, and `codebase-design` from
[`mattpocock/skills`](https://github.com/mattpocock/skills).

The intended architecture separates three different concepts:

1. **available** — a reviewed skill is installed/present and may be selected;
2. **selected** — the pi-next kernel resolves that skill for one worker dispatch;
3. **loaded** — only the selected skill content is added to that worker's bounded
   context.

Installing a skill must never imply that every worker loads it. A larger reviewed
catalog is acceptable only when dispatch remains selective and context stays
bounded.

## Trust and authority

Skill content is trusted, executable input. It is engineering methodology only:
it cannot claim work-item ownership, redefine authority or PLAN semantics, switch
or promote branches, close work items, or bypass Pi-next capabilities and
verification. The vendored skills are optional and are not loaded by default;
worker dispatch selects them explicitly.

The local trust-boundary overlay is kept outside the managed vendor directory.
Upstream files stay unchanged, while local adaptations remain visible in a
normal Git diff and survive synchronization.

Consumer-owned skills may also participate in routing, but they remain outside
the managed vendor destination and must be explicitly configured/registered.
For example, a consumer may choose an output/presentation discipline such as
`unslop`; that does not make it lifecycle authority or an always-loaded coding
methodology.

## Pinning and updates

[`skills/manifest.json`](../skills/manifest.json) is the source of truth. It
records the HTTPS upstream repository, a full immutable commit SHA, the explicit
file allowlist, destination, license/provenance, and overlays. Never replace the
revision with `main`, a branch, or a short SHA.

From a pi-next checkout:

```sh
npm run skills:check
npm run skills:sync
```

`skills:sync` fetches only the manifest's exact revision and is non-interactive.
It copies only allowlisted regular files, verifies relative companion links,
preserves the upstream MIT license, and writes deterministic
`PROVENANCE.json` SHA-256 records. It refuses to overwrite a destination that
has no Pi-next provenance or any drifted managed file. Run `skills:check` after
sync; review and commit the resulting diff intentionally.

Consumer-owned skills and configuration are outside the managed destination
and are never modified. Put adaptations in a declared overlay instead of
editing vendored files. Updating consists of changing the pinned SHA and, if
needed, the allowlist, running sync, reviewing the diff, then running the tests.
There is no background update.

As additional upstream sources are supported, preserve the same invariant:
installation is declarative, pinned, reviewable, non-interactive, and separate
from runtime selection. Do not let a worker discover an arbitrary skill on the
network and immediately execute it.

## Skill-source policy

Prefer small, composable engineering disciplines that fit underneath the
pi-next kernel rather than frameworks that try to become the development
workflow themselves.

Matt Pocock's engineering skills are a good default source because they are
composable and can be selected underneath pi-next's existing lifecycle.
Superpowers contains useful individual disciplines as well, especially explicit
verification-before-completion and review/debugging patterns, but the full
Superpowers bootstrap/workflow must not be enabled by default inside pi-next.
Pi-next already owns planning, worker lifecycle, worktrees, authority, review,
verification, and completion; importing a second process owner would duplicate
or conflict with those responsibilities.

When borrowing from another framework:

- import or adapt only the individual reviewed discipline that adds value;
- preserve upstream license/provenance;
- keep pi-next authority/capability overlays explicit;
- avoid duplicate automatic disciplines (for example, do not auto-load two TDD
  skills or two debugging methodologies for the same dispatch);
- treat process-owner/bootstrap instructions as incompatible unless an explicit
  adapter design proves otherwise.

## Runtime resolver

Skill selection should be deterministic enough to test and explain. The kernel
may use signals such as:

- lifecycle role (`planning`, `implementation`, `repair`, `review-*`,
  `verification`, `maintenance`);
- work-item labels/type and exact issue requirements;
- repository paths/components involved;
- detected language/framework;
- configured risk/domain class (for example auth, payments, migrations);
- current failure/recovery state;
- consumer skill policy.

A useful policy model has three tiers:

- **mandatory** — required for a lifecycle/risk boundary, such as a dedicated
  verification discipline before completion when configured;
- **automatic** — selected when deterministic role/task/risk rules match;
- **explicit** — available only when requested by project policy/operator or a
  higher-level planning decision.

No role receives all installed skills by default.

Conceptually:

```yaml
skills:
  mandatory:
    verification:
      - verification-before-completion

  automatic:
    repair:
      - diagnosing-bugs
    implementation:
      - tdd
    frontend:
      - frontend-design
      - browser-testing

  explicit:
    - codebase-design
    - domain-modeling
```

The exact configuration format is implementation-defined; it should integrate
with the versioned pi-next configuration rather than create another hidden
source of workflow authority.

## Lazy loading and conflicts

The resolver returns skill identifiers and reasons. The worker adapter loads only
those resolved skills into the bounded worker packet. Installed-but-unselected
skills consume no worker context.

The resolver must also detect overlapping/conflicting automatic disciplines.
Prefer one canonical skill for a methodology category (for example `tdd`,
`debugging`, or `code-review`) unless a deliberately separate review axis is
configured. Ambiguity should be resolved by explicit repository policy rather
than by asking the worker to reconcile competing instructions.

## Telemetry and evaluation

Bounded telemetry should record enough to evaluate routing without storing
prompts or hidden reasoning:

- selected skill identifiers and exact provenance/version;
- selection source/reason (`mandatory`, rule id, explicit request);
- role/task/risk classification used by the resolver;
- context/token contribution where measurable;
- verified outcome, retries/escalations, and cost/latency metrics already
  collected for the dispatch.

Use the evaluation corpus to compare skill policies. A routing change should be
kept only when it improves or preserves verified-completion efficiency and does
not weaken kernel guarantees. See
[`EVALUATION_AND_RELIABILITY.md`](EVALUATION_AND_RELIABILITY.md) and
[`WORKERS.md`](WORKERS.md).
