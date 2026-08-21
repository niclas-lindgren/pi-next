# Contributing to pi-next

Pi-next is an experimental, pre-1.0 Pi extension. Contributions should keep
its generic kernel boundary separate from consumer product policy.

## Before changing code

1. Search existing issues and open a focused issue for new behavior.
2. Keep repository-specific labels, paths, prompts, deployment rules, and
   credentials out of reusable core code.
3. Preserve fail-closed ownership, canonical-worktree, freshness, verification,
   and completion invariants.
4. Treat Pi host APIs and the version-1 configuration/authority contracts as
   compatibility boundaries. Update documentation and tests when they change.

For the mandatory serial issue workflow—discover live GitHub issues, implement
one in its isolated worktree, commit, guarded-merge, push, complete through the
authority, and clean up before selecting the next issue—see [`AGENTS.md`](AGENTS.md).
Do not close an issue before the pushed candidate is proven reachable from
`origin/main`. Re-query the complete issue immediately before closure and, if
its title, body, comments, labels, status, or other authority data changed,
reconcile and re-verify before querying again and closing. Stop and preserve
recovery state when a global safety check fails.

## Development

Requirements are Node.js 22.19+, Git, and the supported Pi host packages.
From a clean checkout:

```sh
npm ci
npm run typecheck
npm test
```

Install the local release/validation hook with `npm run hooks:install`. A
push to `main` containing package code without a version bump automatically
runs `make release` (patch by default), creates the release commit and tag, and
stops the original push safely; rerun `git push --follow-tags`. Set
`PI_NEXT_RELEASE_LEVEL=minor` or `major` before the push when appropriate.
Releases can also be prepared explicitly with `make release` or
`npm run release -- patch|minor|major`; use `--push` and `--publish` explicitly
when desired. Release preparation requires complete current and next-version
notes in [`CHANGELOG.md`](CHANGELOG.md); the exact-tag GitHub Actions gate
then independently repeats typecheck, tests, and package smoke. See
[`docs/RELEASES.md`](docs/RELEASES.md) for batching and the consumer pin-bump
contract. Tests must use temporary repositories and bare remotes for every
Git mutation.
They must not push to `origin`, the pi-next checkout, or an arbitrary consumer
repository. Prefer deterministic in-memory authority fixtures over network
calls. Add regression coverage at the real controller/loop boundary when a
safety invariant is involved, not only for a parser or helper.

## Pull requests

Describe the problem, authority/configuration boundary, safety impact, and
recovery behavior. Include tests and documentation for user-visible commands or
schema changes. Keep commits reviewable; do not rewrite unrelated history or
force-push in implementation code or tests. A pull request should pass
`npm run typecheck` and `npm test` from a clean checkout.

## Project policy boundary

Pi-next core provides generic scheduling, ownership, worktree, lifecycle,
verification, and telemetry behavior. Consumers provide authority adapters,
repository policy entrypoints, model/provider choices, skills, deployment
rules, and credentials. External skills are engineering methodology only and
must not claim ownership, redefine authority, close work, or bypass verification.

## Support and release changes

Bug reports should include the pi-next revision, Pi host version, Node version,
OS, sanitized configuration shape, and a minimal reproduction. Do not attach
secrets, tokens, prompts, transcripts, hidden reasoning, or private repository
content. Feature proposals should state whether they belong in the reusable
kernel or in a consumer adapter.

Public releases are pinned pre-1.0 SemVer tags. Release notes must identify
supported Pi/Node versions, configuration or authority contract changes, known
limitations, and migration steps. Never document a floating `main` revision as
an unattended installation target.
