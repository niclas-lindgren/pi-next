# Deterministic lifecycle scenario testing

Pi-next lifecycle/controller/recovery defects should be reproduced without a model whenever the failure is a deterministic authority, lease, Git, workspace, verification, finalization, or recovery ordering problem. The normal scenario suite is a zero-token CI boundary and must not require provider credentials.

The scenario layer introduced by #76 is intentionally small:

```text
production coordination/controller primitive
        ^
        |
programmatic scenario step
        |
        +-- MemoryIssueLeaseAuthority
        +-- InMemoryWorkAuthority
        +-- ScriptedWorkerAdapter
        +-- disposable real Git + local bare origin
        +-- ManualScenarioClock
```

It is not another lifecycle engine. The runner supplies deterministic resources, executes named steps, and wraps failures with the scenario and step name. The steps themselves call production pi-next primitives and assert durable state/invariants.

## Scripted worker

`src/evaluation/scripted-worker-adapter.ts` implements the production `WorkerAdapter` contract without importing or launching Pi. It can model bounded provider-neutral events, exact task/binding checks, writes and Git commits inside the supplied canonical cwd, success, failure, blocked, timeout, cancellation, and deliberately malformed terminal results.

The scripted worker has no lease, work-authority, promotion, closure, verification, or cleanup capability. Those remain outside the worker boundary exactly as they do for the Pi adapter.

## Scenario resources

`test/helpers/lifecycle-scenario.ts` composes:

- the existing `test/helpers/git-fixture.ts` disposable repository/local-bare-origin helper;
- a CAS-capable in-memory lease authority;
- the production `InMemoryWorkAuthority` where work-item authority is required;
- a manual fixed clock for lease timing;
- one `ScriptedWorkerAdapter` with a bounded sequence of scripted invocations.

Normal scenario tests require no provider credentials and must never contact hosted Git remotes.

## Initial permanent regression shapes

The #76 suite names and covers these baseline invariants:

1. two owners race for one issue -> exactly one authoritative owner;
2. fresh foreign lease -> losing owner launches zero workers;
3. stale takeover -> canonical dirty work survives before mutation;
4. non-zero worker -> bounded failure evidence, no false success;
5. missing terminal loop result -> deterministic same-issue reconciliation when ownership is still safe;
6. authority changes before close -> integration may remain durable while closure is refused;
7. pending external verification -> integrated and open are distinct states;
8. candidate-local containment -> unrelated queue work remains runnable;
9. static PLAN/preflight failure -> zero worker launches;
10. canonical unique dirty work -> never deleted merely to recover.

## Feature-harvest decisions

| Reference | Mechanism | Decision | Pi-next use |
| --- | --- | --- | --- |
| SWE-bench | reproducible fixture separated from independent grading | **adopt-pattern** | scenarios describe deterministic initial facts and assert kernel state/invariants rather than trusting worker prose |
| mini-SWE-agent / SWE-agent | small worker/environment/model seams and simple deterministic test doubles | **adapter** | `ScriptedWorkerAdapter` implements pi-next's smaller WorkerAdapter contract; no external agent framework is imported |
| existing pi-next Git safety + disposable Git helper | real Git semantics inside isolated local fixtures | **adopt-pattern** | scenarios reuse `test/helpers/git-fixture.ts` and local bare origins instead of mocking Git behavior |
| pi-next `InMemoryWorkAuthority` | product-neutral authority fixture | **adopt-pattern** | finalization/freshness scenarios use the same production adapter contract without GitHub |
| external evaluation/orchestration framework | full scenario runner / workflow engine | **reject** | unnecessary dependency and duplicate lifecycle semantics; the scenario runner remains a tiny programmatic wrapper |
| YAML/JSON scenario DSL | declarative fixture language | **reject for now** | TypeScript steps are smaller, type-checked, and can call production primitives directly; reconsider only if a text corpus materially reduces complexity |

These decisions follow `docs/EVALUATION_AND_RELIABILITY.md`: borrow proven mechanisms, not entire frameworks.

## Bug-fix rule

For any newly discovered real lifecycle/controller/recovery defect:

1. reduce the failure to bounded authority/Git/workspace/runtime facts;
2. add or extend a named deterministic scenario that reproduces the bad outer-path ordering where technically feasible;
3. prove the scenario fails before the fix;
4. implement the fix;
5. keep the scenario permanently in `npm test`;
6. only use a real LLM canary when the defect genuinely depends on model quality rather than protocol state.

A deterministic lifecycle bug should be expensive once. It should not require repeated Campsty dogfooding or model tokens to rediscover.

## Failure UX

A failing scenario is wrapped as:

```text
Scenario "<name>" step "<step>" failed: <violated invariant or production error>
```

Keep names stable and errors bounded so later replay/property-test work can promote minimal failures into permanent named regressions.
