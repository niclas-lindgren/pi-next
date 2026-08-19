# Changelog

## Unreleased

- Add deterministic worker-role dispatch with selective skills, capability
  profiles, candidate/authority binding, provider-neutral model routing, and
  bounded role metadata in worker telemetry.

All notable changes to pi-next are documented here. The project is pre-1.0;
minor releases may change public behavior and breaking changes are called out.

## Unreleased

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

## 0.1.0 (planned)

The first migration-ready pinned Pi package release will document the exact
Pi host/API and Node compatibility tested for the release, configuration and
authority contract versions, known limitations, and consumer migration steps.
It will be tagged only after CI and a disposable fresh-consumer smoke test
pass.
