import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { createWorkerDispatch, type WorkerRole } from "../coordination/worker-dispatch.ts";

export type ContextStrategyId =
  | "default"
  | "minimal"
  | "no-controller-context"
  | "repo-map"
  | "selective-skills"
  | "resolver"
  | "expanded-skill-registry"
  | "verification-discipline";

export interface SkillRegistryEntry {
  id: string;
  title: string;
  source: string;
  version: string;
  file?: string;
  appliesToRoles: readonly WorkerRole[];
  keywords?: readonly string[];
  mandatory?: boolean;
  context: string;
}

export interface ResolvedSkillContext {
  available: number;
  selected: Array<{ id: string; reason: "mandatory" | "deterministic-rule" | "explicit-policy"; provenance: string }>;
  loaded: Array<{ id: string; source: string; version: string; estimatedTokens: number }>;
  totalEstimatedTokens: number;
}

export interface RepoMapOptions { maxBytes?: number; maxFiles?: number }
export interface BuiltContextPacket {
  strategy: ContextStrategyId;
  prompt: string;
  estimatedPromptTokens: number;
  repoMap?: { bytes: number; files: number; maxBytes: number; maxFiles: number };
  skills: ResolvedSkillContext;
}

const DEFAULT_REPO_MAP_MAX_BYTES = 3_000;
const DEFAULT_REPO_MAP_MAX_FILES = 40;

export const reviewedSkillRegistry: readonly SkillRegistryEntry[] = [
  {
    id: "matt-pocock.tdd",
    title: "TDD / tests-first implementation",
    source: "Matt Pocock skill catalog (managed snapshot)",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["implementation", "repair"],
    keywords: ["test", "behavior", "contract", "regression", "generated"],
    context: "When tests are relevant, make or update the smallest failing/passing test signal, implement the behavior, then run the configured test command before stopping.",
  },
  {
    id: "matt-pocock.diagnosing-bugs",
    title: "Diagnosing bugs",
    source: "Matt Pocock skill catalog (managed snapshot)",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["repair"],
    keywords: ["bug", "failure", "fails", "repair", "broken"],
    context: "For repair tasks, reproduce the observed failure, identify the narrow broken path, fix that path, and keep the regression command as evidence.",
  },
  {
    id: "matt-pocock.codebase-design",
    title: "Codebase design",
    source: "Matt Pocock skill catalog (managed snapshot)",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["planning", "review-standards"],
    keywords: ["design", "architecture", "refactor"],
    context: "Prefer local cohesion and explicit module boundaries; avoid broad rewrites when the task asks for a bounded change.",
  },
  {
    id: "pi-next.code-review-spec",
    title: "Spec-conformance review discipline",
    source: "Pi-next adaptation of Matt Pocock code-review; kernel owns orchestration",
    version: "2026-08-issue-172-spec-adapter",
    appliesToRoles: ["review-spec"],
    context: "Review only the exact bound candidate/fixed point against authoritative issue/spec evidence. Do not ask for inputs, spawn standards review, or aggregate axes.",
  },
  {
    id: "pi-next.code-review-standards",
    title: "Standards review discipline",
    source: "Pi-next adaptation of Matt Pocock code-review; kernel owns orchestration",
    version: "2026-08-issue-172-standards-adapter",
    appliesToRoles: ["review-standards"],
    context: "Review only engineering standards/design/test/regression risks for the exact bound candidate/fixed point. Do not ask for inputs, spawn spec review, or aggregate axes.",
  },
  {
    id: "matt-pocock.performance-telemetry",
    title: "Performance telemetry",
    source: "Matt Pocock skill catalog (managed snapshot)",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["maintenance"],
    keywords: ["performance", "telemetry", "benchmark", "tokens", "cost"],
    context: "Keep measurements comparable, attribute costs where possible, and prefer simple bounded instrumentation over speculative optimization.",
  },
  {
    id: "superpowers.verification-before-completion",
    title: "Verification before completion discipline",
    source: "Superpowers individual discipline review; process/bootstrap intentionally not imported",
    version: "2026-08-issue-82-adapter",
    appliesToRoles: ["implementation", "repair", "verification"],
    keywords: ["verify", "test", "generated", "contract", "before stopping"],
    context: "Before declaring the task done, run the most relevant configured verification command or state exactly why it could not be run. Do not treat this discipline as workflow ownership.",
  },
  {
    id: "expanded.frontend-browser-checks",
    title: "Frontend/browser verification",
    source: "Reviewed expanded availability placeholder; not selected without matching task",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["implementation", "verification"],
    keywords: ["browser", "frontend", "ui", "css", "react"],
    context: "For browser-facing tasks, verify rendered behavior using the configured project browser checks.",
  },
  {
    id: "expanded.security-review",
    title: "Security review",
    source: "Reviewed expanded availability placeholder; mandatory only at configured security boundary",
    version: "2026-08-issue-82-reviewed",
    appliesToRoles: ["implementation", "review-standards", "verification"],
    keywords: ["security", "auth", "token", "secret", "permission"],
    context: "Preserve security constraints, avoid leaking secrets, and verify authorization-sensitive behavior where the task touches those paths.",
  },
];

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function keywordMatches(entry: SkillRegistryEntry, task: string): boolean {
  return (entry.keywords ?? []).some((keyword) => task.toLowerCase().includes(keyword.toLowerCase()));
}

export function resolveSkillContext(options: {
  role: WorkerRole;
  task: string;
  strategy: ContextStrategyId;
  registry?: readonly SkillRegistryEntry[];
}): ResolvedSkillContext {
  const registry = options.registry ?? reviewedSkillRegistry;
  if (options.strategy === "minimal" || options.strategy === "no-controller-context" || options.strategy === "repo-map") {
    return { available: registry.length, selected: [], loaded: [], totalEstimatedTokens: 0 };
  }
  const selected = new Map<string, { entry: SkillRegistryEntry; reason: "mandatory" | "deterministic-rule" | "explicit-policy" }>();
  const reviewBindings = options.role === "review-spec"
    ? { authorityFingerprint: "eval-authority", candidateSha: "eval-candidate", fixedPointSha: "eval-fixed", boundInputs: { specEvidence: "eval spec fixture" } }
    : options.role === "review-standards"
      ? { authorityFingerprint: "eval-authority", candidateSha: "eval-candidate", fixedPointSha: "eval-fixed", boundInputs: { standardsSources: "eval standards fixture" } }
      : {};
  const dispatch = createWorkerDispatch({ phase: options.role, task: options.task, hasPlan: true, ...reviewBindings });
  for (const skill of dispatch.skills) {
    const id = skill === "tdd" ? "matt-pocock.tdd" : skill === "diagnosing-bugs" ? "matt-pocock.diagnosing-bugs" : skill === "codebase-design" ? "matt-pocock.codebase-design" : skill === "code-review-spec" ? "pi-next.code-review-spec" : skill === "code-review-standards" ? "pi-next.code-review-standards" : "matt-pocock.performance-telemetry";
    const entry = registry.find((candidate) => candidate.id === id);
    if (entry) selected.set(entry.id, { entry, reason: "deterministic-rule" });
  }
  if (options.strategy === "verification-discipline") {
    const entry = registry.find((candidate) => candidate.id === "superpowers.verification-before-completion");
    if (entry) selected.set(entry.id, { entry, reason: "explicit-policy" });
  }
  if (options.strategy === "resolver" || options.strategy === "expanded-skill-registry") {
    for (const entry of registry) {
      if (entry.id === "superpowers.verification-before-completion") continue;
      if (entry.mandatory && entry.appliesToRoles.includes(options.role)) selected.set(entry.id, { entry, reason: "mandatory" });
      else if (entry.appliesToRoles.includes(options.role) && keywordMatches(entry, options.task)) selected.set(entry.id, { entry, reason: "deterministic-rule" });
    }
  }
  const loaded = [...selected.values()].map(({ entry }) => ({ id: entry.id, source: entry.source, version: entry.version, estimatedTokens: estimateTokens(entry.context) }));
  return {
    available: registry.length,
    selected: [...selected.values()].map(({ entry, reason }) => ({ id: entry.id, reason, provenance: `${entry.source}@${entry.version}` })),
    loaded,
    totalEstimatedTokens: loaded.reduce((sum, skill) => sum + skill.estimatedTokens, 0),
  };
}

async function walkFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(root, path, out);
    else out.push(relative(root, path));
  }
  return out.sort();
}

export async function buildBoundedRepoMap(cwd: string, task: string, options: RepoMapOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_REPO_MAP_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_REPO_MAP_MAX_FILES;
  const words = new Set(task.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []);
  const files = (await walkFiles(cwd)).slice(0, 500);
  const scored = await Promise.all(files.map(async (file) => {
    const s = await stat(join(cwd, file));
    const pathScore = [...words].filter((word) => file.toLowerCase().includes(word)).length * 5;
    let symbolScore = 0;
    let symbols = "";
    if (s.size <= 20_000 && /\.(ts|tsx|js|mjs|md|json)$/.test(file)) {
      const text = await readFile(join(cwd, file), "utf8");
      symbolScore = [...words].filter((word) => text.toLowerCase().includes(word)).length;
      symbols = [...text.matchAll(/(?:export\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g)].slice(0, 6).map((m) => m[1]).join(", ");
    }
    return { file, size: s.size, score: pathScore + symbolScore, symbols };
  }));
  const ranked = scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, maxFiles);
  let output = `Bounded repository map (Aider-style structural sketch; budget ${maxBytes} bytes/${maxFiles} files; not authority):\n`;
  let count = 0;
  for (const item of ranked) {
    const line = `- ${item.file}${item.symbols ? ` :: ${item.symbols}` : ""}\n`;
    if (Buffer.byteLength(output + line, "utf8") > maxBytes) break;
    output += line;
    count += 1;
  }
  return `${output}Repo-map files included: ${count}.\n`;
}

export async function buildContextPacket(options: { cwd: string; task: string; strategy: ContextStrategyId; role?: WorkerRole }): Promise<BuiltContextPacket> {
  const role = options.role ?? "implementation";
  const constraints = options.strategy === "default"
    ? [
      "Work only in the supplied cwd.",
      "Do not use gh, git push, git merge, branch/worktree operations, or lifecycle authority actions.",
      "Worker prose is not graded; make the repository correct.",
      "Prefer running npm test before stopping.",
    ]
    : [
      "Work only in the supplied cwd.",
      "Make the repository correct for the task; worker prose is not graded.",
      "Run the relevant project check when practical.",
    ];
  const repoMap = options.strategy === "repo-map" ? await buildBoundedRepoMap(options.cwd, options.task) : "";
  const skills = resolveSkillContext({ role, task: options.task, strategy: options.strategy });
  const skillText = skills.loaded.length
    ? `\nSelected skill context (available ${skills.available}, loaded ${skills.loaded.length}):\n${skills.loaded.map((skill) => `- ${skill.id} (${skill.estimatedTokens} est tokens): ${reviewedSkillRegistry.find((entry) => entry.id === skill.id)?.context}`).join("\n")}\n`
    : `\nSelected skill context: none loaded (available ${skills.available}).\n`;
  const prompt = [
    "You are an implementation worker for an isolated disposable TypeScript/git canary fixture.",
    `Task: ${options.task}`,
    "Constraints:",
    ...constraints.map((constraint) => `- ${constraint}`),
    repoMap ? `\n${repoMap}` : "",
    skillText,
  ].filter(Boolean).join("\n") + "\n";
  return {
    strategy: options.strategy,
    prompt,
    estimatedPromptTokens: estimateTokens(prompt),
    repoMap: repoMap ? { bytes: Buffer.byteLength(repoMap, "utf8"), files: Number(repoMap.match(/Repo-map files included: (\d+)/)?.[1] ?? 0), maxBytes: DEFAULT_REPO_MAP_MAX_BYTES, maxFiles: DEFAULT_REPO_MAP_MAX_FILES } : undefined,
    skills,
  };
}
