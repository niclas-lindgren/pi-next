# pi-next

Pi-next is an experimental autonomous issue-implementation loop for the
[pi-coding-agent](https://github.com/niclas-lindgren/pi-coding-agent) host. It
is a Pi extension, not a model provider or a replacement for Pi's package
manager.

> **Experimental / pre-1.0:** v0.1.5 is the latest migration-ready public
> release. Review the code and use a disposable repository before enabling
> autonomous runs on valuable work.

## Requirements

- Node.js 22.19 or newer (required by the supported Pi 0.84.2 host).
- Git and a working Pi installation, currently Pi 0.84.2 or newer.
- A configured model/provider supported by Pi.
- An authority adapter and project policy configured by the consuming project.

## Install as a native Pi package

Use an immutable release tag or commit, rather than floating `main`, for
reproducible or autonomous use. The supported release is:

```sh
pi install -l git:github.com/niclas-lindgren/pi-next@v0.1.5
```

The `-l` form records the exact package ref in the consuming repository's
`.pi/settings.json`; commit that settings entry if other checkouts should
install the same package automatically. Use `pi install` without `-l` for a
user-global installation. Pi's native lifecycle commands manage the package.
Run `/pi-next-doctor` after installation to observe the loaded version and
revision before enabling automation:

```sh
pi list
pi config
pi update --extensions
pi remove git:github.com/niclas-lindgren/pi-next
```

To move a project to another pinned release, install the new exact tag or
commit; subsequent `pi update --extensions` runs reconcile that pinned ref
rather than floating to `main`:

```sh
pi install -l git:github.com/niclas-lindgren/pi-next@v0.1.5
```

A commit SHA may be used while developing. v0.1.5 uses package/config schema
version 1 and supports Pi 0.84.2+ with Node 22.19+. It is pre-1.0: minor
releases may change behavior, and consumers should review release notes before
upgrading. Updating or removing pi-next does not own or delete the consumer's
workflow state, recovery data, or policy.
For local development, Pi also accepts a package directory directly:

```sh
pi install -l /absolute/path/to/pi-next
```

## Project configuration

Project-specific authority and workflow policy is declared in the committed
`.pi-next/config.json` file. The schema is versioned (`version: 1`) and is
validated before workflow state is changed. The default adapter is GitHub with
priority buckets `P0` through `P3`; consumers should set explicit priorities,
readiness/blocked states, project-status mappings, repository-policy entrypoints,
and workflow paths for other authorities. Unsupported adapters and invalid paths
fail closed. A minimal custom configuration looks like:

```json
{
  "version": 1,
  "authority": { "adapter": "github" },
  "selection": {
    "priorities": ["P0", "P1", "P2", "P3"],
    "readyStates": ["ready"],
    "blockedStates": ["blocked"]
  },
  "repositoryPolicy": { "entrypoints": ["AGENTS.md"] },
  "assessment": {
    "enabled": true,
    "noProgressThreshold": 2,
    "repeatedFailureThreshold": 2,
    "findingRecurrenceThreshold": 3,
    "findingLabels": ["agent:finding"],
    "heldStates": ["pending_review"],
    "approvedStates": ["approved"],
    "rejectedStates": ["rejected"],
    "supersededStates": ["duplicate"]
  },
  "workflow": {
    "stateDir": ".pi-next",
    "planPath": ".pi-next/PLAN.md",
    "verifyPath": ".pi-next/VERIFY.md",
    "archiveDir": ".pi-next/ARCHIVED",
    "deferredDir": ".pi-next/deferred",
    "skillPath": ".pi-next/SKILL.md",
    "tuningPath": ".pi-next/LOOP_TUNING.md",
    "diagnosticsPath": ".pi-next/diagnostics",
    "helperDir": ".pi-next/scripts",
    "stateProvider": { "type": "builtin" }
  }
}
```

The reusable adapter contract is exported from `src/coordination/`; GitHub is
the built-in adapter and `memory` is available for integration tests. Online
health is evaluated on every managed transition. Structural findings are
bounded, deduplicated, persisted as sanitized evidence, and published only
after their configured recurrence/confidence threshold. Published findings
carry a review-held state and cannot be selected until the authority records
approval. Reversible runtime adaptations can be evaluated and rolled back;
unreviewed code or architecture changes are never applied by the controller.
Pi-next never assumes `AGENTS.md`, `.agents/skills`, or a product-specific
policy tree when those paths are not configured. Workflow state inspection uses
its package-owned provider by default; consumers that need different semantics
may explicitly set `workflow.stateProvider` to `{ "type": "helper", "path":
".pi-next/scripts/pi-next-state.sh" }`. An explicit helper is validated,
including its output contract, before autonomous recovery, issue claim, or
worker launch, and failures never silently fall back to the built-in provider.

## Safe first run

Create a disposable test repository, configure its model/provider and the
project's authority adapter, then start Pi there. Inspect the available
commands with `/pi-next` and run `/pi-next-doctor` and `/pi-next-status` before
enabling an automatic loop. Pi-next can run coding workers with shell, file,
and Git access, so its host process has the permissions of the user running Pi.

Runtime state is kept under `.pi/` and issue worktrees under `.worktrees/`,
both ignored by Git.

## Command reference

Commands are Pi slash commands and run without asking the model to interpret
the command:

| Command | Purpose |
| --- | --- |
| `/pi-next auto` | Validate workflow state, then run the bounded autonomous issue loop. |
| `/pi-next fresh [#N]` | Claim an issue and start a parentless worker session. |
| `/pi-next [#N]` | Run one issue-scoped transition, using the live shortlist when no issue is given. |
| `/pi-next-doctor` | Validate package identity, project configuration, and the configured workflow helper. |
| `/pi-next-status` | Show local PLAN/loop state without invoking a model. |
| `/pi-next-loop status\|stop\|resume` | Inspect, stop, or recover a bounded loop. |
| `/pi-next-handoff` | Check whether the current checkout is safe to hand off. |
| `/pi-next-view all\|off\|#N\|run ID\|compact\|verbose\|status` | Filter the worker display/transcript or select its density. |

`/pi-next-doctor` and `/pi-next-status` are diagnostic only; a successful
local status check does not establish issue ownership. `stop` never resets,
stashes, or commits worker changes.

## Architecture and safety boundaries

Pi-next is a kernel around a consumer's authority source:

```text
consumer config + authority adapter
                 |
                 v
  discovery -> lease/CAS ownership -> canonical worktree
                 |
                 v
       bounded worker -> PLAN -> verification -> guarded completion
```

The kernel owns generic work-item identity, leases, canonical workspaces,
durable transitions, worker lifecycle, verification sequencing, and bounded
telemetry. An authority adapter owns discovery, freshness, labels/statuses,
and completion semantics. Repository instructions, model selection, deployment
policy, and credentials remain consumer-owned. A PLAN is recovery state, not
ownership authority: resume requires a fresh authoritative lease and the
canonical worktree for the exact item.

Workers run in child Pi processes with the canonical worktree as their process
working directory. This prevents the parent coordination checkout from being
used as an issue workspace, but it is not an OS sandbox: workers can still use
any shell/file/Git capability granted by the host. Review the host, model,
extensions, repository, and credentials before enabling automation.

## Recovery and troubleshooting

1. Run `/pi-next-doctor` and `/pi-next-status` in the consumer checkout.
2. Inspect `git status` and `.pi/runtime/` without deleting the canonical
   worktree or PLAN artifacts.
3. Use `/pi-next-loop status`; resume only after the authoritative lease and
   worktree are available.
4. Use `/pi-next-loop resume` for an interrupted owned loop. Foreign or stale
   PLAN files are refused rather than treated as ownership.
5. If a lease/worktree conflict remains, stop automation and resolve the live
   authority conflict first; do not force-push, reset, or manually claim the
   issue branch.

Common failures are intentional fail-closed behavior: invalid config, missing
adapter capability, stale ownership, ambiguous PLAN identity, dirty handoff,
and verification/freshness changes stop the transition rather than guessing.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for stable boundaries,
[`docs/WORKERS.md`](docs/WORKERS.md) for role/model/skill/capability dispatch,
[`docs/SKILLS.md`](docs/SKILLS.md) for optional skill trust and updates,
[`SECURITY.md`](SECURITY.md) for the threat model, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for support and change guidance.

## Development

Requires Node.js, Git, and the Pi host packages. Install dependencies and run
the self-tests from a clean checkout:

```sh
npm ci
npm run typecheck
npm test
```

The reusable lease, compare-and-swap, and worktree coordination implementation
is published under `src/coordination/` and has no dependency on a consumer
project's source tree. Optional engineering skills are managed through the
repository-owned `skills/manifest.json`; they are pinned, allowlisted, and not
loaded by default. Git mutation tests create temporary repositories and bare
remotes; they never use a real hosted remote.

### Local release automation

No hosted CI is required for releases. Install the repository's local
pre-push hook once:

```sh
npm run hooks:install
```

The hook validates pushes to `main`. When a main push contains package code
without a version bump, it runs `make release` (a patch release by default),
creates the release commit and tag, and safely stops the original push. Rerun
the push with `--follow-tags` after choosing a different level with
`PI_NEXT_RELEASE_LEVEL=minor|major` if needed:

```sh
make release                         # test, bump, commit, and tag (patch)
make release RELEASE_LEVEL=minor     # prepare a minor release
npm run release -- patch --push       # explicitly push main and the tag
npm run release -- patch --push --publish  # also publish to npm
```

Use `--dry-run` to preview the next version. Releases must be prepared from a
clean `main` checkout. Ordinary documentation-only pushes remain ordinary
commits; package changes on `main` become intentional release boundaries.

## Versioning and compatibility

Pi-next follows pre-1.0 SemVer expectations: minor releases may change public
behavior, while breaking changes are called out in release notes. The package
manifest's `pi.extensions` list is the supported resource boundary. Pi host
packages are peer dependencies and are supplied by Pi; the lockfile's
versions are development/test tooling, not a bundled Pi runtime.

Configuration and authority-adapter contracts are versioned independently as
those boundaries are introduced. Consumer policy, repository instructions,
model routing, and authority credentials remain consumer-owned.
