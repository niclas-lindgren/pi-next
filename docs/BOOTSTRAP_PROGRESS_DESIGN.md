# Bootstrap live progress design note

The bootstrap self-host command currently captures worker and subprocess activity internally and emits only the final JSON report. This is insufficient for unattended or long-running operation because a healthy worker can appear hung for the full worker timeout.

The intended implementation should keep the final structured report while adding a bounded human-readable event stream to stderr (or an equivalent progress channel) during execution. Suggested event classes:

- `preflight.start|pass|fail`
- `worktree.prepare.start|pass|fail`
- `issue.fetch.start|pass|fail`
- `worker.start|activity|heartbeat|finish`
- `check.start|finish`
- `repair.start|finish`
- `review.start|finish`
- `bootstrap.finish`

Worker activity should summarize safe event metadata such as tool name, phase, elapsed time and cumulative tool calls. Do not render model reasoning, prompt bodies, secrets, raw tool arguments that may contain secrets, or full command output. A periodic heartbeat should appear when no safe event has been printed for a bounded interval so an operator can distinguish an active worker from a dead process.

The implementation must remain injectable/testable: progress should flow through a small reporter interface or callback so tests can assert event ordering without reading process-global stdout/stderr. The default CLI reporter can render concise lines, while the final JSON report remains suitable for automation.
