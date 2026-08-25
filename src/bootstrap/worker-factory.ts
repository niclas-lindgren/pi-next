import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import { runCommand } from "./command-runner.js";
import { WorkerFactory } from "./types.js";
import { bounded, redact } from "./utils.js";
import { forbiddenWorkerCommand } from "../coordination/forbidden-worker-command.js";

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface BootstrapWorkerSettingsOverrides {
  compaction: { enabled: false };
  retry: { enabled: false };
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

export function bootstrapWorkerSettingsOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapWorkerSettingsOverrides {
  const overrides: BootstrapWorkerSettingsOverrides = {
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  if (env.PI_PROVIDER && env.PI_MODEL) {
    overrides.defaultProvider = env.PI_PROVIDER;
    overrides.defaultModel = env.PI_MODEL;
  }
  if (env.PI_REASONING_LEVEL && PI_THINKING_LEVELS.has(env.PI_REASONING_LEVEL)) {
    overrides.defaultThinkingLevel = env.PI_REASONING_LEVEL;
  }
  return overrides;
}

export function createBootstrapWorkerSettingsManager(sdk: any, cwd: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): any {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides(bootstrapWorkerSettingsOverridesFromEnv(env));
  return settingsManager;
}

function makeSafeBashTool(cwd: string, defineToolImpl: (definition: unknown) => unknown) {
  return defineToolImpl({
    name: "safe_bash",
    label: "Safe shell",
    description: "Run a repository command in the canonical worktree. Authority, main-branch, and destructive worktree operations are refused.",
    promptSnippet: "run a safe repository shell command",
    parameters: Type.Object({ command: Type.String({ description: "The command to run" }) }),
    execute: async (_toolCallId: string, params: { command: string }, signal: AbortSignal | undefined) => {
      if (forbiddenWorkerCommand(params.command)) {
        return { content: [{ type: "text", text: "Refused: authority, main-branch, or destructive worktree command." }], details: { refused: true } };
      }
      const result = await runCommand("sh", ["-c", params.command], { cwd, timeoutMs: 30 * 60 * 1_000, signal });
      const output = redact(`${result.stdout}${result.stderr}`);
      return { content: [{ type: "text", text: bounded(`exit ${result.exitCode}\n${output}`) }], details: { exitCode: result.exitCode } };
    },
  });
}

export async function createDefaultWorkerFactory(): Promise<WorkerFactory> {
  const sdk = await import("@earendil-works/pi-coding-agent") as any;
  const modelRuntime = await sdk.ModelRuntime.create();
  return async ({ cwd, role }) => {
    const agentDir = sdk.getAgentDir() || resolve(homedir(), ".pi", "agent");
    const settingsManager = createBootstrapWorkerSettingsManager(sdk, cwd, agentDir);
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "You are a bounded plain Pi coding worker. Follow the task packet and never act as lifecycle authority.",
    });
    await loader.reload();
    const readOnly = role === "review";
    const sessionResult = await sdk.createAgentSession({
      cwd,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      tools: readOnly ? ["read", "grep", "find", "ls"] : ["read", "edit", "write", "grep", "find", "ls", "safe_bash"],
      customTools: readOnly ? [] : [makeSafeBashTool(cwd, sdk.defineTool)],
    });
    return sessionResult.session;
  };
}
