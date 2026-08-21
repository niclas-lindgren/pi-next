# Issue 70 plan

## Goal
Preserve the exact bound `/pi-next auto` footer through real host session replacement, including a replacement context whose host UI clears extension statuses during teardown.

## Approach

1. Make the presentation binding a first-class handoff record: bind and persist the run ID at controller creation (before the first session transition), retain the owner/session-file association, and keep it separate from authority or generic status selection.
2. Centralize lifecycle paints so shutdown never clears or guesses status, replacement startup paints the exact bound run synchronously, and heartbeat writes cannot target a disposed context or overwrite another agent's binding.
3. Exercise the outer command/session path with a host-lifecycle mock that models teardown status clearing and coalesced visible frames, repeated transitions, scheduler/recovery states, two independent bound agents, ambiguous unbound lookup, terminal repaint, and explicit clear semantics.
4. Verify with the repository typecheck and full test suite.

## Acceptance evidence

- Exact bound run is painted on every replacement before the first heartbeat interval.
- No Pi-next code emits an undefined status during normal handoff; only explicit clear does.
- Generic ambiguous selection remains fail-closed.
- Existing worker-display behavior remains untouched.
