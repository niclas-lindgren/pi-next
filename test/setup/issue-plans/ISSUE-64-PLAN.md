# Issue #64 plan

## Authority snapshot

- Issue: #64, `fix(display): preserve whitespace across streamed worker text deltas`
- Snapshot: 2026-08-21, open; assigned to `niclas-lindgren`; no comments.
- Scope: visible worker text-delta sanitization and live display joining.

## Implementation slices

- Add a streaming-safe visible delta sanitizer that preserves boundary whitespace/newlines while retaining control-character and secret redaction safeguards.
- Keep the existing allowlist for visible text deltas and bounded live buffers unchanged.
- Add regression coverage for leading/trailing spaces, subword joins, newlines, controls, redaction, hidden event types, and bounded output.

## Verification

- `npm run typecheck`
- `npm test`
- Focused worker activity/display tests.

## Completion evidence

- Re-query issue authority immediately before commit/finalization and again after push before closure.
