**drawdown** is how you view what heedle-ai knows and how it came to know it.

Under heedle-ai's first rule (reuse battle-tested tools, never rewrite them), drawdown is currently **documentation, not code**. Everything below works today with tools you already have, because every [loom](https://github.com/heedle-ai/loom/wiki) run is a Git commit in a [warp](https://github.com/heedle-ai/warp/wiki) store, linked to a Temporal execution.

## Views available today

| View | Tool | Command |
|---|---|---|
| History of runs | `git log` | `git --git-dir ~/heedle-store.git log --format='%h %s%n%(trailers:only,unfold)' refs/loom/runs` |
| One run's contents | `git ls-tree`, `git show` | `git --git-dir ~/heedle-store.git ls-tree -r --name-only refs/loom/runs` |
| A program or an output | `git show` | `git --git-dir ~/heedle-store.git show refs/loom/runs:outputs/n2` |
| What changed between runs | `git diff` | `git --git-dir ~/heedle-store.git diff --stat refs/loom/runs~1 refs/loom/runs` |
| Integrity | `git fsck` | `git --git-dir ~/heedle-store.git fsck --strict` |
| Execution: timings, retries, event history | Temporal Web UI | http://localhost:8233, searching for the commit's `Shuttle-Workflow` trailer |
| Browsing in a web page | GitHub | `git --git-dir ~/heedle-store.git push <private remote> refs/loom/runs` (**private** repositories only) |

These commands are run against a real store in [loom → Getting Started](https://github.com/heedle-ai/loom/wiki/Getting-Started#5-inspect-runs-with-git).

## Not built: a dedicated UI

A provenance view (which conclusions depend on which sources) needs data warp doesn't record yet, and a UI for it would be new code. Under the first rule, building one is a decision for the project owner, made when the existing tools stop being enough.
