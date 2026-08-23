/**
 * Deterministic, adapter-neutral skill registry and task-aware resolver.
 * Kernel boundary between an installed/reviewed catalog (available) and the
 * subset selected for one dispatch (selected); the adapter loads only selected
 * content (loaded). Installed-but-unselected skills add no worker-context
 * payload. Free of host/filesystem APIs so every adapter sees one contract.
 */
import type { WorkerRole } from "./worker-dispatch.ts";

export const SKILL_ROUTING_POLICY_VERSION = 1 as const;

export const SKILL_TIERS = ["mandatory", "automatic", "explicit"] as const;
export type SkillTier = (typeof SKILL_TIERS)[number];

export const RISK_CLASSES = ["low", "normal", "high", "critical"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** One reviewed, available skill and its routing identity. */
export interface SkillRegistryEntry {
  /** Stable skill identifier used in dispatch and telemetry. */
  id: string;
  /** Methodology category identity; two distinct skills sharing a category are
   * the same axis and must not be auto-loaded together. */
  category: string;
  /** Origin source name, e.g. `pi-next` or a pinned upstream source. */
  source: string;
  /** Exact immutable provenance version (revision or package version). */
  provenanceVersion: string;
  /** Optional routing capabilities/metadata. */
  capabilities?: string[];
  /** Framework/process-owner discipline: present but never routed
   * automatically/mandatory. Fails closed. */
  processOwner?: boolean;
}

export interface SkillRegistry {
  /** Deterministic fingerprint of the available catalog. */
  version: string;
  entries: SkillRegistryEntry[];
}

export interface SkillAutomaticRule {
  skill: string;
  roles?: WorkerRole[];
  risk?: RiskClass[];
  /** Case-insensitive regex source matched against the task text. */
  taskPattern?: string;
  /** Substrings matched against dispatch repository paths. */
  paths?: string[];
  reason?: string;
}

export interface SkillMandatoryRule {
  skill: string;
  roles?: WorkerRole[];
  risk?: RiskClass[];
  reason?: string;
}

export interface SkillRoutingPolicy {
  version: typeof SKILL_ROUTING_POLICY_VERSION;
  mandatory: SkillMandatoryRule[];
  automatic: SkillAutomaticRule[];
  /** Skills available only when explicitly requested by policy/operator/plan. */
  explicit: string[];
}

export interface SkillResolutionInput {
  role: WorkerRole;
  task?: string;
  risk?: RiskClass;
  paths?: string[];
  /** Explicit-tier requests from operator/planning decision. */
  requestedSkills?: string[];
}

export interface ResolvedSkill {
  id: string;
  source: string;
  category: string;
  provenanceVersion: string;
  tier: SkillTier;
  reason: string;
}

export interface SkillResolution {
  registryVersion: string;
  availableCount: number;
  selected: ResolvedSkill[];
}

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

function fail(message: string): never {
  throw new SkillRegistryError(message);
}

/** Stable, dependency-free fingerprint (FNV-1a over canonical JSON). */
function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    }
    return input;
  };
  const text = JSON.stringify(canonical(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Package-owned built-in registry; consumers may extend with pinned sources. */
export const BUILT_IN_SKILL_REGISTRY_ENTRIES: readonly SkillRegistryEntry[] = Object.freeze([
  { id: "code-review", category: "code-review", source: "mattpocock", provenanceVersion: "885e2ca4d842d139e9aef4e48d366c63cb1b8013" },
  { id: "tdd", category: "tdd", source: "mattpocock", provenanceVersion: "885e2ca4d842d139e9aef4e48d366c63cb1b8013" },
  { id: "diagnosing-bugs", category: "debugging", source: "mattpocock", provenanceVersion: "885e2ca4d842d139e9aef4e48d366c63cb1b8013" },
  { id: "codebase-design", category: "design", source: "mattpocock", provenanceVersion: "885e2ca4d842d139e9aef4e48d366c63cb1b8013" },
  { id: "performance-telemetry", category: "performance", source: "pi-next", provenanceVersion: "pi-next" },
  { id: "verification-before-completion", category: "verification", source: "pi-next", provenanceVersion: "pi-next", capabilities: ["terminal-verification"] },
] as unknown as SkillRegistryEntry[]);

/** Build a registry, rejecting duplicate ids, and compute its fingerprint. */
export function buildSkillRegistry(entries: readonly SkillRegistryEntry[]): SkillRegistry {
  const ids = new Set<string>();
  const normalized = entries.map((entry) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)) fail(`invalid skill id: ${entry.id}`);
    if (ids.has(entry.id)) fail(`duplicate skill id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.category.trim()) fail(`skill ${entry.id} must declare a methodology category`);
    if (!entry.source.trim()) fail(`skill ${entry.id} must declare a source`);
    if (!entry.provenanceVersion.trim()) fail(`skill ${entry.id} must declare a provenance version`);
    return {
      id: entry.id,
      category: entry.category,
      source: entry.source,
      provenanceVersion: entry.provenanceVersion,
      ...(entry.capabilities && entry.capabilities.length ? { capabilities: [...entry.capabilities] } : {}),
      ...(entry.processOwner ? { processOwner: true as const } : {}),
    };
  });
  const sorted = [...normalized].sort((a, b) => a.id.localeCompare(b.id));
  return { version: fingerprint(sorted), entries: normalized };
}

export function builtInSkillRegistry(): SkillRegistry {
  return buildSkillRegistry(BUILT_IN_SKILL_REGISTRY_ENTRIES);
}

function registryIndex(registry: SkillRegistry): Map<string, SkillRegistryEntry> {
  return new Map(registry.entries.map((entry) => [entry.id, entry]));
}

/**
 * Validate a routing policy against the available registry. Fails closed on
 * unknown/unavailable skills, process-owner skills routed automatically, and
 * competing methodologies sharing a category.
 */
export function validateSkillRoutingPolicy(policy: SkillRoutingPolicy, registry: SkillRegistry): void {
  if (policy.version !== SKILL_ROUTING_POLICY_VERSION) fail(`skill routing policy version must be ${SKILL_ROUTING_POLICY_VERSION}`);
  const index = registryIndex(registry);

  const requireAvailable = (id: string, tier: SkillTier): SkillRegistryEntry => {
    const entry = index.get(id);
    if (!entry) fail(`${tier} skill "${id}" is not present in the reviewed registry`);
    if (entry.processOwner) fail(`process-owner skill "${id}" cannot be routed as ${tier}; adopt an individual discipline instead`);
    return entry;
  };

  const assertNoCategoryConflict = (skills: string[], tier: SkillTier): void => {
    const byCategory = new Map<string, Set<string>>();
    for (const id of skills) {
      const entry = index.get(id);
      if (!entry) continue;
      const set = byCategory.get(entry.category) ?? new Set<string>();
      set.add(entry.id);
      byCategory.set(entry.category, set);
    }
    for (const [category, distinct] of byCategory) {
      if (distinct.size > 1) {
        fail(`${tier} routing has competing ${category} methodologies: ${[...distinct].sort().join(", ")}. Choose one canonical skill per category.`);
      }
    }
  };

  for (const rule of policy.mandatory) requireAvailable(rule.skill, "mandatory");
  for (const rule of policy.automatic) requireAvailable(rule.skill, "automatic");
  for (const id of policy.explicit) {
    const entry = index.get(id);
    if (!entry) fail(`explicit skill "${id}" is not present in the reviewed registry`);
  }
  assertNoCategoryConflict(policy.mandatory.map((rule) => rule.skill), "mandatory");
  assertNoCategoryConflict(policy.automatic.map((rule) => rule.skill), "automatic");
}

function matchesRole(rule: { roles?: WorkerRole[] }, role: WorkerRole): boolean {
  return !rule.roles || rule.roles.length === 0 || rule.roles.includes(role);
}

function matchesRisk(rule: { risk?: RiskClass[] }, risk?: RiskClass): boolean {
  if (!rule.risk || rule.risk.length === 0) return true;
  return risk !== undefined && rule.risk.includes(risk);
}

function matchesTask(rule: SkillAutomaticRule, task?: string): boolean {
  if (!rule.taskPattern) return true;
  if (!task) return false;
  return new RegExp(rule.taskPattern, "i").test(task);
}

function matchesPaths(rule: SkillAutomaticRule, paths?: string[]): boolean {
  if (!rule.paths || rule.paths.length === 0) return true;
  if (!paths || paths.length === 0) return false;
  return rule.paths.some((needle) => paths.some((path) => path.includes(needle)));
}

/**
 * Deterministically resolve the selected skill set for one dispatch. Same input
 * always yields the same ordered resolution. Precedence mandatory > automatic >
 * explicit; the first tier to claim a category wins and later duplicates drop.
 */
export function resolveSkills(
  registry: SkillRegistry,
  policy: SkillRoutingPolicy,
  input: SkillResolutionInput,
): SkillResolution {
  const index = registryIndex(registry);
  const selected: ResolvedSkill[] = [];
  const seenIds = new Set<string>();
  const seenCategories = new Set<string>();

  const consider = (id: string, tier: SkillTier, reason: string): void => {
    const entry = index.get(id);
    if (!entry) return; // available != loaded; unknown/unavailable ids are never loaded
    if (entry.processOwner && tier !== "explicit") return; // fail closed for process owners
    if (seenIds.has(entry.id)) return;
    if (seenCategories.has(entry.category)) return; // one canonical skill per category
    seenIds.add(entry.id);
    seenCategories.add(entry.category);
    selected.push({ id: entry.id, source: entry.source, category: entry.category, provenanceVersion: entry.provenanceVersion, tier, reason });
  };

  for (const rule of policy.mandatory) {
    if (matchesRole(rule, input.role) && matchesRisk(rule, input.risk)) {
      consider(rule.skill, "mandatory", rule.reason ?? `mandatory:${input.role}`);
    }
  }
  for (const rule of policy.automatic) {
    if (matchesRole(rule, input.role) && matchesRisk(rule, input.risk) && matchesTask(rule, input.task) && matchesPaths(rule, input.paths)) {
      consider(rule.skill, "automatic", rule.reason ?? `automatic:${input.role}`);
    }
  }
  const explicit = new Set(policy.explicit);
  for (const id of input.requestedSkills ?? []) {
    if (explicit.has(id)) consider(id, "explicit", `explicit-request:${id}`);
  }
  return { registryVersion: registry.version, availableCount: registry.entries.length, selected };
}

/**
 * Built-in automatic routing policy. Mirrors the historical role/risk selection
 * so default dispatch is preserved while tiers/provenance/conflicts are explicit.
 */
export const DEFAULT_SKILL_ROUTING_POLICY: SkillRoutingPolicy = {
  version: SKILL_ROUTING_POLICY_VERSION,
  mandatory: [],
  automatic: [
    { skill: "codebase-design", roles: ["planning"], risk: ["high", "critical"], reason: "planning:material-design" },
    { skill: "tdd", roles: ["implementation"], taskPattern: "test|behavior|contract|regression", reason: "implementation:tdd" },
    { skill: "diagnosing-bugs", roles: ["repair"], reason: "repair:diagnosis" },
    { skill: "tdd", roles: ["repair"], taskPattern: "test|regression", reason: "repair:regression-seam" },
    { skill: "code-review", roles: ["review-spec", "review-standards"], reason: "review:code-review" },
    { skill: "codebase-design", roles: ["review-standards"], risk: ["normal", "high", "critical"], reason: "review-standards:design" },
    { skill: "performance-telemetry", roles: ["maintenance"], reason: "maintenance:telemetry" },
  ],
  explicit: ["codebase-design"],
};

/** Compact, bounded telemetry line describing a resolution (no prompts/reasoning). */
export function renderSkillResolutionTelemetry(resolution: SkillResolution): string {
  if (!resolution.selected.length) {
    return `skills registry=${resolution.registryVersion} available=${resolution.availableCount} selected=none`;
  }
  const parts = resolution.selected
    .map((skill) => `${skill.id}@${skill.source}:${skill.provenanceVersion}(${skill.tier}:${skill.reason})`)
    .join(", ");
  return `skills registry=${resolution.registryVersion} available=${resolution.availableCount} selected=${parts}`;
}
