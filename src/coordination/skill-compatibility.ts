/**
 * Reviewed built-in skill compatibility declarations. Kept separate from the
 * resolver so compatibility metadata can grow without making routing logic a
 * deep data blob.
 */
import type { SkillCompatibilityDeclaration, SkillRegistryEntry } from "./skill-registry.ts";

const MATTPOCOCK_SKILLS_REVISION = "885e2ca4d842d139e9aef4e48d366c63cb1b8013";

function compatibility(input: SkillCompatibilityDeclaration): SkillCompatibilityDeclaration {
  return input;
}

/** Package-owned built-in registry; consumers may extend with pinned sources. */
export const BUILT_IN_SKILL_REGISTRY_ENTRIES: readonly SkillRegistryEntry[] = Object.freeze([
  {
    id: "code-review",
    category: "code-review-orchestrator",
    source: "mattpocock",
    provenanceVersion: MATTPOCOCK_SKILLS_REVISION,
    processOwner: true,
    compatibility: compatibility({
      supportedRoles: [],
      capabilityProfiles: [],
      mayAskUser: true,
      requiresHumanCheckpoint: true,
      maySpawnSubagents: true,
      processBehavior: "orchestrator",
      mutationScope: "none",
      requiredBoundInputs: [],
      unattended: "incompatible",
      adaptation: {
        kind: "upstream-reviewed",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:code-review`,
        decision: "Rejected for automatic worker routing: upstream code-review owns review orchestration, asks for fixed-point/spec setup, and spawns both review axes.",
      },
    }),
  },
  {
    id: "code-review-spec",
    category: "code-review-spec",
    source: "pi-next-adapted-mattpocock",
    provenanceVersion: `${MATTPOCOCK_SKILLS_REVISION}+pi-next-role-spec`,
    compatibility: compatibility({
      supportedRoles: ["review-spec"],
      capabilityProfiles: ["read-only-reviewer"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "none",
      requiredBoundInputs: [
        { name: "authorityFingerprint", missing: "reject-dispatch", description: "exact authoritative issue/spec fingerprint" },
        { name: "candidateSha", missing: "reject-dispatch", description: "exact reviewed candidate" },
        { name: "fixedPointSha", missing: "reject-dispatch", description: "exact fixed point supplied by dispatch" },
        { name: "specEvidence", missing: "reject-dispatch", description: "authoritative issue/spec evidence supplied by the kernel" },
      ],
      unattended: "compatible",
      adaptation: {
        kind: "extracted-discipline",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:code-review + pi-next issue #172`,
        decision: "Extract only spec-conformance review discipline; kernel owns fixed point, other axis, worker spawning, and aggregation.",
      },
    }),
  },
  {
    id: "code-review-standards",
    category: "code-review-standards",
    source: "pi-next-adapted-mattpocock",
    provenanceVersion: `${MATTPOCOCK_SKILLS_REVISION}+pi-next-role-standards`,
    compatibility: compatibility({
      supportedRoles: ["review-standards"],
      capabilityProfiles: ["read-only-reviewer"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "none",
      requiredBoundInputs: [
        { name: "authorityFingerprint", missing: "reject-dispatch", description: "exact authoritative issue fingerprint" },
        { name: "candidateSha", missing: "reject-dispatch", description: "exact reviewed candidate" },
        { name: "fixedPointSha", missing: "reject-dispatch", description: "exact fixed point supplied by dispatch" },
        { name: "standardsSources", missing: "reject-dispatch", description: "repository standards/design evidence supplied by the kernel" },
      ],
      unattended: "compatible",
      adaptation: {
        kind: "extracted-discipline",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:code-review + pi-next issue #172`,
        decision: "Extract only standards/design review discipline; kernel owns spec axis, worker spawning, and aggregation.",
      },
    }),
  },
  {
    id: "tdd",
    category: "tdd",
    source: "pi-next-adapted-mattpocock",
    provenanceVersion: `${MATTPOCOCK_SKILLS_REVISION}+pi-next-unattended-seam`,
    compatibility: compatibility({
      supportedRoles: ["implementation", "repair"],
      capabilityProfiles: ["mutable-owner"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "owned-workspace",
      requiredBoundInputs: [
        { name: "testingSeam", missing: "typed-blocked-result", description: "pre-agreed issue/PLAN/task-packet testing seam" },
      ],
      unattended: "typed-blocked-with-missing-input",
      adaptation: {
        kind: "pi-next-adapter",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:tdd + pi-next issue #172`,
        decision: "Preserve red-green behavioral vertical-slice discipline; replace interactive seam confirmation with kernel-bound seam or typed blocked result.",
      },
    }),
  },
  {
    id: "diagnosing-bugs",
    category: "debugging",
    source: "mattpocock",
    provenanceVersion: MATTPOCOCK_SKILLS_REVISION,
    compatibility: compatibility({
      supportedRoles: ["repair"],
      capabilityProfiles: ["mutable-owner"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "owned-workspace",
      requiredBoundInputs: [],
      unattended: "compatible",
      adaptation: {
        kind: "upstream-reviewed",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:diagnosing-bugs`,
        decision: "Compatible when bounded by Pi-next repair role: reproduce, isolate, fix, verify; no authority or worker orchestration.",
      },
    }),
  },
  {
    id: "codebase-design",
    category: "design",
    source: "mattpocock",
    provenanceVersion: MATTPOCOCK_SKILLS_REVISION,
    compatibility: compatibility({
      supportedRoles: ["planning", "review-standards"],
      capabilityProfiles: ["mutable-owner", "read-only-reviewer"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "owned-workspace",
      requiredBoundInputs: [],
      unattended: "compatible",
      adaptation: {
        kind: "upstream-reviewed",
        provenance: `mattpocock/skills:${MATTPOCOCK_SKILLS_REVISION}:codebase-design`,
        decision: "Compatible as bounded design vocabulary only; worker role/capability controls whether edits are allowed.",
      },
    }),
  },
  {
    id: "performance-telemetry",
    category: "performance",
    source: "pi-next",
    provenanceVersion: "pi-next",
    compatibility: compatibility({
      supportedRoles: ["maintenance"],
      capabilityProfiles: ["maintenance"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "workflow-artifacts",
      requiredBoundInputs: [],
      unattended: "compatible",
      adaptation: {
        kind: "pi-next-adapter",
        provenance: "pi-next:performance-telemetry",
        decision: "Package-owned bounded maintenance discipline; cannot affect product authority.",
      },
    }),
  },
  {
    id: "verification-before-completion",
    category: "verification",
    source: "pi-next",
    provenanceVersion: "pi-next",
    capabilities: ["terminal-verification"],
    compatibility: compatibility({
      supportedRoles: ["verification"],
      capabilityProfiles: ["verification"],
      mayAskUser: false,
      requiresHumanCheckpoint: false,
      maySpawnSubagents: false,
      processBehavior: "discipline",
      mutationScope: "none",
      requiredBoundInputs: [],
      unattended: "compatible",
      adaptation: {
        kind: "pi-next-adapter",
        provenance: "pi-next:verification-before-completion",
        decision: "Terminal verification discipline only; lifecycle authority remains kernel-owned.",
      },
    }),
  },
] as unknown as SkillRegistryEntry[]);
