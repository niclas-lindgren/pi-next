# Project context

This file provides optional cross-repository context for `pi-next`. It is not an instruction authority; `AGENTS.md` remains mandatory and its issue ownership, worktree, verification, finalization, recovery, and cleanup rules always take precedence.

Read this file when a task crosses repository boundaries, ownership is unclear, or you need to understand how `pi-next` composes with the wider private AI development environment. For ordinary repository-local lifecycle work, do not load it unless useful.

## Local role

`pi-next` owns autonomous Pi lifecycle/product behavior: issue selection/authority, canonical issue workspaces, worker orchestration, verification/finalization, recovery, and related controller semantics.

It does not own harness-neutral local-model policy, guest provisioning, reusable Claude configuration, or host convergence.

## Closest project relationships

- `my-llm-setup` owns canonical cross-repository architecture, shared pins, and the full project map in its `PROJECT.md`.
- `gsd-vm` may install/provision `pi-next` in the isolated Linux guest but must not duplicate its lifecycle/controller policy.
- `llm-local` may coexist with `pi-next` in Pi as optional local-model assistance. It owns preflight/advisor/local-model contracts, not issue authority or autonomous lifecycle.
- `claude-config` owns reusable Claude Code configuration and is separate from `pi-next` lifecycle ownership.

The worker harness is not lifecycle authority. Pi may be the current/default worker host, but the lifecycle/kernel invariants in this repository remain provider-neutral and must not be weakened by adapter-specific behavior.

## When deeper context is needed

Use `niclas-lindgren/my-llm-setup/PROJECT.md` for the compact five-repository map. Then load the canonical documents there only as needed: `docs/ARCHITECTURE.md`, `docs/AGENT-INTEGRATION.md`, and `docs/AGENT-MAINTENANCE.md`.
