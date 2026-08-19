# Changelog

## 0.1.1 - 2026-08-19

Migration-ready pinned package release.

- Added bounded, independent adversarial review execution for configured
  high-risk work, with read-only reviewer contexts, exact candidate/authority
  binding, repair invalidation, and a maximum of two rounds.
- Hardened structured runtime feedback with versioned sanitized error shapes,
  path/URL/credential redaction, stable fingerprints, bounded recurrence,
  deduplicated sink escalation, pending state, and recursion containment.
- Added the versioned fresh-consumer fixture and disposable end-to-end smoke
  test covering exact Git package installation, fresh package activation,
  discovery, claim/worktree, checkpoint/recovery, completion, and remote
  isolation.
- Documented v0.1.1 compatibility (Pi 0.84.2+, Node 22.19+), package/config
  schema version 1, immutable installation, migration, and pre-1.0 limits.

Known limitations: Pi-next is not an OS sandbox; workers retain the host's
shell/file/Git permissions. The GitHub adapter and credentials remain
consumer-owned, and the deterministic consumer smoke uses an in-memory fake.

## 0.1.0 - 2026-08-19

- Add deterministic worker-role dispatch with selective skills, capability
  profiles, candidate/authority binding, provider-neutral model routing, and
  bounded role metadata in worker telemetry.
- Bound bookkeeping commits across workflow and lifecycle paths, defensively
  classify explicit commit contents, and add sanitized recurring runtime
  feedback primitives with optional consumer sinks.

All notable changes to pi-next are documented here. The project is pre-1.0;
minor releases may change public behavior and breaking changes are called out.

- Added the pinned, allowlisted Matt Pocock engineering skill packs with a
  deterministic non-interactive sync/check CLI, SHA-256 provenance, preserved
  MIT license, companion-file validation, and an explicit local trust-boundary
  overlay (#7).
- Ported the guarded terminal-completion primitive (`finalize`) and the
  `status`/`claim`/`renew`/`release`/`workspace`/`prepare`/`finalize` JSON
  coordination CLI from a consumer's local copy (#19). `finalize`'s
  close/comment step goes through the `WorkAuthorityAdapter` boundary
  instead of being hardcoded to GitHub.
- Fixed a terminal-safety defect where a `finalize` retry with nothing new
  to integrate could close on a live main tree that was never actually
  reverified (#20). Retrying after a `requiresReverification: true` result
  now requires the caller to pass back that result's `mergeSha` as
  `verifiedIntegratedMain`; a mismatch (another commit landed since)
  returns `requiresReverification: true` again instead of closing.
- Added public quick-start, command, architecture, recovery, and security
  documentation.
- Added `/pi-next-doctor` for package/configuration/workflow diagnostics.
- Added contribution, support, and threat-model guidance.

The release is tested with Pi 0.84.2+ and Node 22.19+. It is experimental;
consumers must pin this tag and review the host-permission threat model.

Configuration and authority contracts are version 1. Migration from copied
extensions requires removing the copy and installing the native package.
