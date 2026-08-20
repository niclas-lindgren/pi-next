import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  changeFiles,
  commitExplicitPaths,
  conflictFiles,
  git,
  required,
  stagedFiles,
} from "./util.ts";
import {
  checkpointBranchName,
  checkpointCommit,
  promoteCheckpoint,
} from "./checkpoint.ts";
import type { CommitKind } from "./workflow-commit-policy.ts";

export function registerGitTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_next_git",
    label: "Pi Next Git",
    description: "Inspect Git state and commit explicit paths only.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("status") }),
      Type.Object({
        action: Type.Literal("commit"),
        paths: Type.Array(Type.String(), { minItems: 1 }),
        message: Type.String(),
        issueNumber: Type.Optional(Type.Integer({ minimum: 1 })),
        kind: Type.Optional(Type.Union([
          Type.Literal("substantive"),
          Type.Literal("workflow-only"),
          Type.Literal("lifecycle"),
        ])),
      }),
      Type.Object({
        action: Type.Literal("checkpoint_branch"),
        issueNumber: Type.Integer({ minimum: 1 }),
        runId: Type.String({ minLength: 1 }),
      }),
      Type.Object({
        action: Type.Literal("checkpoint"),
        issueNumber: Type.Integer({ minimum: 1 }),
        runId: Type.String({ minLength: 1 }),
        paths: Type.Array(Type.String(), { minItems: 1 }),
        message: Type.String(),
      }),
      Type.Object({
        action: Type.Literal("promote"),
        issueNumber: Type.Integer({ minimum: 1 }),
        runId: Type.String({ minLength: 1 }),
        expectedMainSha: Type.String({ minLength: 1 }),
        verificationPath: Type.String({ minLength: 1 }),
      }),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "checkpoint_branch") {
        const branch = checkpointBranchName(params.issueNumber, params.runId);
        return {
          content: [{ type: "text", text: branch }],
          details: { branch, issueNumber: params.issueNumber, runId: params.runId },
        };
      }

      if (params.action === "checkpoint") {
        const result = await checkpointCommit(
          ctx.cwd,
          params.issueNumber,
          params.runId,
          params.paths,
          required(params.message, "message"),
        );
        return {
          content: [{ type: "text", text: `Checkpoint ${result.hash} on ${result.branch}` }],
          details: { committed: true, ...result },
        };
      }

      if (params.action === "promote") {
        const result = await promoteCheckpoint(
          ctx.cwd,
          params.issueNumber,
          params.runId,
          required(params.expectedMainSha, "expectedMainSha"),
          required(params.verificationPath, "verificationPath"),
        );
        return {
          content: [{ type: "text", text: `Promoted ${result.branch} to main at ${result.mergeSha}` }],
          details: { promoted: true, ...result },
        };
      }

      const branch = await git(ctx.cwd, ["branch", "--show-current"]).catch(
        () => "unknown",
      );
      const files = await changeFiles(ctx.cwd, "all");
      const conflicts = await conflictFiles(ctx.cwd);
      const staged = await stagedFiles(ctx.cwd);

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text: [
                `branch=${branch}`,
                `dirty=${files.length ? "yes" : "no"}`,
                `staged=${staged.length}`,
                `conflicts=${conflicts.length}`,
                ...files,
              ].join("\n"),
            },
          ],
          details: { branch, dirty: Boolean(files.length), files, staged, conflicts },
        };
      }

      const hash = await commitExplicitPaths(
        ctx.cwd,
        params.paths,
        required(params.message, "message"),
        {
          issueNumber: params.issueNumber,
          kind: params.kind as CommitKind | undefined,
        },
      );
      return hash
        ? {
            content: [{ type: "text", text: `Committed ${hash}` }],
            details: { committed: true, hash },
          }
        : {
            content: [
              {
                type: "text",
                text: "No changes matched the explicit commit paths.",
              },
            ],
            details: { committed: false },
          };
    },
  });
}
