from pathlib import Path

source_path = Path("src/coordination/issue-leases.ts")
source = source_path.read_text()
old = '''    if (!this.repository) {
      const timeoutMs = authorityOperationTimeoutMs();
      const { stdout } = await withAuthorityTimeout(
        "gh repo view",
        execFileAsync(
          "gh",
'''
new = '''    if (!this.repository) {
      const timeoutMs = authorityOperationTimeoutMs();
      const { stdout: remotes } = await withAuthorityTimeout(
        "git remote",
        execFileAsync("git", ["-C", this.cwd, "remote"], {
          cwd: this.cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          killSignal: "SIGTERM",
        }),
        timeoutMs,
      );
      if (!remotes.trim()) throw new Error("no git remotes found");
      const { stdout } = await withAuthorityTimeout(
        "gh repo view",
        execFileAsync(
          "gh",
'''
if old not in source:
    raise SystemExit("expected GitHubIssueLeaseAuthority.repo block not found")
source = source.replace(old, new, 1)
source_path.write_text(source)

test_path = Path("test/cli.test.ts")
tests = test_path.read_text()
old = '''test("status never throws for a fixture with no resolvable GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-cli-status-"));
  try {
    await exec("git", ["init", "-q", root]);
    const lines: string[] = [];
    const code = await runCli(["status", "--issue", "7"], { cwd: root, stdout: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { ok: boolean; result?: { lease?: unknown } };
    if (!parsed.ok) assert.fail(`expected success, got ${lines[0]}`);
    assert.equal(parsed.result?.lease, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
'''
new = '''test("status never throws for a fixture with no resolvable GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-cli-status-"));
  const ambient = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_REPO: process.env.GH_REPO,
  };
  try {
    await exec("git", ["init", "-q", root]);
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REPOSITORY = "ambient/should-not-bind";
    process.env.GH_REPO = "ambient/should-not-bind";
    const lines: string[] = [];
    const code = await runCli(["status", "--issue", "7"], { cwd: root, stdout: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { ok: boolean; result?: { lease?: unknown } };
    if (!parsed.ok) assert.fail(`expected success, got ${lines[0]}`);
    assert.equal(parsed.result?.lease, null);
  } finally {
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
'''
if old not in tests:
    raise SystemExit("expected no-resolvable-GitHub-repository CLI test not found")
tests = tests.replace(old, new, 1)
test_path.write_text(tests)
