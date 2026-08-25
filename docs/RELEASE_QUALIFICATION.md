# Release qualification

Pi-next release cutover is gated by the unified lifecycle evidence below. Bootstrap, explicit issue execution, `/pi-next auto`, and monitor wake-ups must remain adapters/schedulers over `runSingleIssueLifecycle`; no entry point may keep a silent duplicate production lifecycle fallback.

## Commands

- Tier 1, zero model credentials on PR/main: `npm run qualify:tier1`
- Tier 2, disposable consumer boundary: `npm run qualify:tier2`
- Release-local deterministic gate (Tier 1 + Tier 2): `npm run qualify:release`
- Tier 3, explicit credentialed Pi canary through the shared lifecycle/WorkerAdapter boundary: `PI_NEXT_EVAL_ALLOW_LLM=1 npm run qualify:tier3`
- Full production-cutover evidence when credentials are intentionally available: `PI_NEXT_EVAL_ALLOW_LLM=1 npm run qualify:all`

`npm run release -- <patch|minor|major>` runs `npm run qualify:release` before it writes version/tag state. The tag verification workflow re-runs Tier 1 and Tier 2. Tier 3 is intentionally not a per-commit stochastic gate; compare its JSON output with `docs/evaluation/pi-worker-baseline.initial.json` using conservative operator review rather than silently accepting degradation. Only `qualify:all` can print `Production cutover qualified: YES`.

## Report shape

The qualification command prints a compact summary like:

```text
pi-next 0.2.84 release qualification (release)
Shared-kernel scenarios     PASS 1/1
Entry-point parity          PASS 1/1
Historical replay           PASS 2/2
Fault/restart matrix        PASS 1/1
Property/model seeds        PASS 1/1
Scheduler continuation      PASS 1/1
State/UI projection         PASS 1/1
Monitor idle/wake           PASS 1/1 (0 idle model calls)
Disposable consumer         PASS 1/1
Deterministic release gate qualified: YES
```

Tier 2 uses a disposable consumer checkout and package install only; it must not touch hosted product backlogs or deployment remotes. Manual Campsty dogfooding remains optional higher-level validation after lower tiers pass.
