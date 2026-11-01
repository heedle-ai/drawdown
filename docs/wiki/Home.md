**drawdown** is heedle-ai's web UI. Write a [draft](https://github.com/heedle-ai/draft/wiki) program, run it on Temporal through [loom](https://github.com/heedle-ai/loom/wiki), and browse every run's record in [warp](https://github.com/heedle-ai/warp/wiki).

[[/images/new-run.png|alt=Writing a program: live compile check and plan graph]]

| Page | What it shows |
|---|---|
| **New run** | An editor that compiles as you type: errors with line and column, or the plan as a graph. Example programs to load. A Run button |
| **Runs** | Every run, newest first: status from Temporal, the program, timing, and its warp commit. Refreshes every 2 seconds |
| **Run detail** | Status, workflow and run IDs, a link into Temporal's Web UI, the program, the plan graph and every node's output |
| **Compare** | A diff between this run and the previous run of the same program, or the record before it. Shows exactly which evidence changed |

[[/images/sources.svg|alt=Where drawdown's data comes from]]

drawdown only reads and submits. It never edits history; every run goes through loom's workflow, so it's recorded and retried like any other.

## Pages

- [Getting Started](Getting-Started): run it and try the hello world in the browser
- [How It Works](How-It-Works): the API, where each piece of data comes from, and the page's libraries
- [Invariants](Invariants): every guarantee, the test or check that guards it, and the mistake it came from
- [Contributing](Contributing)

## Where drawdown fits

| Repo | Role |
|---|---|
| [weft](https://github.com/heedle-ai/weft/wiki) | Composition algebra |
| [draft](https://github.com/heedle-ai/draft/wiki) | Language: s-expressions that compile to shuttle plans |
| [shuttle](https://github.com/heedle-ai/shuttle/wiki) | Durable execution on Temporal |
| [bobbin](https://github.com/heedle-ai/bobbin/wiki) | A fresh Podman container per agent step |
| [warp](https://github.com/heedle-ai/warp/wiki) | Content-addressed store |
| **drawdown** | Web UI (this repo) |
| [loom](https://github.com/heedle-ai/loom/wiki) | Runs them together: compile, execute, record |
