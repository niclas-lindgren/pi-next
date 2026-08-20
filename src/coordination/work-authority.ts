/**
 * Work-authority adapter boundary.
 *
 * Scheduling and freshness consume this interface rather than knowing how a
 * project stores work items.  GitHub is only one adapter; the in-memory
 * adapter is intentionally small and useful for consumer integration tests.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PiNextConfig } from "./config.ts";
import type { SelfAssessmentFinding } from "./self-assessment.ts";

const execFileAsync = promisify(execFile);
const PENDING_VERIFICATION_MARKER = "<!-- pi-next-pending-verification -->";

function pendingVerificationComment(record: PendingVerificationRecord): string {
  return `${PENDING_VERIFICATION_MARKER}\n${JSON.stringify(record)}`;
}

export interface AuthorityComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorityWorkItem {
  /** Adapter-native stable identity. */
  id: string;
  /** Numeric identity used by the legacy issue worktree boundary, when any. */
  number?: number;
  title: string;
  body: string;
  state: string;
  updatedAt?: string;
  priority?: string;
  states: string[];
  comments: AuthorityComment[];
}

export interface AuthorityCapabilities {
  discovery: boolean;
  freshness: boolean;
  completion: boolean;
  /** Optional capability for recording an open, post-integration verification state. */
  pendingVerification?: boolean;
  atomicOwnership: boolean;
  projectStatus: boolean;
}

export interface PendingVerificationCriterion {
  /** Consumer-defined stable identity for this pending check. */
  id: string;
  /** Human-readable, explicit criterion retained by the authority adapter. */
  description: string;
}

export interface PendingVerificationRecord {
  version: 1;
  criteria: readonly PendingVerificationCriterion[];
  /** Exact origin/main revision that was integrated and reachability-proven. */
  integratedMainSha: string;
}

export interface WorkAuthorityAdapter {
  readonly name: string;
  readonly capabilities: Readonly<AuthorityCapabilities>;
  listCandidates(config: PiNextConfig): Promise<AuthorityWorkItem[]>;
  get(id: string): Promise<AuthorityWorkItem>;
  fingerprint(item: AuthorityWorkItem): string;
  /** Terminal completion: mark a work item done and record the closing comment. Requires `capabilities.completion`. */
  close(id: string, comment: string): Promise<void>;
  /** Record structured post-integration checks while leaving the work item open. Requires `capabilities.pendingVerification`. */
  markPendingVerification?(id: string, record: PendingVerificationRecord): Promise<void>;
  /** Optional, thresholded governance surface. Never required for scheduling. */
  publishFinding?(finding: SelfAssessmentFinding, config: Pick<PiNextConfig, "assessment">): Promise<{ id: string; url?: string }>;
  updateFinding?(id: string, finding: SelfAssessmentFinding, config: Pick<PiNextConfig, "assessment">): Promise<{ id: string; url?: string }>;
  readFindingApproval?(id: string, config: Pick<PiNextConfig, "assessment">): Promise<SelfAssessmentFinding["approvalState"]>;
  /** Optional adapter-owned projection of explicit requirement/decision comments. */
  projectRequirements?(item: AuthorityWorkItem): readonly string[];
}

/**
 * Extract only explicitly marked requirement/decision material from comments.
 * Ordinary discussion, status updates, and noise are intentionally ignored.
 * Adapters may provide a stricter domain-specific projector instead.
 */
export function extractAuthorityCommentRequirements(comments: readonly AuthorityComment[]): string[] {
  const output: string[] = [];
  for (const comment of comments) {
    const lines = comment.body.split(/\r?\n/);
    let section = false;
    let sectionLevel = 0;
    for (const line of lines) {
      const heading = line.match(/^(#{1,6})\s+(acceptance criteria|requirements?|authoritative decisions?|decisions?)\s*:?[ \t]*$/i);
      if (heading) {
        section = true;
        sectionLevel = heading[1].length;
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) {
        const level = line.match(/^#+/)?.[0].length || 0;
        if (section && level <= sectionLevel) section = false;
      }
      const checkbox = section ? line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/) : null;
      const explicit = line.match(/^\s*(?:[-*]\s*)?(requirement|decision|authoritative decision|must|shall)\s*:\s*(.+?)\s*$/i);
      const value = checkbox?.[1] || (explicit ? `${explicit[1]}: ${explicit[2]}` : undefined);
      if (value?.trim()) output.push(value.trim());
    }
  }
  return [...new Set(output.map((value) => value.trim()).filter(Boolean))];
}

export class AuthorityCapabilityError extends Error {
  readonly code = "authority_capability_missing";
  constructor(readonly adapter: string, readonly capability: keyof AuthorityCapabilities) {
    super(`Authority adapter ${adapter} does not provide required capability: ${capability}`);
    this.name = "AuthorityCapabilityError";
  }
}

export function requireAuthorityCapability(
  adapter: WorkAuthorityAdapter,
  capability: keyof AuthorityCapabilities,
): void {
  if (!adapter.capabilities[capability]) throw new AuthorityCapabilityError(adapter.name, capability);
}

function normalized(item: AuthorityWorkItem): string {
  return JSON.stringify({
    id: item.id,
    number: item.number ?? null,
    title: item.title,
    body: item.body,
    state: item.state,
    updatedAt: item.updatedAt ?? "",
    priority: item.priority ?? "",
    states: [...item.states].sort(),
    comments: item.comments.map((comment) => ({ ...comment })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function authorityFingerprint(item: AuthorityWorkItem): string {
  return createHash("sha256").update(normalized(item)).digest("hex");
}

function parseLabels(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((value) => (value && typeof value === "object" ? String((value as Record<string, unknown>).name || "") : "")).filter(Boolean)
    : [];
}

function authorityStateMatches(states: readonly string[], wanted: string): boolean {
  const normalized = wanted.trim().toLowerCase();
  return states.some((state) => {
    const value = state.trim().toLowerCase();
    return value === normalized || value.replace(/^status:/, "") === normalized.replace(/^status:/, "");
  });
}

function parseComments(raw: unknown): AuthorityComment[] {
  return Array.isArray(raw)
    ? raw.map((value) => {
        const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const author = item.author && typeof item.author === "object" ? String((item.author as Record<string, unknown>).login || "") : "";
        return {
          id: String(item.id || item.url || ""),
          author,
          body: String(item.body || ""),
          createdAt: String(item.createdAt || ""),
          updatedAt: String(item.updatedAt || ""),
        };
      })
    : [];
}

function fromGitHub(raw: Record<string, unknown>): AuthorityWorkItem {
  const labels = parseLabels(raw.labels);
  const number = Number(raw.number || 0);
  const priority = labels.find((label) => label.startsWith("priority:"))?.slice("priority:".length).trim();
  return {
    id: Number.isSafeInteger(number) && number > 0 ? String(number) : String(raw.id || ""),
    number: Number.isSafeInteger(number) && number > 0 ? number : undefined,
    title: String(raw.title || ""),
    body: String(raw.body || ""),
    state: String(raw.state || ""),
    updatedAt: String(raw.updatedAt || "") || undefined,
    priority,
    states: labels,
    comments: parseComments(raw.comments),
  };
}

/** GitHub Issues adapter. It owns transport/normalization, not scheduling policy. */
export class GitHubWorkAuthority implements WorkAuthorityAdapter {
  readonly name = "github";
  readonly capabilities = Object.freeze({
    discovery: true,
    freshness: true,
    completion: true,
    pendingVerification: true,
    // Ownership is provided by the separate lease CAS authority.
    atomicOwnership: false,
    projectStatus: false,
  });
  private readonly cache = new Map<string, AuthorityWorkItem>();

  constructor(private readonly cwd = process.cwd()) {}

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  }

  async listCandidates(config: PiNextConfig): Promise<AuthorityWorkItem[]> {
    const result: AuthorityWorkItem[] = [];
    for (const priority of config.selection.priorities) {
      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "list", "--state", "open", "--label", `priority: ${priority}`, "--limit", "100", "--json", "number,title,state,updatedAt,labels"],
        { cwd: this.cwd, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      );
      const issues = JSON.parse(stdout) as unknown;
      if (!Array.isArray(issues)) throw new Error("Authority adapter returned a non-array candidate response");
      for (const raw of issues) {
        if (!raw || typeof raw !== "object") throw new Error("Authority adapter returned an invalid work item");
        const item = fromGitHub(raw as Record<string, unknown>);
        item.priority = item.priority || priority;
        this.cache.set(item.id, item);
        result.push(item);
      }
    }
    return result;
  }

  async get(id: string): Promise<AuthorityWorkItem> {
    const stdout = await this.gh(["issue", "view", id, "--json", "number,title,body,state,updatedAt,labels,comments"]);
    const value = JSON.parse(stdout);
    if (!value || typeof value !== "object") throw new Error("Authority adapter returned an invalid work item");
    const item = fromGitHub(value as Record<string, unknown>);
    this.cache.set(item.id, item);
    return item;
  }

  fingerprint(item: AuthorityWorkItem): string {
    return authorityFingerprint(item);
  }

  projectRequirements(item: AuthorityWorkItem): readonly string[] {
    return extractAuthorityCommentRequirements(item.comments);
  }

  async close(id: string, comment: string): Promise<void> {
    await this.gh(["issue", "close", id, "--comment", comment]);
    this.cache.delete(id);
  }

  async markPendingVerification(id: string, record: PendingVerificationRecord): Promise<void> {
    const comment = pendingVerificationComment(record);
    const item = await this.get(id);
    if (item.comments.some((entry) => entry.body === comment)) return;
    await this.gh(["issue", "comment", id, "--body", comment]);
    this.cache.delete(id);
  }

  private async verifyFindingGovernance(
    id: string,
    config: Pick<PiNextConfig, "assessment">,
  ): Promise<AuthorityWorkItem> {
    const item = await this.get(id);
    const states = item.states;
    const hasFindingLabel = config.assessment.findingLabels.some((label) => authorityStateMatches(states, label));
    const isHeld = config.assessment.heldStates.some((state) => authorityStateMatches(states, state));
    const isApproved = config.assessment.approvedStates.some((state) => authorityStateMatches(states, state));
    if (!hasFindingLabel || (!isHeld && !isApproved)) {
      throw new Error(`Published self-assessment finding ${id} is missing its configured held/approved authority state`);
    }
    return item;
  }

  async publishFinding(
    finding: SelfAssessmentFinding,
    config: Pick<PiNextConfig, "assessment">,
  ): Promise<{ id: string; url?: string }> {
    // Search by the stable fingerprint before creating anything. This closes
    // the crash window between authority creation and local persistence.
    let existing: unknown;
    try {
      existing = JSON.parse(await this.gh([
        "issue", "list", "--state", "all", "--search", `${finding.fingerprint} in:body`,
        "--limit", "10", "--json", "number,url",
      ]));
    } catch {
      // A search failure must not turn a local finding into a lifecycle
      // failure; the create call below remains thresholded and bounded.
    }
    if (Array.isArray(existing) && existing.length) {
      const first = existing[0] as Record<string, unknown>;
      const result = { id: String(first.number || finding.fingerprint), url: typeof first.url === "string" ? first.url : undefined };
      await this.verifyFindingGovernance(result.id, config);
      return result;
    }

    const priority = finding.severity === "P0" || finding.severity === "P1" ? finding.severity : "P2";
    const body = [
      "<!-- pi-next-self-assessment -->",
      `fingerprint: ${finding.fingerprint}`,
      `category: ${finding.category}`,
      `severity: ${finding.severity}`,
      `confidence: ${finding.confidence}`,
      `approvalState: ${finding.approvalState}`,
      "",
      "## Evidence",
      ...finding.evidence.slice(0, 8).map((item) => `- ${item}`),
      "",
      `## Proposed action\n${finding.proposedAction}`,
      "",
      "This finding is held for human review. It is not eligible for autonomous selection until explicitly approved.",
    ].join("\n").slice(0, 8_000);
    const labels = [...config.assessment.findingLabels, ...config.assessment.heldStates];
    const output = await this.gh([
      "issue", "create", "--title", `[pi-next finding] ${finding.title}`,
      "--body", body,
      ...labels.flatMap((label) => ["--label", label]),
      "--label", `priority: ${priority}`,
    ]);
    const url = output.trim().split(/\s+/).find((value) => /^https?:\/\//.test(value));
    const id = url ? url.split("/").pop() || finding.fingerprint : finding.fingerprint;
    await this.verifyFindingGovernance(id, config);
    return { id, url };
  }

  async updateFinding(
    id: string,
    finding: SelfAssessmentFinding,
    config: Pick<PiNextConfig, "assessment">,
  ): Promise<{ id: string; url?: string }> {
    const item = await this.verifyFindingGovernance(id, config);
    const evidence = finding.evidence.slice(0, 8);
    const revision = createHash("sha256")
      .update(JSON.stringify({ recurrence: finding.recurrence, evidence, proposedAction: finding.proposedAction }))
      .digest("hex");
    const marker = `<!-- pi-next-finding-update:${revision} -->`;
    if (item.comments.some((comment) => comment.body.includes(marker))) return { id };
    const comment = `${marker}\nUpdated pi-next finding **${finding.fingerprint}** (recurrence ${finding.recurrence}).\n\n${evidence.map((entry) => `- ${entry}`).join("\n")}`;
    await this.gh(["issue", "comment", id, "--body", comment.slice(0, 4_000)]);
    return { id };
  }

  async readFindingApproval(
    id: string,
    config: Pick<PiNextConfig, "assessment">,
  ): Promise<SelfAssessmentFinding["approvalState"]> {
    const item = await this.get(id);
    if (config.assessment.supersededStates.some((state) => authorityStateMatches(item.states, state))) return "superseded";
    if (config.assessment.rejectedStates.some((state) => authorityStateMatches(item.states, state))) return "rejected";
    if (config.assessment.approvedStates.some((state) => authorityStateMatches(item.states, state))) return "approved";
    return "pending_review";
  }
}

/** A minimal non-GitHub adapter for consumer and core lifecycle tests. */
export class InMemoryWorkAuthority implements WorkAuthorityAdapter {
  readonly name = "memory";
  readonly capabilities = Object.freeze({
    discovery: true,
    freshness: true,
    completion: true,
    pendingVerification: true,
    atomicOwnership: false,
    projectStatus: false,
  });
  private readonly items = new Map<string, AuthorityWorkItem>();

  constructor(items: readonly AuthorityWorkItem[] = []) {
    for (const item of items) this.items.set(item.id, structuredClone(item));
  }

  async listCandidates(config: PiNextConfig): Promise<AuthorityWorkItem[]> {
    const priorities = new Set(config.selection.priorities);
    return [...this.items.values()].filter((item) => item.state.toLowerCase() === "open" && (!item.priority || priorities.has(item.priority)));
  }

  async get(id: string): Promise<AuthorityWorkItem> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    return structuredClone(item);
  }

  fingerprint(item: AuthorityWorkItem): string {
    return authorityFingerprint(item);
  }

  async close(id: string, comment: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    const now = new Date().toISOString();
    item.state = "closed";
    item.comments = [
      ...item.comments,
      { id: `close-${id}-${item.comments.length}`, author: "system", body: comment, createdAt: now, updatedAt: now },
    ];
  }

  async markPendingVerification(id: string, record: PendingVerificationRecord): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    const body = pendingVerificationComment(record);
    if (item.comments.some((comment) => comment.body === body)) return;
    const now = new Date().toISOString();
    item.comments = [
      ...item.comments,
      { id: `pending-verification-${id}-${item.comments.length}`, author: "system", body, createdAt: now, updatedAt: now },
    ];
  }

  upsert(item: AuthorityWorkItem): void {
    this.items.set(item.id, structuredClone(item));
  }
}

export function createWorkAuthority(cwd: string, config: PiNextConfig): WorkAuthorityAdapter {
  switch (config.authority.adapter) {
    case "github":
      return new GitHubWorkAuthority(cwd);
    case "memory":
      return new InMemoryWorkAuthority();
    default:
      throw new Error(`Unsupported authority adapter: ${config.authority.adapter}`);
  }
}
