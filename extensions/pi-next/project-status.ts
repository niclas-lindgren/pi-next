import { failureReasonCode, recordLifecycleEvent } from "./lifecycle-telemetry";

export type ProjectStatus = "Todo" | "In Progress" | "Done" | "Blocked";

/** GitHub-backed implementations must make this operation retryable/observable. */
export interface ProjectStatusAuthority {
  set(issueNumber: number, status: ProjectStatus): Promise<void>;
}

export class ProjectStatusSyncError extends Error {
  readonly code = "project_status_sync_failed";
  constructor(readonly issueNumber: number, readonly status: ProjectStatus, cause: unknown) {
    super(`Could not synchronize issue #${issueNumber} to Project status ${status}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProjectStatusSyncError";
  }
}

export async function syncProjectStatus(
  cwd: string,
  authority: ProjectStatusAuthority,
  input: { issueNumber: number; status: ProjectStatus; runId: string; agent?: string; branch?: string; worktree?: string },
): Promise<void> {
  recordLifecycleEvent(cwd, {
    event: "project_status_sync_attempted",
    issueNumber: input.issueNumber,
    runId: input.runId,
    agent: input.agent,
    branch: input.branch,
    worktree: input.worktree,
    outcome: "success",
    reasonCode: input.status,
  });
  try {
    await authority.set(input.issueNumber, input.status);
  } catch (error) {
    recordLifecycleEvent(cwd, {
      event: "project_status_sync_failed",
      issueNumber: input.issueNumber,
      runId: input.runId,
      agent: input.agent,
      branch: input.branch,
      worktree: input.worktree,
      outcome: "failure",
      reasonCode: failureReasonCode(error instanceof Error ? error.message : String(error)),
    });
    throw new ProjectStatusSyncError(input.issueNumber, input.status, error);
  }
  recordLifecycleEvent(cwd, {
    event: "project_status_synced",
    issueNumber: input.issueNumber,
    runId: input.runId,
    agent: input.agent,
    branch: input.branch,
    worktree: input.worktree,
    outcome: "success",
    reasonCode: input.status,
  });
}
