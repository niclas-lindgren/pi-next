/** Disposable file-backed lease store used only by the memory consumer adapter. */
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueLease, IssueLeaseAuthority } from "../../src/coordination/issue-leases.ts";
import { parseIssueLease, serializeIssueLease } from "../../src/coordination/issue-authority.ts";
import { runtimeDir } from "./util-core.ts";

export class LocalIssueLeaseAuthority implements IssueLeaseAuthority {
  private file(issueNumber: number): string {
    return join(runtimeDir(this.cwd), "memory-leases", `issue-${issueNumber}.json`);
  }

  constructor(private readonly cwd: string) {}

  async read(issueNumber: number): Promise<IssueLease | undefined> {
    const path = this.file(issueNumber);
    if (!existsSync(path)) return undefined;
    return parseIssueLease(readFileSync(path, "utf8"));
  }

  async create(issueNumber: number, lease: IssueLease): Promise<void> {
    const path = this.file(issueNumber);
    mkdirSync(join(runtimeDir(this.cwd), "memory-leases"), { recursive: true });
    let fd: number;
    try { fd = openSync(path, "wx"); } catch { throw new Error("lease already exists"); }
    try { writeFileSync(fd, serializeIssueLease(lease), "utf8"); } finally { closeSync(fd); }
  }

  async replace(issueNumber: number, expected: IssueLease, lease: IssueLease): Promise<void> {
    const path = this.file(issueNumber);
    const current = await this.read(issueNumber);
    if (!current || serializeIssueLease(current) !== serializeIssueLease(expected)) throw new Error("compare-and-swap failed");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, serializeIssueLease(lease), "utf8");
    renameSync(temporary, path);
  }

  async remove(issueNumber: number, expected: IssueLease): Promise<void> {
    const path = this.file(issueNumber);
    const current = await this.read(issueNumber);
    if (!current || serializeIssueLease(current) !== serializeIssueLease(expected)) throw new Error("compare-and-swap failed");
    unlinkSync(path);
  }
}
