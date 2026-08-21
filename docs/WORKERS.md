# Worker dispatch

Pi-next resolves a versioned worker contract before launching a child. The
contract binds a lifecycle role, optional model/thinking policy, selected
engineering skills, capability profile, authority/candidate identity, and a
bounded output contract. The child cannot choose its own role from prose.

Roles are derived from controller state: planning, implementation, repair,
review-spec, review-standards, verification, maintenance, and controller.
Review roles use an isolated read-only-reviewer capability profile; owner roles
use mutable-owner only after the normal lease and canonical-worktree checks.
Pi's host currently cannot provide an OS sandbox for shell access, so review
workspace isolation remains an additional adapter responsibility and the
residual host permission threat is documented in `SECURITY.md`.

## Worker freshness vs. Pi host sessions

An isolated child worker process is Pi-next's normal **fresh model-context
boundary**. Planning, implementation, repair, review, verification, and other
model turns must reconstruct the current task from explicit dispatch inputs,
the canonical worktree, configured workflow artifacts, and fresh authority
rather than inheriting a previous issue's conversational state.

The parent `/pi-next auto` Pi host session is a different lifecycle boundary and
should normally remain stable across worker turns, issue changes, scheduler
cycles, and maintenance. Do not call `ctx.newSession()` merely to obtain a
fresh worker. Pi's session-replacement APIs tear down and replace the active
host runtime; they are reserved for genuine Pi/user lifecycle operations.

See [`HOST_SESSION_LIFECYCLE.md`](HOST_SESSION_LIFECYCLE.md) for the upstream Pi
contract, replacement semantics, memory/UI implications, and required
regression invariant.

Methodology is selective. TDD, bug diagnosis, code review, and codebase design
are loaded only for roles/tasks that need them. Skills are advisory and never
define authority, ownership, promotion, or closure.

Consumers may configure provider-neutral model routing under
`.pi-next/config.json`:

```json
{
  "workerDispatch": {
    "version": 1,
    "models": {
      "planning": { "model": "provider/model", "thinking": "medium" },
      "verification": { "model": "provider/strong-model", "thinking": "high" }
    },
    "maxEscalations": 2
  }
}
```

Model identifiers are examples and are not bundled defaults. Unknown roles,
unsupported thinking levels, and unbounded escalation values fail closed.
Bounded role, skill, and capability metadata is retained in worker telemetry;
prompts and transcripts are not.
