# Fresh consumer fixture

This disposable example is the smallest documented project-owned surface for
Pi-next. It contains only `.pi-next/config.json` and a consumer policy file;
the runtime is installed through Pi's native project-local Git package
mechanism.

The deterministic smoke test supplies an in-memory authority and temporary Git
repositories. Real consumers should use `authority.adapter: "github"` (or a
consumer adapter), pin an immutable release tag, and provide credentials only
through their host environment.
