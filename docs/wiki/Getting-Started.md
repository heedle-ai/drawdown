> **One binary:** [heedle](https://github.com/heedle-ai/heedle/wiki) serves this same UI. `heedle up` starts Temporal, a worker and the UI together. drawdown is also a library, `app.Run`, which takes the flags below.

## 1. Install and clone

```bash
brew install go git temporal       # macOS; on Linux see loom's Getting Started
mkdir -p ~/src/heedle-ai && cd ~/src/heedle-ai
for r in weft draft shuttle warp bobbin reed pirn treadle loom drawdown; do git clone https://github.com/heedle-ai/$r.git; done
```

## 2. Start Temporal and drawdown

Terminal 1:

```bash
temporal server start-dev
```

Terminal 2:

```bash
cd ~/src/heedle-ai/drawdown
go run ./cmd/drawdown -store ~/heedle-store.git
```

```text
drawdown on http://127.0.0.1:8090 (store /Users/you/heedle-store.git, queue "loom", worker true)
```

Open http://127.0.0.1:8090. By default drawdown also runs a loom worker in the same process, so these two terminals are all you need. The worker knows draft's `echo`, the hello world's `source` and `assess`, reed's `browse` (with `-browser-image`), and pirn's `ask`, `agent` and `act` (with `ANTHROPIC_API_KEY` set, `-agent-image` for `agent` and `-browser-agent-image` for `act`; see [Ask Claude](#ask-claude)).

| Flag | Default | Meaning |
|---|---|---|
| `-store` | (required) | warp store directory; created if missing |
| `-listen` | `127.0.0.1:8090` | Address to serve on. drawdown has no login, so keep it on localhost |
| `-address` | `localhost:7233` | Temporal frontend |
| `-temporal-ui` | `http://localhost:8233` | Temporal Web UI, for links |
| `-queue` | `loom` | Task queue for runs; the list shows only runs on this queue |
| `-namespace` | `default` | Temporal namespace, also used for links into Temporal's Web UI |
| `-hosts` | (none) | Extra host names the UI answers to, comma-separated. `localhost` and loopback addresses always work; any other `Host` header is refused |
| `-ref` | `refs/loom/runs` | warp ref runs are recorded on |
| `-worker` | `true` | Also run a loom worker. Set `false` if you run `loom worker` separately. If Temporal is down at startup, the UI still starts and shows recorded history; restart once Temporal is up to run programs |
| `-browser-agent-image` | none | A [reed](https://github.com/heedle-ai/reed/wiki/Getting-Started#6-a-browser-agent-image-for-act) browser-agent image ID, for programs that use `act` (roadmap 9.5). Without it, the front door says act steps can't run, and they fail as setup |
| `-browser-image` | none | A [reed](https://github.com/heedle-ai/reed/wiki/Getting-Started) browser image ID, for programs that use `browse`. Without it, `browse` steps fail with `BrowserSetup` |
| `-browser-network` | Podman's default | The Podman network browse pods join |
| `-ask-model` | `claude-sonnet-5-5` | The Claude model `ask` and `agent` use. The key comes from `ANTHROPIC_API_KEY` in drawdown's environment; without it, `ask` steps fail with `AskSetup` and `agent` steps with `AgentSetup` |
| `-agent-image` | none | A content-pinned image ID with `/bin/sh` that [agent steps](https://github.com/heedle-ai/pirn/wiki/How-It-Works#agent-steps) run in. Without it, `agent` steps fail with `AgentSetup` |
| `-image-registry` | none | An OCI repository, such as `ghcr.io/acme/heedle-images`, that `(image "<Containerfile>" "push")` pushes to, with the worker's own `podman login`; see [bobbin → Image builds](https://github.com/heedle-ai/bobbin/wiki/How-It-Works#image-builds). Without it, such steps fail with `ImageSetup`; builds without `"push"` still work |
| `-agent-registry` | none | An OCI repository, such as `ghcr.io/acme/heedle-files`, where agent files too big for the record are kept, pushed with `oras` and the worker's own login; see [pirn → Large files](https://github.com/heedle-ai/pirn/wiki/How-It-Works#large-files). Without it, they're listed as skipped |
| `-prices` | `prices.json` beside `-connectors`, if given | Your prices file, overriding the built-in Claude prices model by model (USD per million tokens) for the estimates on the run, Schedules and Costs pages and for schedules' budgets; a file that can't be used is said and the built-in prices are used ([loom → Costs and budgets](https://github.com/heedle-ai/loom/wiki/How-It-Works#costs-and-budgets)) |
| `-connectors` | none | A JSON file of the MCP servers agent steps may be granted, with tokens named by environment variable; see [pirn → Connectors](https://github.com/heedle-ai/pirn/wiki/How-It-Works#connectors). Without it, a step that asks for a connector fails with `AgentSetup` |
| `-sources` | loom's `examples/hello/sources` | Folder the `source` command reads |

## 3. Try the hello world

1. Click **Example: shipment**. The composition appears as a graph: three sources side by side (`⊗`), then (`;`) one assessment.
2. Click **Run**. The run page shows *Running*, then *Completed*, with each output. The conclusion is *SUPPORTED, for: factory, weather*.

   [[/images/run-detail.png|alt=A completed run: status, provenance, timeline, composition graph and outputs]]

3. The storm passes. In `~/src/heedle-ai/loom`:

   ```bash
   printf 'on-time\nStorm has passed; the port reopened this morning.\n' > examples/hello/sources/weather.txt
   ```

4. Back on the main page, click **Run** again, then **vs. previous run of this program**. The diff shows exactly the weather evidence and the conclusion changing, and nothing else:

   [[/images/diff.png|alt=Diff between two runs: only the weather source and the conclusion changed]]

5. Click **Open in Temporal Web UI** on any run to see its full execution history there.

Restore the sources afterwards with `git -C ~/src/heedle-ai/loom checkout examples/hello/sources`.

## Ask Claude

Start drawdown with your Anthropic API key in its environment:

```bash
cd ~/src/heedle-ai/drawdown
ANTHROPIC_API_KEY=sk-ant-... go run ./cmd/drawdown -store ~/heedle-store.git
```

Click **Example: ask**, then **Run**. The three shipment sources are read in parallel, then Claude answers from them:

```lisp
(pipe
  (par (source "weather") (source "carrier") (source "factory"))
  (ask "Will the shipment be late? Answer yes or no first, then explain in two sentences, citing the sources that decide it."))
```

The answer shows as text with the model and token counts. Change a source as in step 3, run again, and **vs. previous run of this program** shows how the evidence and Claude's answer changed. See [pirn](https://github.com/heedle-ai/pirn/wiki) for what Claude is sent and how errors are handled.

## See what it costs

Open **Costs** in the top bar for this month's Claude usage by model, and a run's page for its tokens per step. To correct a price, write the models you want to change to a prices file and give it with `-prices` (`heedle up` uses `~/.heedle/prices.json`, beside its connectors file):

```bash
mkdir -p ~/.heedle
printf '{"models": {"claude-sonnet-5-5": {"input": 2, "output": 10}}}\n' > ~/.heedle/prices.json
go run ./cmd/drawdown -store ~/heedle-store.git -prices ~/.heedle/prices.json
```

A schedule's monthly budget is set on the Schedules page.

## Your own programs

Type any program using `echo`, `source`, `assess`, `ask`, `agent` or `browse`. Errors show as you type, with line and column; **Run** is enabled only when the program compiles. To add commands, see [draft → Adding Commands](https://github.com/heedle-ai/draft/wiki/Adding-Commands), and register them in `app/app.go` for both the registry and the worker.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `connect to Temporal at localhost:7233` | The dev server isn't running |
| A run stays *Running* | No worker on the queue: drawdown was started with `-worker=false` and no `loom worker` is running |
| "Temporal: …" error above the runs list | Temporal is unreachable; recorded runs are still listed, with status *Recorded*. Runs that failed aren't recorded, so they only appear while Temporal can list them |
| `host not allowed` | You opened the UI by a host name other than localhost or a loopback address; add it with `-hosts` |
| Blank page | The page loads React and its libraries from cdn.jsdelivr.net; check your network |
