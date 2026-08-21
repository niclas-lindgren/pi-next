# Pi-next release policy

Pi-next distinguishes an upstream commit from a consumer-facing release. A
merge may remain an ordinary `main` commit while compatible fixes are bundled
into the next release during a short stabilization window (normally one
working day). A release is cut when the bundle is useful to pinned consumers,
not once per merged fix. Release notes are prepared in the same change as the
release work and must describe the bounded set of changes since the previous
consumer-facing release.

Urgent correctness, security, or consumer-compatibility fixes are exempt from
batching and may be released immediately. The stabilization window must never
hold back a fix whose risk is greater than the cost of another tag.

## Release gate

Before `scripts/release.mjs` can change `package.json`, create a tag, or push,
`CHANGELOG.md` must contain complete entries for both the shipped version and
the next version. Each entry must include:

- material changes;
- compatibility, configuration, and schema changes;
- breaking or behavior-changing changes;
- security and safety changes; and
- upgrade guidance, including whether to upgrade now or wait for a bundled
  release.

The release script retains the local `npm run typecheck` and `npm test` checks.
The `release-gate.yml` workflow independently checks the exact pushed tag and
commit, runs those checks again on GitHub, and runs the fresh-consumer package
smoke. A tag is not consumer-ready unless that workflow passes. Verification
is tied to the tag's commit rather than to a moving branch.

## Consumer update contract

Consumers intentionally pin an immutable tag or commit. They should not add
`latest`, a floating branch, or an automatic downstream update. The bounded
upgrade flow is:

```text
new verified upstream release
 -> inspect release notes and compatibility sections
 -> update immutable package tag/commit
 -> run consumer integration and fresh-process checks
 -> commit the pin update
```

A consumer may wait for the next bundled release when the notes say the change
is non-urgent and compatible. Consumers should update promptly for correctness,
security, or compatibility fixes. Campsty and other downstream repositories
remain responsible for their own pin commits and integration checks.
