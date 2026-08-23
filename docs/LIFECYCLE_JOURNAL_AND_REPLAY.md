# Lifecycle journal and deterministic replay

Pi-next keeps a small durable history of coordination facts so recovery can explain what happened across process crashes without preserving an LLM conversation.

The journal is deliberately **not** a new authority source and not a general event-sourcing system. Git, the configured work authority, current lease state, and repository verification remain authoritative external facts.

## Durable format

The harness-neutral contract lives in `src/coordination/lifecycle-journal.ts`.

Pi stores one journal per run under its runtime directory:

```text
.pi/runtime/journal/<bounded-run-id>-<hash>.jsonl
```

Each line is a complete versioned JSON record with:

- schema version;
- monotonic sequence number;
- timestamp;
- stable run identity;
- optional issue identity;
- typed lifecycle event;
- optional idempotency key;
- a bounded allow-listed coordination payload.

The append path uses `O_APPEND` and `fsync` before returning. A partial/corrupt line, sequence gap, mixed run identity, unknown event, or unsupported schema version fails clearly; recovery does not guess through damaged history.

Payloads are limited to coordination facts such as branch/worktree identities, adapter/phase, compact terminal status, verification verdict, candidate/main revisions, authority fingerprints, pending-verification criterion IDs, and typed failure classification. The schema intentionally has no fields for prompts, model reasoning, transcripts, issue bodies, raw output, command logs, passwords, credentials, or authorization material. Runtime validation also rejects suspicious/unknown payload keys and enforces small byte/string budgets.

## Event boundary

Version 1 covers the durable lifecycle facts needed for recovery:

```text
candidate_selected
lease_claimed / lease_rejected / lease_taken_over / lease_released
workspace_prepared
worker_started / worker_finished
verification_finished
candidate_committed / candidate_pushed
promotion_started / promotion_pushed / promotion_succeeded
reachability_proven
authority_reconciled
pending_verification_recorded / issue_closed
workspace_cleaned
failure_recorded
```

`baseline_imported` is the explicit upgrade boundary for runs that predate the journal.

The existing `.pi/runtime/pi-next-lifecycle.json` remains a bounded rolling telemetry/UI file. Recovery-relevant events already emitted through that recorder are mirrored into the new append-only journal, preserving existing behavior while establishing durable history. When an old runtime already has rolling telemetry but no journal, the first journal write records `baseline_imported`; pre-journal history must then be reconstructed from live authority/Git facts rather than invented.

The WorkerAdapter compatibility boundary records `worker_started` **before** launching the child worker and `worker_finished` or a typed failure after settlement. Only adapter identity, phase, status/code/signal, and telemetry availability are recorded; prompt and worker output are never copied into the journal.

Future lifecycle code that depends on a durable transition should append the corresponding journal fact at the semantically correct mutation boundary and before any later irreversible follow-up side effect. Stable side effects should use an `idempotencyKey` when the transition has a natural identity (for example candidate/main reachability or terminal cleanup). Candidate local commit and candidate branch push are separate facts; main promotion push and promotion success recording are separate facts.

## Replay model

`src/evaluation/lifecycle-replay.ts` materializes the journal and combines it with current external observations. It returns the **next safe production action** and a `mustNotRepeat` set. Replay itself never pushes, closes, deletes a worktree, or launches a model.

Examples:

```text
lease claimed + workspace ready, no worker start
  -> start_worker

worker finished, no verification
  -> verify_candidate

verified candidate committed, no promotion
  -> promote_candidate

promotion recorded, Git already proves candidate reachable
  -> reconcile_reachability
     (do not push again)

reachability proven, authority not reconciled
  -> reconcile_authority

pending verification / close durable, workspace still present
  -> cleanup_workspace

issue-local contained failure durable
  -> contained
     (do not replay unsafe mutation)
```

The initial permanent fixture is `test/fixtures/replay/crash-boundaries.json`. Run it with:

```bash
npm run eval:replay -- test/fixtures/replay/crash-boundaries.json
```

Normal replay and tests use no provider credentials and no hosted Git mutation. Integration tests combine the replay planner with `ScriptedWorkerAdapter`, disposable real repositories, and a local bare origin so candidate/push/reachability behavior is checked with real Git semantics.

## Initial crash-boundary corpus

The version-1 fixture covers:

1. crash after lease claim before worker start;
2. crash after worker completion before verification;
3. crash after candidate commit;
4. crash after push/promotion before reachability proof;
5. crash after reachability proof before close;
6. crash after pending-verification disposition before cleanup;
7. replay of a typed contained failure without repeating unsafe mutation.

The suite also proves that a fully completed journal replays as `complete` and does not schedule promotion, reachability, closure, cleanup, or release again.

## Reference-pattern decisions

| Reference | Mechanism | Decision | Pi-next use |
| --- | --- | --- | --- |
| OpenHands-style event history | typed immutable/append-only history that explains state transitions | **adopt-pattern** | small JSONL coordination journal with explicit schema/version and bounded payloads |
| OpenHands runtime/event platform | broad application event bus and conversation persistence | **reject** | pi-next journals only recovery coordination facts; model conversation remains outside the journal |
| Temporal durable workflows | persist transition intent/facts before dependent side effects; retry idempotently | **adopt-pattern** | fsynced transition history, idempotency keys, and replay decisions that skip already-proven side effects |
| Temporal server/runtime | hosted workflow engine, workers, task queues, distributed durability | **reject** | unnecessary control plane for a local repository lifecycle kernel |
| SWE-bench / #76 scenario harness | generator/worker separated from independent grading and real disposable Git | **adopt-pattern** | replay is independently derived from durable facts and external observations, never from worker prose |

The rule remains: **borrow proven invariants, not entire orchestration frameworks**.

## Adding a real regression

When a real lifecycle/recovery bug is found:

1. sanitize it into bounded authority/Git/workspace/journal facts;
2. reproduce the bad ordering as a deterministic #76 scenario or replay fixture;
3. prove the regression fails before the fix;
4. fix the production transition ordering/idempotency;
5. keep the fixture permanently in `npm test`;
6. use a real model only when the failure genuinely depends on model quality.

A lifecycle bug should consume model tokens once at most; future detection belongs to deterministic replay/tests.
