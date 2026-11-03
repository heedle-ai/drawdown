**drawdown** is heedle-ai's web UI. Write a [draft](https://github.com/heedle-ai/draft/wiki) program, run it on Temporal through [loom](https://github.com/heedle-ai/loom/wiki), and browse every run's record in [warp](https://github.com/heedle-ai/warp/wiki).

[[/images/new-run.png|alt=drawdown's home page: the agents, and a program being written with its composition graph: three sources side by side, then an assessment]]

| Page | What it shows |
|---|---|
| **Drawdown** | Recent runs, woven: one column per run, one square per step, coloured by the kind of step, with the run's status along the top. Hover for details; click a column to open the run, a square to open the step |
| **New run** | An editor that compiles as you type: errors with line and column, or the program's composition as a graph. Example programs, and a button per command that inserts it |
| **Runs** | Every run, newest first: status, the program with its commands coloured, when it started, how long it took relative to the others, and its warp commit |
| **Run** | Status and IDs, the timeline of every step as Temporal ran it, the composition graph (groups fold, every step opens in place, with links to its inspector, skill, diff, record and Temporal history) and each step's output |
| **Schedules** | Programs Temporal runs on a timer, each run recorded like any other; run one now, pause, resume or delete it |
| **Connectors** | The MCP servers agent steps can use, and where each key is found; paste a key once and it goes to your keychain |
| **Step** | What one step was given, where it ran and what it could touch, what it decided, what it produced, and which steps it never saw |
| **Compare** | A diff between this run and the previous run of the same program, or the record before it |

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
| [reed](https://github.com/heedle-ai/reed/wiki) | A fresh browser per browsing step, reaching only the hosts its program names |
| [pirn](https://github.com/heedle-ai/pirn/wiki) | Claude for agent steps: answers from the step's inputs, recorded with them |
| [warp](https://github.com/heedle-ai/warp/wiki) | Content-addressed store |
| **drawdown** | Web UI (this repo) |
| [loom](https://github.com/heedle-ai/loom/wiki) | Runs them together: compile, execute, record |
