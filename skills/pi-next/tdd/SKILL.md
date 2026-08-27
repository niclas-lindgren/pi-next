# Pi-next unattended TDD discipline

Adapted from Matt Pocock `tdd` at revision `885e2ca4d842d139e9aef4e48d366c63cb1b8013` for unattended pi-next implementation/repair workers.

Runtime contract:
- Use the testing seam explicitly bound by dispatch as `testingSeam` from the issue, PLAN, or task packet. Do not ask the user to confirm a seam in unattended execution.
- If `testingSeam` is missing or not authoritative, stop with exactly this typed bounded result instead of waiting or inventing a seam: `{"status":"blocked","code":"MISSING_BOUND_SKILL_INPUT","missingInputs":["testingSeam"],"evidence":"No authoritative testing seam was supplied by dispatch"}`.
- When a seam is bound, preserve red → green discipline: write or identify the smallest failing behavioral test, implement the vertical slice, then run the relevant check.
- Keep tests behavior-focused. Avoid broad rewrites, speculative mocks, and authority changes outside the owned workspace.
