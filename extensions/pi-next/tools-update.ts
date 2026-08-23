import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { writeLoopResult } from "./loop.ts";
import { recordPiLifecycleJournal } from "./lifecycle-journal.ts";
import { safeLoopBoundary } from "./loop-state.ts";
import { appendFix, currentTask, issueNumber, markDone } from "./plan.ts";
import { recordTransition } from "./workflow-commit-policy.ts";
import {
  archiveAndCommit,
  git,
  markerFile,
  planFile,
  psDir,
  required,
  today,
  workflowPath,
} from "./util.ts";

function readPlan(cwd: string): string {
  const file = planFile(cwd);
  if (!existsSync(file)) throw new Error(`PLAN.md not found at ${file}`);
  return readFileSync(file, "utf8");
}

async function deferActivePlan(
  cwd: string,
  expectedIssue: number,
  reason: string,
): Promise<string> {
  const file = planFile(cwd);
  const plan = readPlan(cwd);
  const activeIssue = issueNumber(plan);
  if (activeIssue !== expectedIssue) {
    throw new Error(
      `Cannot defer issue #${expectedIssue}: active PLAN.md belongs to #${activeIssue || "unknown"}`,
    );
  }

  const before = await safeLoopBoundary(cwd, false);
  if (!before.safe) {
    throw new Error(
      `Cannot defer issue #${expectedIssue} from a dirty/unsafe boundary: ${before.reason}`,
    );
  }

  const deferredDirectory = workflowPath(cwd, "deferredDir");
  mkdirSync(deferredDirectory, { recursive: true });
  const target = join(deferredDirectory, `issue-${expectedIssue}.md`);
  const boundedReason = reason.trim().replace(/\s+/g, " ").slice(0, 800);
  writeFileSync(
    file,
    `${plan.trimEnd()}\n\n## Deferred workflow state\n\n- Deferred-At: ${new Date().toISOString()}\n- Reason: ${boundedReason}\n- Semantic status: unresolved; this deferral is not acceptance or archive evidence.\n`,
  );
  await git(cwd, ["mv", "-f", "--", relative(cwd, file), relative(cwd, target)]);
  await git(cwd, ["commit", "-m", `chore(agent): defer issue #${expectedIssue} plan`]);

  const after = await safeLoopBoundary(cwd, true);
  if (!after.safe) {
    throw new Error(
      `Deferred plan commit did not leave a safe boundary: ${after.reason}`,
    );
  }
  return target;
}

export function registerUpdateTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_next_update",
    label: "Pi Next Update",
    description:
      "Complete or add plan tasks, manage recovery markers, archive verified work, park a semantically unresolved but authoritatively deferred plan, or report one unattended-loop step including a clean issue-local deferral.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("mark_done"),
        taskPrefix: Type.String(),
        done: Type.String(),
        rationale: Type.String(),
        findings: Type.Optional(Type.String()),
        files: Type.String(),
        commit: Type.Optional(Type.String()),
      }),
      Type.Object({
        action: Type.Literal("append_fix"),
        task: Type.String(),
        files: Type.String(),
        approach: Type.Optional(Type.String()),
      }),
      Type.Object({
        action: Type.Literal("defer_plan"),
        issueNumber: Type.Number(),
        reason: Type.String({ minLength: 1 }),
      }),
      Type.Object({ action: Type.Literal("continue_read") }),
      Type.Object({
        action: Type.Literal("continue_write"),
        source: Type.String(),
        stage: Type.String(),
        task: Type.Optional(Type.String()),
        reason: Type.String(),
      }),
      Type.Object({ action: Type.Literal("continue_clear") }),
      Type.Object({ action: Type.Literal("archive") }),
      Type.Object({
        action: Type.Literal("loop_result"),
        runId: Type.String(),
        step: Type.Number(),
        outcome: Type.Union([
          Type.Literal("continue"),
          Type.Literal("done"),
          Type.Literal("archived"),
          Type.Literal("defer_issue"),
          Type.Literal("block_issue"),
          Type.Literal("blocked"),
          Type.Literal("idle"),
          Type.Literal("failed"),
        ]),
        issueNumber: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
      }),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      const file = planFile(ctx.cwd);

      if (params.action === "mark_done") {
        const plan = readPlan(ctx.cwd);
        const prefix = required(params.taskPrefix, "taskPrefix");
        const task = currentTask(plan);
        if (!task || !task.task.startsWith(prefix)) {
          throw new Error("Only the first unchecked task may be marked done");
        }
        const log = `### ${today()} — ${task.task}\n**Done:** ${required(params.done, "done")}\n**Rationale:** ${required(params.rationale, "rationale")}\n**Findings:** ${params.findings?.trim() || "none"}\n**Files:** ${required(params.files, "files")}\n**Commit:** ${params.commit?.trim() || "not committed"}`;
        writeFileSync(file, markDone(plan, prefix, log));
        recordTransition(ctx.cwd, issueNumber(plan), "task");
        return {
          content: [{ type: "text", text: `Marked done: ${task.task}` }],
          details: { task: task.task },
        };
      }

      if (params.action === "append_fix") {
        const plan = readPlan(ctx.cwd);
        const task = required(params.task, "task");
        writeFileSync(
          file,
          appendFix(
            plan,
            task,
            required(params.files, "files"),
            params.approach?.trim() || "",
          ),
        );
        recordTransition(ctx.cwd, issueNumber(plan), "repair");
        return {
          content: [{ type: "text", text: `Appended fix task: ${task}` }],
          details: { task },
        };
      }

      if (params.action === "defer_plan") {
        const deferredIssue = Math.floor(params.issueNumber);
        if (!Number.isInteger(deferredIssue) || deferredIssue <= 0) {
          throw new Error("defer_plan requires a positive issueNumber");
        }
        const reason = required(params.reason, "reason");
        const target = await deferActivePlan(ctx.cwd, deferredIssue, reason);
        recordTransition(ctx.cwd, deferredIssue, "lifecycle");
        return {
          content: [
            {
              type: "text",
              text: `Deferred unresolved issue #${deferredIssue} plan to ${target}; semantic FAIL remains unresolved.`,
            },
          ],
          details: { issueNumber: deferredIssue, reason, parkedPlan: target },
        };
      }

      const marker = markerFile(ctx.cwd);
      if (params.action === "continue_read") {
        return {
          content: [
            {
              type: "text",
              text: existsSync(marker)
                ? readFileSync(marker, "utf8")
                : "no continue marker",
            },
          ],
          details: { exists: existsSync(marker), file: marker },
        };
      }

      if (params.action === "continue_clear") {
        if (existsSync(marker)) unlinkSync(marker);
        return {
          content: [{ type: "text", text: "continue marker cleared" }],
          details: { file: marker },
        };
      }

      if (params.action === "continue_write") {
        mkdirSync(psDir(ctx.cwd), { recursive: true });
        writeFileSync(
          marker,
          `# Continue Here\n\nsource=${required(params.source, "source")}\nstage=${required(params.stage, "stage")}\ntask=${params.task?.trim() || ""}\nreason=${required(params.reason, "reason")}\nwritten=${new Date().toISOString()}\n`,
        );
        return {
          content: [{ type: "text", text: "continue marker written" }],
          details: { file: marker },
        };
      }

      if (params.action === "loop_result") {
        if (params.outcome !== "failed") {
          const boundary = await safeLoopBoundary(
            ctx.cwd,
            params.outcome === "archived",
          );
          if (!boundary.safe) {
            throw new Error(
              `Cannot record ${params.outcome} loop result from unsafe boundary: ${boundary.reason}. Inspect drift/provenance first; commit legitimate work, safely remove only generated or clearly stale agent-owned residue, protect ambiguous changes, release the workflow lock, then retry this same loop_result without advancing the step.`,
            );
          }
        }

        const loopIssue = params.issueNumber === undefined ? issueNumber(readPlan(ctx.cwd)) : Math.floor(params.issueNumber);
        const transition: "lifecycle" | "task" | "repair" = params.outcome === "defer_issue" || params.outcome === "block_issue" || params.outcome === "archived"
          ? "lifecycle"
          : params.outcome === "done"
            ? "task"
            : "repair";
        recordTransition(ctx.cwd, loopIssue, transition);
        // The isolated child worker's own cwd is the issue worktree, not the
        // run's coordination root (#603). The parent transports the real
        // authority via PI_NEXT_COORDINATION_CWD (see
        // IssueWorkerOptions.coordinationCwd in util-core.ts); a legacy/non-
        // worktree run without that env value falls back to ctx.cwd, which
        // is already the coordination root in that case.
        const authorityCwd = process.env.PI_NEXT_COORDINATION_CWD?.trim() || ctx.cwd;
        const runId = required(params.runId, "runId");
        if (params.outcome === "archived" && loopIssue) {
          recordPiLifecycleJournal(authorityCwd, {
            event: "issue_closed",
            issueNumber: loopIssue,
            runId,
            idempotencyKey: `issue-closed:${loopIssue}`,
            payload: { workItemId: String(loopIssue) },
          });
        }
        const path = writeLoopResult(authorityCwd, {
          runId,
          step: Math.floor(params.step),
          outcome: params.outcome,
          issueNumber:
            params.issueNumber === undefined
              ? undefined
              : Math.floor(params.issueNumber),
          reason: params.reason?.trim(),
          writtenAt: new Date().toISOString(),
        });
        return {
          content: [
            { type: "text", text: `Loop result recorded: ${params.outcome}` },
          ],
          details: { path },
        };
      }

      const archived = await archiveAndCommit(ctx.cwd);
      recordTransition(ctx.cwd, archived.issue, "lifecycle");
      return {
        content: [
          {
            type: "text",
            text: `Archived issue #${archived.issue} plan to ${archived.archive}\nCommitted ${archived.hash}`,
          },
        ],
        details: {
          archivedPlan: archived.archive,
          hash: archived.hash,
          issue: archived.issue,
          authorityFingerprint: archived.authorityFingerprint,
        },
      };
    },
  });
}
