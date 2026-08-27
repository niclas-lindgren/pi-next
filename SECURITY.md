# Security policy

Pi-next is security-sensitive automation. It can start Pi coding workers with
shell, file, and Git access in a consumer repository. Do not enable it in a
repository or account you would not give those capabilities to a trusted
developer.

## Threat model

You must trust:

- the Pi host and its installed extensions/packages;
- the configured model provider and the instructions it receives;
- the consumer repository, its configuration, hooks, scripts, and authority
  adapter;
- the GitHub CLI/token or other authority credentials available to the host.

Pi-next's worker adapter exposes positive capabilities rather than the host's
raw shell: mutable Pi workers use an explicit tool allowlist, guarded file
mutation paths, hook-disabled worker Git mutations, and sandboxed detached
build/test launchers where the host supports the configured OS sandbox.
Canonical worktrees isolate normal issue-worker working directories and
lease/CAS checks prevent ordinary coordination races.

Residual limitation: these controls are not a full same-user OS confinement
proof for arbitrary future tools or for controller-owned checks that
intentionally execute candidate code outside the worker sandbox. A worker
process may still read repository-visible data and anything else exposed by an
allowed tool. Read-only/reviewer conventions are not a substitute for an OS
sandbox unless the host explicitly supplies one, and unsupported sandboxed
launcher paths must fail closed rather than run unsandboxed.

Use a disposable repository for initial testing. Use a dedicated GitHub token
with the smallest practical repository permissions, avoid exposing production
credentials to the Pi process, and review changes and remote effects before
promoting or completing work. Never use a real upstream remote for mutation or
race tests.

## Data handling

Pi-next stores workflow/recovery state under `.pi/` and consumer workflow
artifacts under the configured paths. Telemetry is bounded and intended to
exclude prompts, transcripts, hidden reasoning, raw environment dumps,
credentials, and unnecessary authority bodies/comments. Do not put secrets in
PLAN files, issue comments, repository policy files, model prompts, or helper
output. Treat all local runtime state as sensitive until reviewed.

External package and skill content is executable/trusted input. Install pinned
revisions, review updates as Git diffs, and do not run from a moving `main`
branch in unattended use. Consumer configuration and policy can change what
Pi-next invokes; review them like source code.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use the
repository's private GitHub security-advisory/reporting channel when available.
If that channel is unavailable, contact the maintainers privately through the
GitHub account listed for this repository and include reproduction steps,
affected revision, impact, and a safe mitigation. Do not include live tokens,
private repository contents, prompts, or transcripts in a report.
