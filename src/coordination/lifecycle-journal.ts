import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const LIFECYCLE_JOURNAL_VERSION = 1 as const;
export const MAX_LIFECYCLE_JOURNAL_PAYLOAD_BYTES = 8 * 1024;
export const MAX_LIFECYCLE_JOURNAL_LINE_BYTES = 16 * 1024;

export const LIFECYCLE_JOURNAL_EVENTS = [
  "baseline_imported",
  "candidate_selected",
  "lease_claimed",
  "lease_rejected",
  "lease_taken_over",
  "lease_released",
  "workspace_prepared",
  "authority_loaded",
  "plan_ready",
  "worker_started",
  "worker_finished",
  "verification_finished",
  "candidate_committed",
  "candidate_pushed",
  "promotion_started",
  "promotion_pushed",
  "promotion_succeeded",
  "reachability_proven",
  "authority_reconciled",
  "pending_verification_recorded",
  "issue_closed",
  "workspace_cleaned",
  "failure_recorded",
] as const;

export type LifecycleJournalEventName = (typeof LIFECYCLE_JOURNAL_EVENTS)[number];

/**
 * Coordination facts only. Intentionally excludes prompts, transcripts,
 * hidden reasoning, command logs, issue bodies, credentials, and raw output.
 */
export interface LifecycleJournalPayload {
  workItemId?: string;
  authorityFingerprint?: string;
  changed?: boolean;
  agent?: string;
  sessionId?: string;
  branch?: string;
  worktree?: string;
  expiresAt?: string;
  headSha?: string;
  adapterId?: string;
  adapterVersion?: string;
  phase?: string;
  ok?: boolean;
  code?: number | null;
  signal?: string | null;
  telemetryStatus?: string;
  verification?: "pass" | "fail" | "unproven";
  candidateSha?: string;
  mergeSha?: string;
  mainSha?: string;
  criteriaIds?: string[];
  scope?: string;
  stage?: string;
  reasonCode?: string;
  summary?: string;
  source?: string;
  note?: string;
}

export interface LifecycleJournalRecord {
  version: typeof LIFECYCLE_JOURNAL_VERSION;
  sequence: number;
  at: string;
  runId: string;
  issueNumber?: number;
  event: LifecycleJournalEventName;
  /** Optional stable key for idempotent durable transitions. */
  idempotencyKey?: string;
  payload: LifecycleJournalPayload;
}

export interface LifecycleJournalAppendInput {
  runId: string;
  issueNumber?: number;
  event: LifecycleJournalEventName;
  idempotencyKey?: string;
  payload?: LifecycleJournalPayload;
  at?: string;
}

export type LifecycleJournalErrorCode =
  | "JOURNAL_CORRUPT"
  | "UNSUPPORTED_VERSION"
  | "INVALID_EVENT"
  | "INVALID_RECORD"
  | "PAYLOAD_TOO_LARGE"
  | "RUN_MISMATCH";

export class LifecycleJournalError extends Error {
  constructor(
    readonly code: LifecycleJournalErrorCode,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "LifecycleJournalError";
  }
}

const EVENT_SET = new Set<string>(LIFECYCLE_JOURNAL_EVENTS);
const PAYLOAD_KEYS = new Set<keyof LifecycleJournalPayload>([
  "workItemId",
  "authorityFingerprint",
  "changed",
  "agent",
  "sessionId",
  "branch",
  "worktree",
  "expiresAt",
  "headSha",
  "adapterId",
  "adapterVersion",
  "phase",
  "ok",
  "code",
  "signal",
  "telemetryStatus",
  "verification",
  "candidateSha",
  "mergeSha",
  "mainSha",
  "criteriaIds",
  "scope",
  "stage",
  "reasonCode",
  "summary",
  "source",
  "note",
]);
const FORBIDDEN_KEY = /prompt|transcript|reasoning|secret|password|authorization|api[_-]?key|command[_-]?log|issue[_-]?body|raw[_-]?(?:output|content)/i;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, max = 2_048): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new LifecycleJournalError("INVALID_RECORD", `${label} must be a non-empty string <= ${max} chars`);
  }
  return value;
}

function validatePayload(value: unknown): LifecycleJournalPayload {
  if (value === undefined) return {};
  if (!plainObject(value)) {
    throw new LifecycleJournalError("INVALID_RECORD", "journal payload must be an object");
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new LifecycleJournalError("INVALID_RECORD", `forbidden recovery-journal payload key: ${key}`);
    }
    if (!PAYLOAD_KEYS.has(key as keyof LifecycleJournalPayload)) {
      throw new LifecycleJournalError("INVALID_RECORD", `unknown recovery-journal payload key: ${key}`);
    }
  }
  const payload = structuredClone(value) as LifecycleJournalPayload;
  for (const [key, item] of Object.entries(payload)) {
    if (typeof item === "string" && (item.length === 0 || item.length > 2_048)) {
      throw new LifecycleJournalError("INVALID_RECORD", `payload.${key} must be a non-empty string <= 2048 chars`);
    }
  }
  if (payload.criteriaIds !== undefined) {
    if (!Array.isArray(payload.criteriaIds) || payload.criteriaIds.length > 64) {
      throw new LifecycleJournalError("INVALID_RECORD", "payload.criteriaIds must contain at most 64 strings");
    }
    for (const id of payload.criteriaIds) boundedString(id, "payload.criteriaIds[]", 256);
  }
  if (payload.verification !== undefined && !["pass", "fail", "unproven"].includes(payload.verification)) {
    throw new LifecycleJournalError("INVALID_RECORD", `invalid verification verdict: ${String(payload.verification)}`);
  }
  if (payload.code !== undefined && payload.code !== null && (!Number.isInteger(payload.code) || Math.abs(payload.code) > 1_000_000)) {
    throw new LifecycleJournalError("INVALID_RECORD", "payload.code must be a bounded integer or null");
  }
  const encoded = JSON.stringify(payload);
  if (utf8Bytes(encoded) > MAX_LIFECYCLE_JOURNAL_PAYLOAD_BYTES) {
    throw new LifecycleJournalError(
      "PAYLOAD_TOO_LARGE",
      `journal payload exceeds ${MAX_LIFECYCLE_JOURNAL_PAYLOAD_BYTES} bytes`,
    );
  }
  return payload;
}

function parseRecord(value: unknown, line: number): LifecycleJournalRecord {
  if (!plainObject(value)) {
    throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${line} is not an object`, line);
  }
  if (value.version !== LIFECYCLE_JOURNAL_VERSION) {
    throw new LifecycleJournalError(
      "UNSUPPORTED_VERSION",
      `journal line ${line} has unsupported version ${String(value.version)}`,
      line,
    );
  }
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 1) {
    throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${line} has invalid sequence`, line);
  }
  if (typeof value.event !== "string" || !EVENT_SET.has(value.event)) {
    throw new LifecycleJournalError("INVALID_EVENT", `journal line ${line} has invalid event ${String(value.event)}`, line);
  }
  const runId = boundedString(value.runId, `journal line ${line} runId`, 256)!;
  const at = boundedString(value.at, `journal line ${line} at`, 64)!;
  if (!Number.isFinite(Date.parse(at))) {
    throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${line} has invalid timestamp`, line);
  }
  const issueNumber = value.issueNumber === undefined ? undefined : Number(value.issueNumber);
  if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber < 1)) {
    throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${line} has invalid issueNumber`, line);
  }
  const idempotencyKey = value.idempotencyKey === undefined
    ? undefined
    : boundedString(value.idempotencyKey, `journal line ${line} idempotencyKey`, 512);
  return {
    version: LIFECYCLE_JOURNAL_VERSION,
    sequence: Number(value.sequence),
    at,
    runId,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    event: value.event as LifecycleJournalEventName,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload: validatePayload(value.payload),
  };
}

export function readLifecycleJournal(path: string): LifecycleJournalRecord[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, "utf8");
  if (!contents) return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: LifecycleJournalRecord[] = [];
  let runId: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) {
      throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${index + 1} is empty`, index + 1);
    }
    if (utf8Bytes(raw) > MAX_LIFECYCLE_JOURNAL_LINE_BYTES) {
      throw new LifecycleJournalError("JOURNAL_CORRUPT", `journal line ${index + 1} exceeds line budget`, index + 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new LifecycleJournalError(
        "JOURNAL_CORRUPT",
        `journal line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        index + 1,
      );
    }
    const record = parseRecord(parsed, index + 1);
    const expectedSequence = index + 1;
    if (record.sequence !== expectedSequence) {
      throw new LifecycleJournalError(
        "JOURNAL_CORRUPT",
        `journal line ${index + 1} sequence ${record.sequence} != expected ${expectedSequence}`,
        index + 1,
      );
    }
    if (runId && record.runId !== runId) {
      throw new LifecycleJournalError(
        "RUN_MISMATCH",
        `journal line ${index + 1} run ${record.runId} != ${runId}`,
        index + 1,
      );
    }
    runId = record.runId;
    records.push(record);
  }
  return records;
}

export function appendLifecycleJournal(
  path: string,
  input: LifecycleJournalAppendInput,
): LifecycleJournalRecord {
  const runId = boundedString(input.runId, "runId", 256)!;
  if (!EVENT_SET.has(input.event)) {
    throw new LifecycleJournalError("INVALID_EVENT", `invalid lifecycle journal event: ${String(input.event)}`);
  }
  if (input.issueNumber !== undefined && (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1)) {
    throw new LifecycleJournalError("INVALID_RECORD", `invalid issueNumber: ${String(input.issueNumber)}`);
  }
  const at = input.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) {
    throw new LifecycleJournalError("INVALID_RECORD", `invalid journal timestamp: ${at}`);
  }
  const idempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : boundedString(input.idempotencyKey, "idempotencyKey", 512);
  const payload = validatePayload(input.payload);
  const existing = readLifecycleJournal(path);
  if (existing.length && existing[0].runId !== runId) {
    throw new LifecycleJournalError(
      "RUN_MISMATCH",
      `journal belongs to run ${existing[0].runId}, not ${runId}`,
    );
  }
  if (idempotencyKey) {
    const duplicate = existing.find((record) => record.idempotencyKey === idempotencyKey);
    if (duplicate) {
      if (duplicate.event !== input.event || duplicate.issueNumber !== input.issueNumber) {
        throw new LifecycleJournalError(
          "INVALID_RECORD",
          `idempotency key ${idempotencyKey} already belongs to ${duplicate.event}`,
        );
      }
      return duplicate;
    }
  }
  const record: LifecycleJournalRecord = {
    version: LIFECYCLE_JOURNAL_VERSION,
    sequence: existing.length + 1,
    at,
    runId,
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    event: input.event,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    payload,
  };
  const line = `${JSON.stringify(record)}\n`;
  if (utf8Bytes(line) > MAX_LIFECYCLE_JOURNAL_LINE_BYTES) {
    throw new LifecycleJournalError(
      "PAYLOAD_TOO_LARGE",
      `journal record exceeds ${MAX_LIFECYCLE_JOURNAL_LINE_BYTES} bytes`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

export interface LifecycleJournalState {
  runId?: string;
  issueNumber?: number;
  lastSequence: number;
  leaseOwned: boolean;
  workspacePrepared: boolean;
  workerStarted: boolean;
  workerFinished: boolean;
  verification?: "pass" | "fail" | "unproven";
  candidateSha?: string;
  mergeSha?: string;
  reachabilityProven: boolean;
  authorityReconciled: boolean;
  pendingVerification: boolean;
  issueClosed: boolean;
  leaseReleased: boolean;
  workspaceCleaned: boolean;
  lastFailure?: { code?: string; scope?: string; stage?: string };
}

export function materializeLifecycleJournal(
  records: readonly LifecycleJournalRecord[],
): LifecycleJournalState {
  const state: LifecycleJournalState = {
    lastSequence: 0,
    leaseOwned: false,
    workspacePrepared: false,
    workerStarted: false,
    workerFinished: false,
    reachabilityProven: false,
    authorityReconciled: false,
    pendingVerification: false,
    issueClosed: false,
    leaseReleased: false,
    workspaceCleaned: false,
  };
  for (const record of records) {
    state.runId = record.runId;
    if (record.issueNumber !== undefined) state.issueNumber = record.issueNumber;
    state.lastSequence = record.sequence;
    switch (record.event) {
      case "lease_claimed":
      case "lease_taken_over":
        state.leaseOwned = true;
        state.leaseReleased = false;
        break;
      case "lease_released":
        state.leaseOwned = false;
        state.leaseReleased = true;
        break;
      case "workspace_prepared":
        state.workspacePrepared = true;
        break;
      case "worker_started":
        state.workerStarted = true;
        state.workerFinished = false;
        break;
      case "worker_finished":
        state.workerStarted = true;
        state.workerFinished = true;
        break;
      case "verification_finished":
        state.verification = record.payload.verification;
        if (record.payload.candidateSha) state.candidateSha = record.payload.candidateSha;
        break;
      case "candidate_committed":
        if (record.payload.candidateSha) state.candidateSha = record.payload.candidateSha;
        break;
      case "promotion_succeeded":
        if (record.payload.mergeSha) state.mergeSha = record.payload.mergeSha;
        break;
      case "reachability_proven":
        state.reachabilityProven = true;
        if (record.payload.mainSha) state.mergeSha = record.payload.mainSha;
        if (record.payload.candidateSha) state.candidateSha = record.payload.candidateSha;
        break;
      case "authority_reconciled":
        state.authorityReconciled = true;
        break;
      case "pending_verification_recorded":
        state.pendingVerification = true;
        break;
      case "issue_closed":
        state.issueClosed = true;
        break;
      case "workspace_cleaned":
        state.workspaceCleaned = true;
        break;
      case "failure_recorded":
        state.lastFailure = {
          code: record.payload.reasonCode,
          scope: record.payload.scope,
          stage: record.payload.stage,
        };
        break;
      default:
        break;
    }
  }
  return state;
}
