import { AsyncLocalStorage } from "node:async_hooks";

import { recordLifecycleEvent } from "./lifecycle-telemetry.ts";
import {
  createExtensionGeneration,
  type ExtensionGeneration,
  type GenerationTeardownDiagnostics,
} from "./util-core.ts";

export interface GenerationTelemetryContext {
  cwd: string;
  runId: string;
  issueNumber?: number;
}

/**
 * The only mutable worker-generation state allowed by the foreground path.
 * Every auto invocation owns one instance; no supervisor can dispose another
 * supervisor's worker generation.
 */
export interface SupervisorRuntime {
  currentGeneration(): ExtensionGeneration | null;
  beginGeneration(
    reason: string,
    telemetry?: GenerationTelemetryContext,
  ): Promise<ExtensionGeneration>;
  teardown(
    target: ExtensionGeneration,
    reason: string,
    telemetry?: GenerationTelemetryContext,
  ): Promise<GenerationTeardownDiagnostics>;
}

const runtimeContext = new AsyncLocalStorage<SupervisorRuntime>();

export function currentSupervisorRuntime(): SupervisorRuntime | undefined {
  return runtimeContext.getStore();
}

export function withSupervisorRuntime<T>(
  runtime: SupervisorRuntime,
  callback: () => T,
): T {
  return runtimeContext.run(runtime, callback);
}

export function createSupervisorRuntime(): SupervisorRuntime {
  let generation: ExtensionGeneration | null = null;

  return {
    currentGeneration: () => generation,
    async beginGeneration(reason, telemetry) {
      const previous = generation;
      if (previous && !previous.isDisposed()) {
        await this.teardown(previous, reason, telemetry);
      }
      generation = createExtensionGeneration("pi-next-loop");
      return generation;
    },
    async teardown(target, reason, telemetry) {
      const diagnostics = await target.teardown(reason);
      // Retain the disposed reference for generation-owned callback guards;
      // callers can distinguish it from a live worker via isDisposed(). A
      // later beginGeneration() replaces this reference within this runtime.
      if (telemetry) {
        recordLifecycleEvent(telemetry.cwd, {
          event: "generation_teardown",
          issueNumber: telemetry.issueNumber ?? 0,
          runId: telemetry.runId,
          outcome: diagnostics.timedOut ? "failure" : "success",
          reasonCode: diagnostics.timedOut ? "teardown_timeout" : undefined,
          generation: diagnostics,
        });
      }
      return diagnostics;
    },
  };
}
