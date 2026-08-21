import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  InMemoryWorkAuthority,
  PiNextConfigError,
  validatePiNextConfig,
  type PiNextConfig,
  type SelfAssessmentFinding,
} from "../src/coordination/index.ts";
import { candidateShortlist } from "../extensions/pi-next/issue-candidates.ts";
import { buildAutoPrompt, buildLoopMaintenancePrompt } from "../extensions/pi-next/prompt.ts";

const config = {
  version: 1,
  authority: {
    adapter: "memory",
    projectStatus: { todo: "queued", inProgress: "working", done: "complete", blocked: "paused" },
  },
  selection: {
    priorities: ["urgent", "normal"],
    readyStates: ["prepared"],
    blockedStates: ["paused"],
  },
  repositoryPolicy: { entrypoints: ["POLICY.md"] },
  workflow: {
    stateDir: ".workflow",
    planPath: ".workflow/PLAN.md",
    verifyPath: ".workflow/VERIFY.md",
    archiveDir: ".workflow/ARCHIVED",
    deferredDir: ".workflow/deferred",
    skillPath: ".workflow/SKILL.md",
    tuningPath: ".workflow/LOOP_TUNING.md",
    helperDir: ".workflow/scripts",
  },
} as const;
const validatedConfig = validatePiNextConfig(config);

test("versioned configuration validates custom authority and workflow policy", () => {
  const validated = validatePiNextConfig(config);
  assert.equal(validated.authority.adapter, "memory");
  assert.deepEqual(validated.selection.priorities, ["urgent", "normal"]);
  assert.equal(validated.workflow.planPath, ".workflow/PLAN.md");
  assert.equal(validated.workflow.diagnosticsPath, ".pi-next/diagnostics");
  assert.throws(
    () => validatePiNextConfig({ ...config, unsupported: true }),
    (error: unknown) => error instanceof PiNextConfigError && /unsupported/.test(error.message),
  );
  assert.throws(
    () => validatePiNextConfig({ ...config, workflow: { ...config.workflow, planPath: "../PLAN.md" } }),
    PiNextConfigError,
  );
});

test("a non-GitHub authority can provide configurable candidates", async () => {
  const authority = new InMemoryWorkAuthority([
    {
      id: "local-7",
      number: 7,
      title: "local work item",
      body: "",
      state: "open",
      updatedAt: "2026-01-01T00:00:00Z",
      priority: "urgent",
      states: ["prepared"],
      comments: [],
    },
    {
      id: "local-8",
      number: 8,
      title: "paused work item",
      body: "",
      state: "open",
      priority: "urgent",
      states: ["paused"],
      comments: [],
    },
  ]);
  const result = await candidateShortlist("/tmp", {
    authority,
    config: validatedConfig,
    refreshMain: false,
  });
  assert.match(result.text || "", /urgent:\n- #7 local work item/);
  assert.doesNotMatch(result.text || "", /paused work item/);
});

test("awaiting external verification is excluded until authoritative PASS/FAIL evidence", async () => {
  const pending = {
    version: 1 as const,
    status: "awaiting_external_verification" as const,
    criteria: [{ id: "deploy", description: "Deploy and verify the integrated revision", environment: "preview" }],
    integratedMainSha: "a".repeat(40),
  };
  const authority = new InMemoryWorkAuthority([
    {
      id: "pending",
      number: 9,
      title: "pending verification",
      body: "changed-authority body",
      state: "open",
      priority: "urgent",
      states: ["prepared"],
      comments: [{
        id: "pending-marker",
        author: "system",
        body: `<!-- pi-next-pending-verification -->\n${JSON.stringify(pending)}`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }],
    },
    {
      id: "passed",
      number: 10,
      title: "passed verification",
      body: "",
      state: "open",
      priority: "urgent",
      states: ["prepared"],
      comments: [
        {
          id: "passed-pending-marker",
          author: "system",
          body: `<!-- pi-next-pending-verification -->\n${JSON.stringify(pending)}`,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "passed-result-marker",
          author: "maintainer",
          body: `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha: pending.integratedMainSha, status: "passed", evidence: "maintainer approval" })}`,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
    {
      id: "failed",
      number: 11,
      title: "failed verification",
      body: "",
      state: "open",
      priority: "urgent",
      states: ["prepared"],
      comments: [
        {
          id: "failed-pending-marker",
          author: "system",
          body: `<!-- pi-next-pending-verification -->\n${JSON.stringify(pending)}`,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "failed-result-marker",
          author: "maintainer",
          body: `<!-- pi-next-pending-verification-result -->\n${JSON.stringify({ version: 1, integratedMainSha: pending.integratedMainSha, status: "failed", evidence: "preview regression" })}`,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
    {
      id: "eligible",
      number: 12,
      title: "unrelated eligible work",
      body: "",
      state: "open",
      priority: "urgent",
      states: ["prepared"],
      comments: [],
    },
  ]);

  const result = await candidateShortlist("/tmp", { authority, config: validatedConfig, refreshMain: false });
  assert.equal(result.candidateIssueNumber, 10);
  assert.match(result.text || "", /#10 passed verification/);
  assert.match(result.text || "", /#11 failed verification/);
  assert.match(result.text || "", /#12 unrelated eligible work/);
  assert.doesNotMatch(result.text || "", /#9 pending verification/);
  assert.match(result.text || "", /#9/);
});

test("current-run deferred issues are excluded and authoritative exhaustion is explicit", async () => {
  const authority = new InMemoryWorkAuthority([
    {
      id: "contained-465",
      number: 465,
      title: "contained issue",
      body: "",
      state: "open",
      updatedAt: "2026-01-01T00:00:00Z",
      priority: "urgent",
      states: ["prepared"],
      comments: [],
    },
    {
      id: "next-466",
      number: 466,
      title: "next eligible issue",
      body: "",
      state: "open",
      updatedAt: "2026-01-02T00:00:00Z",
      priority: "normal",
      states: ["prepared"],
      comments: [],
    },
  ]);
  const continued = await candidateShortlist("/tmp", {
    authority,
    config: validatedConfig,
    deferredIssues: [465],
    refreshMain: false,
  });
  assert.equal(continued.outcome, "candidate");
  assert.equal(continued.candidateIssueNumber, 466);
  assert.doesNotMatch(continued.text || "", /contained issue/);

  const exhausted = await candidateShortlist("/tmp", {
    authority,
    config: validatedConfig,
    deferredIssues: [465, 466],
    refreshMain: false,
  });
  assert.equal(exhausted.outcome, "exhausted");
  assert.equal(exhausted.exhausted, true);
  assert.match(exhausted.text || "", /contained earlier in this run/);
});

test("authority discovery failure is distinct from candidate exhaustion", async () => {
  const authority = new InMemoryWorkAuthority();
  authority.listCandidates = async () => {
    throw new Error("transport unavailable");
  };
  const result = await candidateShortlist("/tmp", {
    authority,
    config: validatedConfig,
    refreshMain: false,
  });
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.exhausted, false);
  assert.match(result.reason || "", /transport unavailable/);
});

test("self-assessment findings use configured held and approval states", async () => {
  const governedConfig = validatePiNextConfig({
    ...config,
    assessment: {
      findingLabels: ["finding:generated"],
      heldStates: ["review:pending"],
      approvedStates: ["review:approved"],
      rejectedStates: ["review:rejected"],
      supersededStates: ["review:duplicate"],
    },
  });
  class FindingAuthority extends InMemoryWorkAuthority {
    private nextNumber = 100;

    async publishFinding(finding: SelfAssessmentFinding, policy: Pick<PiNextConfig, "assessment">): Promise<{ id: string }> {
      const number = this.nextNumber++;
      this.upsert({
        id: String(number),
        number,
        title: finding.title,
        body: `fingerprint: ${finding.fingerprint}`,
        state: "open",
        priority: "urgent",
        states: [...policy.assessment.findingLabels, ...policy.assessment.heldStates],
        comments: [],
      });
      return { id: String(number) };
    }

    async readFindingApproval(id: string, policy: Pick<PiNextConfig, "assessment">): Promise<SelfAssessmentFinding["approvalState"]> {
      const item = await this.get(id);
      if (item.states.some((state) => policy.assessment.rejectedStates.includes(state))) return "rejected";
      if (item.states.some((state) => policy.assessment.supersededStates.includes(state))) return "superseded";
      if (item.states.some((state) => policy.assessment.approvedStates.includes(state))) return "approved";
      return "pending_review";
    }
  }

  const authority = new FindingAuthority();
  const finding: SelfAssessmentFinding = {
    fingerprint: "configured-finding",
    title: "configured finding",
    category: "integrity",
    severity: "P2",
    confidence: "high",
    evidence: ["reproduced"],
    affectedRuns: ["run-1"],
    affectedIssues: [7],
    recurrence: 3,
    proposedAction: "review the bounded fix",
    approvalState: "pending_review",
  };
  const published = await authority.publishFinding(finding, governedConfig);
  const held = await candidateShortlist("/tmp", { authority, config: governedConfig, refreshMain: false });
  assert.doesNotMatch(held.text || "", /configured finding/);

  const item = await authority.get(published.id);
  authority.upsert({ ...item, states: [...governedConfig.assessment.findingLabels, ...governedConfig.assessment.approvedStates] });
  assert.equal(await authority.readFindingApproval(published.id, governedConfig), "approved");
  const approved = await candidateShortlist("/tmp", { authority, config: governedConfig, refreshMain: false });
  assert.match(approved.text || "", /urgent:\n- #100 configured finding/);
});

test("prompt policy comes from configuration rather than hidden repository conventions", () => {
  const prompt = buildAutoPrompt({ config: validatePiNextConfig(config) });
  assert.match(prompt, /POLICY\.md/);
  assert.match(prompt, /memory authority/);
  assert.match(prompt, /urgent/);
  assert.doesNotMatch(prompt, /AGENTS\.md/);
});

test("maintenance uses the package skill and configured neutral diagnostics path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-maintenance-consumer-"));
  try {
    await writeFile(join(root, ".pi-next-config.json"), JSON.stringify({
      ...config,
      workflow: { ...config.workflow, diagnosticsPath: ".workflow/evidence" },
    }));
    const previous = process.env.PI_NEXT_CONFIG;
    process.env.PI_NEXT_CONFIG = ".pi-next-config.json";
    try {
      const prompt = buildLoopMaintenancePrompt(root, {
        issueNumber: 23,
        completedCount: 1,
        reasons: ["test trigger"],
        summary: "bounded telemetry",
      });
      assert.match(prompt, /performance-telemetry/);
      assert.match(prompt, /role=maintenance/);
      assert.doesNotMatch(prompt, /\.agents\/|pi-performance\/SKILL/);
      assert.match(prompt, /\.workflow\/evidence/);
    } finally {
      if (previous === undefined) delete process.env.PI_NEXT_CONFIG;
      else process.env.PI_NEXT_CONFIG = previous;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
