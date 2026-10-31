# drawdown

heedle-ai's web UI: write, run and browse programs and their records. Part of heedle-ai:
weft (algebra) → draft (language) → shuttle (execution) → warp (object store) → drawdown (UI);
loom runs them together.

## The first rule: reuse, never rewrite

Build on battle-tested tools (Git, Temporal, the Go standard library and
other long-proven software) through their public interfaces. Add on top of
them; never fork, patch, mutate or reimplement them. Prefer the real tool to
a reimplementation of it (for example the `git` CLI over a Go port of Git).
If a task seems to need a rewrite, stop and ask the owner first, explaining
why the existing tool can't do it.

## Rules for every change

1. **Keep the wiki current.** Any change that affects how a developer
   installs, builds, tests, uses or understands this repo updates
   `docs/wiki/` in the same commit or PR. That folder is the source of truth;
   `.github/workflows/wiki.yml` mirrors it to
   https://github.com/heedle-ai/drawdown/wiki on every push to `main`. Never edit
   the wiki on GitHub directly: the next sync overwrites it. Code, README and
   wiki must never disagree.
2. **Wiki quality bar.** Every command is copy-pasteable and has been run.
   Every code snippet compiles and is checked by a test; prefer quoting a
   Go `Example` test with an `// Output:` comment. State required versions.
   No placeholders, TODOs or "coming soon" on published pages. Mark design
   that isn't built yet as **Planned**, plainly.
3. **Platforms: Linux (amd64, arm64) and macOS on Apple Silicon only.** Don't
   write Windows instructions, scripts, CI jobs or path handling.
4. **Bare minimum.** Add only what the task needs. No speculative packages,
   dependencies or abstractions.
5. **Tests pass before commit:** `go vet ./...` and `go test -race ./...`.

## Repo-specific

- **Read and submit only.** The UI never edits history: it compiles with
  draft, submits through loom, and reads Temporal and warp. All writes go
  through loom's workflow.
- **No build step.** The page is `static/index.html` plus `static/app.js`:
  React 18 (UMD), htm, mermaid and diff2html from jsDelivr, each pinned to
  an exact version with a Subresource Integrity hash. To upgrade a library,
  change the version and recompute its hash from the npm package file.
- **Never put unescaped data in HTML.** React escapes text; mermaid runs with
  `securityLevel: "strict"`; diff2html escapes diff content.
- **Every API behaviour has a test** in `server_test.go`, using a fake
  Temporal that really runs plans in Temporal's test suite.
- `go.mod` replaces the heedle-ai modules with `../` checkouts until they
  are published; clone all repos as siblings.
