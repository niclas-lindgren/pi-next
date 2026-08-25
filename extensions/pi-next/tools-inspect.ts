import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import { currentTask, validatePlan } from "./plan.ts";
import { issueNumber } from "./plan-write.ts";
import {
  changeFiles,
  markerFile,
  pathMatches,
  planFile,
} from "./util.ts";
import { formatWorkflowState, workflowState } from "./workflow-state-provider.ts";
import { getLiveIssueDetail } from "./issue-freshness.ts";

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
      "Inspect workflow state, current task, plan validity, handoff safety, staged/unstaged/untracked plan drift, or the live GitHub issue and its comments.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("state"), args: Type.Optional(Type.String()) }),
      Type.Object({ action: Type.Literal("current_task") }),
      Type.Object({ action: Type.Literal("validate") }),
      Type.Object({ action: Type.Literal("handoff") }),
      Type.Object({ action: Type.Literal("drift"), scope: Type.Optional(scopeSchema) }),
      Type.Object({ action: Type.Literal("issue"), issueNumber: Type.Optional(Type.Integer({ minimum: 1 })) }),
    ]),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "state") {
        const result = await workflowState(ctx.cwd, params.args || "", signal);
        return {
          content: [{ type: "text", text: formatWorkflowState(result.state) }],
          details: { provider: result.provider, state: result.state, stderr: result.stderr },
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

      if (params.action === "issue") {
        const number = params.issueNumber ?? issueNumber(existsSync(planFile(ctx.cwd)) ? readPlan(ctx.cwd) : "");
        if (!number) {
          return {
            content: [{ type: "text", text: "No issueNumber provided and no active PLAN.md identifies one." }],
            details: { ok: false },
          };
        }
        const detail = await getLiveIssueDetail(ctx.cwd, number);
        const text = [
          `#${detail.number} [${detail.state}] ${detail.title}`,
          "",
          detail.body,
          "",
          detail.comments.length
            ? detail.comments
                .map((comment) => `--- comment by ${comment.author || "unknown"} at ${comment.createdAt} ---\n${comment.body}`)
                .join("\n\n")
            : "(no comments)",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { ok: true, ...detail },
        };
      }

      if (params.action === "handoff") {
        const state = await handoffState(ctx.cwd);
        const result = await workflowState(ctx.cwd, "", undefined);
        const text = [
          `Safe handoff: ${state.safe ? "yes" : "no"}`,
          `State provider: ${result.provider}`,
          formatWorkflowState(result.state),
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
        (name) => name !== relative(ctx.cwd, planFile(ctx.cwd)).replace(/\\/g, "/"),
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
