import { BootstrapReporter, CHECKS, CheckReport, CommandResult, CommandRunner, MAX_FAILURE_EVIDENCE } from "./types.js";
import { bounded, emitProgress, redact } from "./utils.js";

export async function runChecks(
  cwd: string,
  runner: CommandRunner,
  timeoutMs: number,
  issueNumber: number,
  reporter: BootstrapReporter | undefined,
  heartbeatMs: number,
  signal?: AbortSignal,
): Promise<CheckReport[]> {
  const checks: CheckReport[] = [];
  for (const command of CHECKS) {
    const started = Date.now();
    emitProgress(reporter, { issueNumber, phase: "check", state: "start", command });
    let heartbeat: NodeJS.Timeout | undefined;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        emitProgress(reporter, { issueNumber, phase: "check", state: "heartbeat", command, elapsedMs: Date.now() - started });
      }, heartbeatMs);
    }
    let result: CommandResult;
    try {
      result = await runner("sh", ["-c", command], { cwd, timeoutMs, signal });
    } catch (error) {
      emitProgress(reporter, { issueNumber, phase: "check", state: "fail", command, elapsedMs: Date.now() - started });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    const evidence = result.exitCode === 0 ? undefined : redact(bounded((result.stderr || result.stdout).slice(-MAX_FAILURE_EVIDENCE), MAX_FAILURE_EVIDENCE));
    checks.push({
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      passed: result.exitCode === 0,
      failureEvidence: evidence,
    });
    emitProgress(reporter, { issueNumber, phase: "check", state: result.exitCode === 0 ? "pass" : "fail", command, elapsedMs: result.durationMs });
    if (result.exitCode !== 0) break;
  }
  return checks;
}

export function failureEvidence(checks: CheckReport[]): string {
  return checks.filter((check) => !check.passed).map((check) => `${check.command} (exit ${check.exitCode}):\n${check.failureEvidence ?? "no output"}`).join("\n\n");
}
