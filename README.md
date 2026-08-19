# pi-next

Autonomous issue implementation loop for the pi-coding-agent host.

## Development

Requires Node.js 20.10+, Git, and pi-coding-agent 0.84.2+. Install with `npm ci`, then run:

```sh
npm run typecheck
npm test
```

The extension is loaded from `extensions/pi-next.ts`. Harness-neutral issue
lease, compare-and-swap, and worktree coordination is published from
`src/coordination/`; it has no dependency on a consumer project's `.agents`
tree. Runtime state is kept under `.pi/` and issue worktrees under
`.worktrees/`, both ignored by Git.

The sibling `local-llm-tools` and `rtk-optimizer` extensions were intentionally
left out: they depend on consumer-project configuration and are not pi-next
core dependencies.
