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
