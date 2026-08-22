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
  const root = await mkdtemp(join(tmpdir(), "pi-next-cli-noauth-"));
  try {
    await exec("git", ["init", "-q", root]);
    // No GitHub remote/repo is configured for this fixture, so the ref
    // lookup behind `status` cannot resolve one; the CLI must still return
    // exactly one structured JSON result (an absent lease), never throw.
    const result = await runCoordinationCli(["status", "--issue", "7", "--cwd", root]);
    if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result)}`);
    assert.equal(result.command, "status");
    assert.equal(result.lease, null);
    assert.equal(result.fresh, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
'''
new = '''test("status never throws for a fixture with no resolvable GitHub repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-next-cli-noauth-"));
  const ambient = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GH_REPO: process.env.GH_REPO,
  };
  try {
    await exec("git", ["init", "-q", root]);
    // Ambient automation metadata must not turn a no-remote fixture into
    // whichever GitHub repository happens to host the test process.
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REPOSITORY = "ambient/should-not-bind";
    process.env.GH_REPO = "ambient/should-not-bind";
    const result = await runCoordinationCli(["status", "--issue", "7", "--cwd", root]);
    if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result)}`);
    assert.equal(result.command, "status");
    assert.equal(result.lease, null);
    assert.equal(result.fresh, false);
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
