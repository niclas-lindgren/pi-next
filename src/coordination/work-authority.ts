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

const execFileAsync = promisify(execFile);

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
  atomicOwnership: boolean;
  projectStatus: boolean;
}

export interface WorkAuthorityAdapter {
  readonly name: string;
  readonly capabilities: Readonly<AuthorityCapabilities>;
  listCandidates(config: PiNextConfig): Promise<AuthorityWorkItem[]>;
  get(id: string): Promise<AuthorityWorkItem>;
  fingerprint(item: AuthorityWorkItem): string;
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
}

/** A minimal non-GitHub adapter for consumer and core lifecycle tests. */
export class InMemoryWorkAuthority implements WorkAuthorityAdapter {
  readonly name = "memory";
  readonly capabilities = Object.freeze({
    discovery: true,
    freshness: true,
    completion: true,
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
