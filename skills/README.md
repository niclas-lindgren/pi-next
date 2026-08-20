# Worker skills

Pi-next ships the package-owned `performance-telemetry` maintenance skill under
`skills/pi-next/`. It is resolved directly from the installed package and does
not require a consumer skill tree.

Pi-next also vendors a small, reviewed subset of [`mattpocock/skills`](https://github.com/mattpocock/skills) as optional engineering methodology:

- `code-review`
- `tdd`
- `diagnosing-bugs`
- `codebase-design`

The allowlist, immutable upstream revision, provenance URL, managed
 destination, and local overlay are recorded in [`manifest.json`](manifest.json).
The vendored files are not workflow authority and are not loaded by default.
Role selection and capability enforcement belong to the Pi-next worker contract.

Run the deterministic commands from the repository root:

```sh
npm run skills:check
npm run skills:sync
```

`skills:sync` fetches the exact commit in the manifest, never `main`. It refuses
to overwrite a destination without Pi-next provenance or any drifted managed
file. Put local adaptations in the declared overlay rather than editing files
under `skills/vendor/mattpocock/`. Review the resulting Git diff before
changing the pinned revision.

Upstream content is MIT licensed; the original license is preserved at
`vendor/mattpocock/LICENSE` and the generated `vendor/mattpocock/PROVENANCE.json`
records the source revision and SHA-256 for every managed file.
