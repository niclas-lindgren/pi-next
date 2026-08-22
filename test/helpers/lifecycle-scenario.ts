import type { IssueLease } from "../../src/coordination/issue-authority.ts";
import type { IssueLeaseAuthority } from "../../src/coordination/issue-leases.ts";
import type { WorkerTerminalResult } from "../../src/coordination/worker-adapter.ts";
import {
  ScriptedWorkerAdapter,
  type ScriptedWorkerScript,
} from "../../src/evaluation/scripted-worker-adapter.ts";
import {
  createDisposableGitFixture,
  type DisposableGitFixture,
} from "./git-fixture.ts";

export const DEFAULT_SCENARIO_NOW = "2026-08-22T12:00:00.000Z";

function sameLease(left: IssueLease | undefined, right: IssueLease | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Small CAS-capable lease store used only by deterministic lifecycle scenarios. */
export class MemoryIssueLeaseAuthority implements IssueLeaseAuthority {
  private readonly leases = new Map<number, IssueLease>();

  constructor(initial: readonly IssueLease[] = []) {
    for (const lease of initial) this.seed(lease);
  }

  seed(lease: IssueLease): void {
    this.leases.set(lease.issueNumber, structuredClone(lease));
  }

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    const lease = this.leases.get(issueNumber);
    return lease ? structuredClone(lease) : undefined;
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    if (this.leases.has(issueNumber)) {
      throw new Error(`lease CAS create conflict for issue #${issueNumber}`);
    }
    this.leases.set(issueNumber, structuredClone(lease));
  }

  async replace(issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    const current = this.leases.get(issueNumber);
    if (!sameLease(current, expected)) {
      throw new Error(`lease CAS replace conflict for issue #${issueNumber}`);
    }
    this.leases.set(issueNumber, structuredClone(lease));
  }

  async remove(issueNumber: number, expected: IssueLease): Promise<void> {
    const current = this.leases.get(issueNumber);
    if (!sameLease(current, expected)) {
      throw new Error(`lease CAS remove conflict for issue #${issueNumber}`);
    }
    this.leases.delete(issueNumber);
  }

  snapshot(): ReadonlyMap<number, IssueLease> {
    return new Map(
      [...this.leases.entries()].map(([issue, lease]) => [issue, structuredClone(lease)]),
    );
  }
}

export class ManualScenarioClock {
  private current: number;

  constructor(initial = DEFAULT_SCENARIO_NOW) {
    const parsed = Date.parse(initial);
    if (!Number.isFinite(parsed)) throw new Error(`invalid scenario clock: ${initial}`);
    this.current = parsed;
  }

  now(): Date {
    return new Date(this.current);
  }

  iso(): string {
    return this.now().toISOString();
  }

  advance(ms: number): Date {
    if (!Number.isFinite(ms)) throw new Error(`invalid clock advance: ${ms}`);
    this.current += ms;
    return this.now();
  }
}

export class LifecycleScenarioError extends Error {
  constructor(
    readonly scenario: string,
    readonly step: string,
    cause: unknown,
  ) {
    super(
      `Scenario ${JSON.stringify(scenario)} step ${JSON.stringify(step)} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "LifecycleScenarioError";
  }
}

export interface LifecycleScenarioContext<
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
> {
  readonly name: string;
  readonly git: DisposableGitFixture;
  readonly leaseAuthority: MemoryIssueLeaseAuthority;
  readonly clock: ManualScenarioClock;
  readonly worker: ScriptedWorkerAdapter<TResult>;
  invariant(condition: unknown, message: string): asserts condition;
}

export interface LifecycleScenarioStep<
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
> {
  name: string;
  run(context: LifecycleScenarioContext<TResult>): void | Promise<void>;
}

export interface LifecycleScenario<
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
> {
  name: string;
  now?: string;
  withOrigin?: boolean;
  initialLeases?: readonly IssueLease[];
  workerScripts?: readonly ScriptedWorkerScript<TResult>[];
  initialFiles?: Record<string, string>;
  steps: readonly LifecycleScenarioStep<TResult>[];
}

/**
 * Programmatic zero-token scenario runner. It deliberately has no lifecycle
 * state machine of its own: each step calls production coordination/controller
 * primitives and asserts their durable effects. The runner only supplies
 * deterministic resources and wraps failures with scenario + step identity.
 */
export async function runLifecycleScenario<
  TResult extends WorkerTerminalResult = WorkerTerminalResult,
>(scenario: LifecycleScenario<TResult>): Promise<void> {
  const git = await createDisposableGitFixture({
    prefix: "pi-next-lifecycle-scenario-",
    withOrigin: scenario.withOrigin ?? true,
    initialFiles: scenario.initialFiles,
  });
  const leaseAuthority = new MemoryIssueLeaseAuthority(scenario.initialLeases);
  const clock = new ManualScenarioClock(scenario.now);
  const worker = new ScriptedWorkerAdapter<TResult>(scenario.workerScripts ?? []);
  const context: LifecycleScenarioContext<TResult> = {
    name: scenario.name,
    git,
    leaseAuthority,
    clock,
    worker,
    invariant(condition: unknown, message: string): asserts condition {
      if (!condition) throw new Error(`invariant violated: ${message}`);
    },
  };

  try {
    for (const step of scenario.steps) {
      try {
        await step.run(context);
      } catch (error) {
        if (error instanceof LifecycleScenarioError) throw error;
        throw new LifecycleScenarioError(scenario.name, step.name, error);
      }
    }
  } finally {
    await git.cleanup();
  }
}
