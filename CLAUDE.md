# drawdown

heddle's UI for commits, diffs and provenance. Part of heddle:
weft (algebra) → warp (object store) → shuttle (execution) → drawdown (UI).

## Rules for every change

1. **Keep the wiki current.** Any change that affects how a developer
   installs, builds, tests, uses or understands this repo updates the wiki
   in the same piece of work: https://github.com/heddle/drawdown/wiki
   (git: `https://github.com/heddle/drawdown.wiki.git`). Code, README and wiki
   must never disagree. If the wiki can't be updated, say so explicitly.
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

- Read-only over warp to start. Execution details link out to Temporal's Web
  UI rather than being rebuilt here.
- The stack isn't chosen yet; record the decision and its reasons in the wiki
  when it is.
