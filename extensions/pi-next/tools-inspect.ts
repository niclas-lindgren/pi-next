import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { currentTask, validatePlan } from "./plan.ts";
import {
  changeFiles,
  markerFile,
  parseState,
  pathMatches,
  planFile,
  runHelper,
} from "./util.ts";

const scopeSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("staged"),
  Type.Literal("unstaged"),
]);

function readPlan(cwd: string): string {
  const file = planFile(cwd);
  if (!existsSync(file)) throw new Error(`PLAN.md not found at ${file}`);
  return readFileSync(file, "utf8");
}

async function handoffState(cwd: string) {
  const dirtyFiles = await changeFiles(cwd, "all");
  const marker = markerFile(cwd);
  const marked = existsSync(marker);
  return {
    safe: dirtyFiles.length === 0 && !marked,
    dirtyFiles,
    marker,
    marked,
  };
}

export function registerInspectTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_next_inspect",
    label: "Pi Next Inspect",
    description:
      "Inspect workflow state, current task, plan validity, handoff safety, or staged/unstaged/untracked plan drift.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("state"), args: Type.Optional(Type.String()) }),
      Type.Object({ action: Type.Literal("current_task") }),
      Type.Object({ action: Type.Literal("validate") }),
      Type.Object({ action: Type.Literal("handoff") }),
      Type.Object({ action: Type.Literal("drift"), scope: Type.Optional(scopeSchema) }),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "state") {
        const { stdout, stderr } = await runHelper(
          ctx.cwd,
          "pi-next-state.sh",
          [ctx.cwd, params.args || ""],
        );
        return {
          content: [{ type: "text", text: stdout }],
          details: { state: parseState(stdout), stderr },
        };
      }

      if (params.action === "current_task") {
        const task = currentTask(readPlan(ctx.cwd));
        return {
          content: [{ type: "text", text: task?.block || "No unchecked tasks." }],
          details: { task },
        };
      }

      if (params.action === "validate") {
        const errors = validatePlan(readPlan(ctx.cwd));
        return {
          content: [
            {
              type: "text",
              text: errors.length
                ? `INVALID\n${errors.map((error) => `- ${error}`).join("\n")}`
                : "VALID",
            },
          ],
          details: { valid: !errors.length, errors },
        };
      }

      if (params.action === "handoff") {
        const state = await handoffState(ctx.cwd);
        const { stdout } = await runHelper(ctx.cwd, "pi-next-state.sh", [ctx.cwd]);
        const text = [
          `Safe handoff: ${state.safe ? "yes" : "no"}`,
          stdout,
          `Dirty=${state.dirtyFiles.length ? "yes" : "no"}`,
          state.dirtyFiles.length ? state.dirtyFiles.join("\n") : "",
          `Continue marker=${state.marked ? state.marker : "none"}`,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            safe: state.safe,
            dirtyFiles: state.dirtyFiles,
            marked: state.marked,
          },
        };
      }

      const task = currentTask(readPlan(ctx.cwd));
      if (!task) {
        return {
          content: [
            { type: "text", text: "STATUS: PASS\nNo unchecked current task." },
          ],
          details: { ok: true },
        };
      }

      const scope = params.scope || "all";
      const changed = (await changeFiles(ctx.cwd, scope)).filter(
        (name) => name !== `.ps-next/${basename(planFile(ctx.cwd))}`,
      );
      const planned = task.files.map((name) =>
        name.replace(/^\.\//, "").replace(/\/$/, ""),
      );
      const unplanned = changed.filter(
        (name) => !planned.some((item) => pathMatches(item, name)),
      );
      const missing = planned.filter(
        (name) =>
          name !== "TBD" &&
          !changed.some((item) => pathMatches(name, item)),
      );

      return {
        content: [
          {
            type: "text",
            text: [
              `STATUS: ${unplanned.length ? "WARN" : "PASS"}`,
              `Task: ${task.task}`,
              `Scope: ${scope}`,
              `Changed: ${changed.join(", ") || "none"}`,
              unplanned.length
                ? `Unplanned:\n${unplanned.map((name) => `- ${name}`).join("\n")}`
                : "",
              missing.length
                ? `Planned but unchanged:\n${missing.map((name) => `- ${name}`).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { ok: !unplanned.length, scope, planned, changed, unplanned, missing },
      };
    },
  });
}
