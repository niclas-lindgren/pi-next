import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCrashLogger } from "./pi-next/crash-log.ts";
import { registerPiNextCommands } from "./pi-next/commands-recovery.ts";
import { registerContextPruning } from "./pi-next/context-pruning.ts";
import { registerCheckTool } from "./pi-next/tools-check.ts";
import { registerGitTool } from "./pi-next/tools-git.ts";
import { registerInspectTool } from "./pi-next/tools-inspect.ts";
import { registerUpdateTool } from "./pi-next/tools-update.ts";
import { registerWorkerWorkLogRenderer } from "./pi-next/work-log.ts";

export default function piNextExtension(pi: ExtensionAPI) {
  // Diagnostic-only safety net for #583: a crash that previously vanished
  // now leaves a bounded record in .pi/runtime/pi-next-crash-log.jsonl
  // before the process exits the way it already did. See crash-log.ts for
  // why this deliberately does not try to keep the process alive.
  installCrashLogger(process.cwd());
  registerContextPruning(pi);
  registerPiNextCommands(pi);
  registerInspectTool(pi);
  registerUpdateTool(pi);
  registerWorkerWorkLogRenderer(pi);
  registerCheckTool(pi);
  registerGitTool(pi);
}
