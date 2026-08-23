# Worker canary fixtures

The real-worker canary corpus is generated from `src/evaluation/worker-canaries.ts` using fixture format version 1.

Each fixture contains:

- `id` and representative task `category`;
- disposable repository files used to create a fresh Git repo;
- a minimal worker task packet derived from the public task text;
- hidden mechanical grader assertions that run after `WorkerAdapter` completion.

Worker terminal status or prose is never a PASS signal; only the hidden grader result is authoritative.
