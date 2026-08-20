# Optional engineering skills

Pi-next can consume a small, repository-owned allowlist of external engineering
skills. The initial allowlist vendors `code-review`, `tdd`, `diagnosing-bugs`,
and `codebase-design` from [`mattpocock/skills`](https://github.com/mattpocock/skills).

## Trust and authority

Skill content is trusted, executable input. It is engineering methodology only:
it cannot claim work-item ownership, redefine authority or PLAN semantics, switch
or promote branches, close work items, or bypass Pi-next capabilities and
verification. The vendored skills are optional and are not loaded by default;
future worker dispatch selects them explicitly.

The local trust-boundary overlay is kept outside the managed vendor directory.
Upstream files stay unchanged, while local adaptations remain visible in a
normal Git diff and survive synchronization.

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
