import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILT_IN_SKILL_REGISTRY_ENTRIES,
  DEFAULT_SKILL_ROUTING_POLICY,
  SkillRegistryError,
  buildSkillRegistry,
  builtInSkillRegistry,
  renderSkillResolutionTelemetry,
  resolveSkills,
  validateSkillRoutingPolicy,
  type SkillRegistryEntry,
  type SkillRoutingPolicy,
} from "../src/coordination/skill-registry.ts";
import { selectWorkerSkills, type CapabilityProfile, type WorkerRole } from "../src/coordination/worker-dispatch.ts";

const ROLES: WorkerRole[] = [
  "controller", "planning", "implementation", "repair",
  "review-spec", "review-standards", "verification", "maintenance",
];

function fixtureCompatibility(role: WorkerRole = "implementation", capability: CapabilityProfile = "mutable-owner"): SkillRegistryEntry["compatibility"] {
  return {
    supportedRoles: [role],
    capabilityProfiles: [capability],
    mayAskUser: false,
    requiresHumanCheckpoint: false,
    maySpawnSubagents: false,
    processBehavior: "discipline",
    mutationScope: capability === "read-only-reviewer" ? "none" : "owned-workspace",
    requiredBoundInputs: [],
    unattended: "compatible",
    adaptation: { kind: "pi-next-adapter", provenance: "fixture@pinned", decision: "fixture" },
  };
}

test("registry building is deterministic and rejects duplicate ids", () => {
  const a = builtInSkillRegistry();
  const b = builtInSkillRegistry();
  assert.equal(a.version, b.version);
  assert.equal(a.entries.length, BUILT_IN_SKILL_REGISTRY_ENTRIES.length);
  assert.throws(
    () => buildSkillRegistry([...BUILT_IN_SKILL_REGISTRY_ENTRIES, BUILT_IN_SKILL_REGISTRY_ENTRIES[0]]),
    SkillRegistryError,
  );
});

test("same dispatch input produces the same resolved skill set", () => {
  const registry = builtInSkillRegistry();
  const input = { role: "repair" as const, task: "fix regression" };
  const first = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, input);
  const second = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, input);
  assert.deepEqual(first, second);
});

test("default resolver matches historical role/risk selection (parity)", () => {
  const registry = builtInSkillRegistry();
  for (const role of ROLES) {
    for (const risk of [undefined, "low", "normal", "high", "critical"] as const) {
      for (const task of [undefined, "implement test regression contract"]) {
        const legacy = selectWorkerSkills(role, { risk, task });
        const reviewBoundInputs = role === "review-spec"
          ? { authorityFingerprint: "a", candidateSha: "c", fixedPointSha: "f", boundInputs: { specEvidence: "issue #1" } }
          : role === "review-standards"
            ? { authorityFingerprint: "a", candidateSha: "c", fixedPointSha: "f", boundInputs: { standardsSources: "AGENTS.md" } }
            : {};
        const resolved = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, {
          role,
          ...(risk ? { risk } : {}),
          ...(task ? { task } : {}),
          ...reviewBoundInputs,
          capabilityProfile: role === "review-spec" || role === "review-standards" ? "read-only-reviewer" : role === "verification" ? "verification" : role === "maintenance" ? "maintenance" : role === "controller" ? "controller" : "mutable-owner",
        }).selected.map((skill) => skill.id);
        assert.deepEqual(resolved, legacy, `${role}/${risk}/${task}`);
      }
    }
  }
});

test("mandatory, automatic, and explicit tiers behave distinctly", () => {
  const registry = builtInSkillRegistry();
  const policy: SkillRoutingPolicy = {
    version: 1,
    mandatory: [{ skill: "verification-before-completion", roles: ["verification"] }],
    automatic: [{ skill: "tdd", roles: ["implementation"] }],
    explicit: ["codebase-design"],
  };

  const verification = resolveSkills(registry, policy, { role: "verification" });
  assert.deepEqual(verification.selected.map((s) => [s.id, s.tier]), [["verification-before-completion", "mandatory"]]);

  const implementation = resolveSkills(registry, policy, { role: "implementation" });
  assert.deepEqual(implementation.selected.map((s) => [s.id, s.tier]), [["tdd", "automatic"]]);

  // explicit skill is not loaded unless requested, even though it is available
  const withoutRequest = resolveSkills(registry, policy, { role: "planning" });
  assert.deepEqual(withoutRequest.selected, []);
  const withRequest = resolveSkills(registry, policy, { role: "planning", requestedSkills: ["codebase-design"] });
  assert.deepEqual(withRequest.selected.map((s) => [s.id, s.tier]), [["codebase-design", "explicit"]]);
});

test("path-aware automatic routing selects configured disciplines", () => {
  const registry = buildSkillRegistry([
    ...BUILT_IN_SKILL_REGISTRY_ENTRIES,
    { id: "browser-testing", category: "frontend-testing", source: "pi-next", provenanceVersion: "pi-next", compatibility: fixtureCompatibility("implementation") },
  ]);
  const policy: SkillRoutingPolicy = {
    version: 1,
    mandatory: [],
    automatic: [{ skill: "browser-testing", roles: ["implementation"], paths: ["src/ui/"] }],
    explicit: [],
  };
  assert.deepEqual(resolveSkills(registry, policy, { role: "implementation", paths: ["src/api/user.ts"] }).selected, []);
  assert.deepEqual(
    resolveSkills(registry, policy, { role: "implementation", paths: ["src/ui/button.tsx"] }).selected.map((s) => s.id),
    ["browser-testing"],
  );
});

test("installed-but-unselected skills are absent and available count exceeds selected", () => {
  const registry = builtInSkillRegistry();
  const resolution = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, { role: "implementation", task: "add a test" });
  assert.equal(resolution.availableCount, registry.entries.length);
  assert.ok(resolution.availableCount > resolution.selected.length);
  const ids = resolution.selected.map((s) => s.id);
  assert.ok(!ids.includes("code-review"));
  assert.ok(!ids.includes("diagnosing-bugs"));
});

test("exact provenance, adaptation, and compatibility appear in bounded telemetry", () => {
  const registry = builtInSkillRegistry();
  const resolution = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, { role: "repair", capabilityProfile: "mutable-owner", task: "fix regression" });
  const line = renderSkillResolutionTelemetry(resolution);
  assert.match(line, /registry=/);
  assert.match(line, /diagnosing-bugs@mattpocock:885e2ca4d842d139e9aef4e48d366c63cb1b8013\(automatic:repair:diagnosis;compat=compatible;role=repair;adapt=upstream-reviewed;nested=0\)/);
  assert.match(line, /tdd@pi-next-adapted-mattpocock:885e2ca4d842d139e9aef4e48d366c63cb1b8013\+pi-next-unattended-seam\(automatic:repair:regression-seam;compat=typed-blocked;role=repair;adapt=pi-next-adapter;nested=0 missing=testingSeam\)/);
  const tdd = resolution.selected.find((s) => s.id === "tdd");
  assert.equal(tdd?.compatibility.status, "typed-blocked");
  assert.deepEqual(tdd?.compatibility.missingBoundInputs, ["testingSeam"]);
});

test("conflicting methodology categories fail validation", () => {
  const registry = buildSkillRegistry([
    ...BUILT_IN_SKILL_REGISTRY_ENTRIES,
    { id: "systematic-debugging", category: "debugging", source: "superpowers", provenanceVersion: "pinned", compatibility: fixtureCompatibility("repair") },
  ]);
  // Matt diagnosing-bugs + Superpowers systematic-debugging on the same axis.
  const policy: SkillRoutingPolicy = {
    version: 1,
    mandatory: [],
    automatic: [
      { skill: "diagnosing-bugs", roles: ["repair"] },
      { skill: "systematic-debugging", roles: ["repair"] },
    ],
    explicit: [],
  };
  assert.throws(() => validateSkillRoutingPolicy(policy, registry), (error: unknown) =>
    error instanceof SkillRegistryError && /competing debugging methodologies/.test(error.message));
});

test("automatic skills without reviewed compatibility fail closed", () => {
  const registry = buildSkillRegistry([
    ...BUILT_IN_SKILL_REGISTRY_ENTRIES,
    { id: "raw-method", category: "raw", source: "example", provenanceVersion: "pinned" },
  ]);
  assert.throws(
    () => validateSkillRoutingPolicy({ version: 1, mandatory: [], automatic: [{ skill: "raw-method", roles: ["implementation"] }], explicit: [] }, registry),
    (error: unknown) => error instanceof SkillRegistryError && /lacks reviewed unattended compatibility metadata/.test(error.message),
  );
});

test("review role compatibility requires exact kernel-bound inputs", () => {
  const registry = builtInSkillRegistry();
  assert.throws(
    () => resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, {
      role: "review-spec",
      capabilityProfile: "read-only-reviewer",
      authorityFingerprint: "a1",
      candidateSha: "c1",
      fixedPointSha: "f1",
    }),
    (error: unknown) => error instanceof SkillRegistryError && /specEvidence/.test(error.message),
  );
  assert.deepEqual(
    resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, {
      role: "review-spec",
      capabilityProfile: "read-only-reviewer",
      authorityFingerprint: "a1",
      candidateSha: "c1",
      fixedPointSha: "f1",
      boundInputs: { specEvidence: "issue #172" },
    }).selected.map((skill) => skill.id),
    ["code-review-spec"],
  );
  assert.deepEqual(
    resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, {
      role: "review-standards",
      capabilityProfile: "read-only-reviewer",
      authorityFingerprint: "a1",
      candidateSha: "c1",
      fixedPointSha: "f1",
      boundInputs: { standardsSources: "AGENTS.md" },
      risk: "high",
    }).selected.map((skill) => skill.id),
    ["code-review-standards", "codebase-design"],
  );
});

test("unattended TDD without an authoritative seam returns typed blocked compatibility", () => {
  const registry = builtInSkillRegistry();
  const missing = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, { role: "implementation", capabilityProfile: "mutable-owner", task: "add behavior regression test" });
  assert.equal(missing.selected.find((skill) => skill.id === "tdd")?.compatibility.status, "typed-blocked");
  assert.deepEqual(missing.selected.find((skill) => skill.id === "tdd")?.compatibility.missingBoundInputs, ["testingSeam"]);

  const bound = resolveSkills(registry, DEFAULT_SKILL_ROUTING_POLICY, {
    role: "implementation",
    capabilityProfile: "mutable-owner",
    task: "add behavior regression test",
    boundInputs: { testingSeam: "test/feature.test.ts around public API" },
  });
  assert.equal(bound.selected.find((skill) => skill.id === "tdd")?.compatibility.status, "compatible");
});

test("skills declaring internal sub-agent spawning are rejected unless dispatch permits a kernel budget", () => {
  const registry = buildSkillRegistry([
    ...BUILT_IN_SKILL_REGISTRY_ENTRIES,
    {
      id: "nested-debug",
      category: "nested-debug",
      source: "example",
      provenanceVersion: "pinned",
      compatibility: {
        supportedRoles: ["repair"],
        capabilityProfiles: ["mutable-owner"],
        mayAskUser: false,
        requiresHumanCheckpoint: false,
        maySpawnSubagents: true,
        processBehavior: "discipline",
        mutationScope: "owned-workspace",
        requiredBoundInputs: [],
        unattended: "compatible",
        adaptation: { kind: "pi-next-adapter", provenance: "example@pinned", decision: "fixture" },
      },
    },
  ]);
  const policy: SkillRoutingPolicy = { version: 1, mandatory: [], automatic: [{ skill: "nested-debug", roles: ["repair"] }], explicit: [] };
  assert.throws(
    () => validateSkillRoutingPolicy(policy, registry),
    (error: unknown) => error instanceof SkillRegistryError && /may spawn nested workers/.test(error.message),
  );
  assert.equal(
    resolveSkills(registry, policy, { role: "repair", capabilityProfile: "mutable-owner", allowNestedWorkers: true }).selected[0]?.compatibility.nestedWorkersPermitted,
    true,
  );
});

test("unavailable and process-owner skills fail closed", () => {
  const registry = buildSkillRegistry([
    ...BUILT_IN_SKILL_REGISTRY_ENTRIES,
    { id: "using-superpowers", category: "workflow", source: "superpowers", provenanceVersion: "pinned", processOwner: true },
  ]);
  // The model cannot pull an arbitrary/unavailable skill into routing.
  assert.throws(
    () => validateSkillRoutingPolicy({ version: 1, mandatory: [], automatic: [{ skill: "unknown-skill" }], explicit: [] }, registry),
    (error: unknown) => error instanceof SkillRegistryError && /not present in the reviewed registry/.test(error.message),
  );
  // A process-owner/bootstrap skill cannot silently become automatic lifecycle.
  assert.throws(
    () => validateSkillRoutingPolicy({ version: 1, mandatory: [], automatic: [{ skill: "using-superpowers" }], explicit: [] }, registry),
    (error: unknown) => error instanceof SkillRegistryError && /process-owner skill/.test(error.message),
  );
  // Even if explicitly requested, a process owner is never loaded automatically.
  const resolution = resolveSkills(registry, { version: 1, mandatory: [], automatic: [], explicit: ["using-superpowers"] }, {
    role: "implementation",
    requestedSkills: ["using-superpowers"],
  });
  assert.equal(resolution.selected.find((s) => s.id === "using-superpowers")?.tier, "explicit");
});

test("resolver stays adapter-neutral: identical contract regardless of caller", () => {
  // Two independent registries built from the same entries share a fingerprint,
  // so any adapter computing the same resolution gets the same contract.
  const registryA = builtInSkillRegistry();
  const registryB = buildSkillRegistry(BUILT_IN_SKILL_REGISTRY_ENTRIES);
  const input = {
    role: "review-standards" as const,
    risk: "high" as const,
    capabilityProfile: "read-only-reviewer" as const,
    authorityFingerprint: "a1",
    candidateSha: "c1",
    fixedPointSha: "f1",
    boundInputs: { standardsSources: "AGENTS.md" },
  };
  assert.deepEqual(
    resolveSkills(registryA, DEFAULT_SKILL_ROUTING_POLICY, input),
    resolveSkills(registryB, DEFAULT_SKILL_ROUTING_POLICY, input),
  );
});
