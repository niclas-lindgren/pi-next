# Verification before completion

A narrowly adapted discipline for a configured terminal-verification boundary.
It is methodology only. It does not own the pi-next lifecycle: the kernel still
owns work discovery, planning, leases/worktrees, review sequencing, promotion,
and closure. Do not treat this file as a workflow bootstrap or process owner.

Use this discipline when the dispatch selects it (mandatory verification tier).

- Re-read the live, authoritative requirements before judging completion. A
  checked plan box, a green command, or a prior worker's prose is evidence, not
  proof.
- Try to disprove each acceptance criterion. Inspect non-happy, legacy, and
  error paths, not just the path you implemented.
- Verify the exact candidate you were dispatched against. Do not accept results
  bound to a different authority/candidate fingerprint.
- Never narrow, rephrase, or reinterpret a requirement so that weaker evidence
  appears to satisfy it. If requirements are contradictory or materially
  changed, route to reconciliation rather than guessing.
- Distinguish verification you performed from checks that must run externally.
  An external/unproven criterion can never self-pass.
- Keep verification evidence concise and sanitized: no prompts, hidden
  reasoning, secrets, or raw transcripts.

This discipline complements pi-next's adversarial verification; it does not
replace the kernel's mechanical verifier or authority checks.
