# pi-next

Pi-next is an experimental autonomous issue-implementation loop for the
[pi-coding-agent](https://github.com/niclas-lindgren/pi-coding-agent) host. It
is a Pi extension, not a model provider or a replacement for Pi's package
manager.

> **Experimental:** the first supported public release has not been cut yet.
> Review the code and use a disposable repository before enabling autonomous
> runs on valuable work.

## Requirements

- Node.js 22.19 or newer (required by the supported Pi 0.84.2 host).
- Git and a working Pi installation, currently Pi 0.84.2 or newer.
- A configured model/provider supported by Pi.
- An authority adapter and project policy configured by the consuming project.

## Install as a native Pi package

Use a release tag or commit, rather than floating `main`, for reproducible or
autonomous use. For example, after a tagged release:

```sh
pi install -l git:github.com/niclas-lindgren/pi-next@v0.1.0
```

The `-l` form records the package in the consuming repository's
`.pi/settings.json`; commit that settings entry if other checkouts should
install the same package automatically. Use `pi install` without `-l` for a
user-global installation. Pi's native lifecycle commands manage the package:

```sh
pi list
pi config
pi update --extensions
pi remove git:github.com/niclas-lindgren/pi-next
```

A commit SHA may be used while developing. Updating or removing pi-next does
not own or delete the consumer's workflow state, recovery data, or policy.
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
  "workflow": {
    "stateDir": ".pi-next",
    "planPath": ".pi-next/PLAN.md",
    "verifyPath": ".pi-next/VERIFY.md",
    "archiveDir": ".pi-next/ARCHIVED",
    "deferredDir": ".pi-next/deferred",
    "skillPath": ".pi-next/SKILL.md",
    "tuningPath": ".pi-next/LOOP_TUNING.md",
    "helperDir": ".pi-next/scripts"
  }
}
```

The reusable adapter contract is exported from `src/coordination/`; GitHub is
the built-in adapter and `memory` is available for integration tests. Pi-next
never assumes `AGENTS.md`, `.agents/skills`, or a product-specific policy tree
when those paths are not configured.

## Safe first run

Create a disposable test repository, configure its model/provider and the
project's authority adapter, then start Pi there. Inspect the available
commands with `/pi-next` and use status/recovery commands before enabling an
automatic loop. Pi-next can run coding workers with shell, file, and Git
access, so its host process has the permissions of the user running Pi.

Runtime state is kept under `.pi/` and issue worktrees under `.worktrees/`,
both ignored by Git.

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
project's source tree. Git mutation tests create temporary repositories and
bare remotes; they never use a real hosted remote.

## Versioning and compatibility

Pi-next follows pre-1.0 SemVer expectations: minor releases may change public
behavior, while breaking changes are called out in release notes. The package
manifest's `pi.extensions` list is the supported resource boundary. Pi host
packages are peer dependencies and are supplied by Pi; the lockfile's
versions are development/test tooling, not a bundled Pi runtime.

Configuration and authority-adapter contracts are versioned independently as
those boundaries are introduced. Consumer policy, repository instructions,
model routing, and authority credentials remain consumer-owned.
