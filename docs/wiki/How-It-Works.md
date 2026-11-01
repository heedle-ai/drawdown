## Where the data comes from

[[/images/sources.svg|alt=Where drawdown's data comes from]]

| Data | Source | How |
|---|---|---|
| Compile check and plan | draft | `draft.Compile` against the server's command registry |
| Starting a run | loom | `loom.Submit`: workflow ID from the run input, joins an identical run in progress |
| Status and timing | Temporal | `ListWorkflow` with the visibility query `WorkflowType = 'LoomRun' AND TaskQueue = '<queue>'` (up to 200), and `DescribeWorkflowExecution`. Every call times out after 5 seconds |
| Program, plan, outputs | warp | The run's commit, found by its `Shuttle-Run` trailer with `git log --grep`, read with `git` |
| The runs list's records | warp | The latest 200 commits (`git log -n 200`). Each record's program is read once and cached by tree ID: trees are content-addressed and never change, so the cache can't go stale |
| Diffs | warp | `git diff` between two commits |

The page asks for the runs list again 2 seconds after each reply, so slow replies never pile up. A run's page polls only while the run is in progress, or finished but not yet recorded.

A run appears in the list as soon as Temporal knows about it. Once it's recorded, the row also shows its commit. Records whose execution Temporal no longer lists (retention expired, or Temporal unreachable) still appear, with status *Recorded*: warp is the permanent history.

## API

All responses are JSON except the diff, which is plain text.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/info` | | `ref` (the default history), `temporalUI`, `namespace`, `commands`, `examples` |
| `GET /api/refs` | | `{"refs": [...], "default"}`: every history under `refs/loom/`, and the default one even before its first run |
| `GET /api/beliefs?ref=` | | `{"ref", "beliefs": [...]}`: the latest run of every question asked on that history (`loom.Beliefs`), each with `program`, `outputs` and `leaves` |
| `POST /api/compile` | `{"program": "…"}` | `{"plan": …}`, or `{"error", "line", "col"}` (200 either way; `line` and `col` only for syntax errors) |
| `POST /api/runs` | `{"program": "…", "ref": "…"}` (`ref` optional) | 202 `{"workflowId", "runId"}`; 422 with the compile error; 502 if Temporal refuses |
| `GET /api/runs?ref=` | | `{"runs": [...]}`, newest first, plus `temporalError` if Temporal is unreachable. Merge commits are rows with status `Merged`, the commit merged in (`merged`), the first parent (`parent`) and the number of resolved conflicts (`resolved`) |
| `GET /api/runs/{workflow}/{run}?ref=` | | `execution` (from Temporal), `record` (from warp: commit, program, plan, outputs, `previous`, `parent`). 404 with Temporal's error if neither knows the run |
| `GET /api/diff/{from}/{to}` | | Unified diff text. 400 unless both are full commit IDs |

Requests are limited to 1 MB, and unknown JSON fields and trailing data are rejected. Every `ref` (query parameter or body field) is optional and defaults to the server's `-ref`; otherwise it must be a valid ref under `refs/loom/` (400 if not).

## Histories

The header's **history** selector switches between refs: the default one and every [branch](https://github.com/heedle-ai/loom/wiki/Branching-and-Merging) under `refs/loom/`. Runs submitted from the page are recorded on the selected history. Each history shows:

- **Beliefs:** for every question asked on it, the latest answer (the run's leaf outputs).
- **Runs:** its own records, and Temporal's executions for it. loom's `Submit` stores the ref in each workflow's memo (`loom-ref`), so a running execution appears only on its own history's list; an execution without the memo is shown on the default history.
- **Merges:** a `Merged` row per merge commit. Clicking it shows the diff from the first parent: the beliefs that came in, and any re-run.

Branching and merging are done with `loom branch` and `loom merge`; the UI only reads and submits.

## Security

drawdown has no login. It's meant for your own machine, so it listens on `127.0.0.1` by default. Because a web page on any other site can still send requests to localhost, every request is checked:

| Check | Stops |
|---|---|
| `POST` bodies must be `Content-Type: application/json` (415 otherwise) | A hidden HTML form on another site submitting a run |
| An `Origin` header must match the host the UI was opened on (403 otherwise) | Scripts on another site calling the API |
| The `Host` header must be localhost, a loopback address, or listed with `-hosts` (403 otherwise) | DNS rebinding: another site pointing its own name at your machine |

All page content is rendered as text by React, mermaid runs with `securityLevel: "strict"` and graph IDs are positions rather than plan data, and diff2html escapes diff content.

Every response also carries a **Content-Security-Policy**: scripts only from drawdown itself and `cdn.jsdelivr.net`, network requests only to drawdown, no plugins, no framing. If a library were ever compromised past its integrity hash, it still couldn't send your data anywhere else. Inline styles are allowed because mermaid draws with them.

The server reads warp only through the `History` interface (`Resolve`, `Log`, `Tree`, `Blob`, `Parents`, `FindByTrailer`, `Diff`), so it has no way to write history: runs are recorded only by loom's workflow.

These checks are tested in `TestGuard_RefusesCrossSiteAndRebinding`, `TestPage` (the policy) and `TestInv_UIOnlyReadsHistory`.

## The page

`static/index.html` and `static/app.js`, embedded in the binary. No build step: the libraries load from jsDelivr, each pinned to an exact version with a Subresource Integrity hash, so the browser refuses a file that doesn't match.

| Library | Version | Used for |
|---|---|---|
| React, ReactDOM | 18.3.1 (UMD) | Components |
| htm | 3.1.1 | JSX-style markup without a compiler |
| mermaid | 10.9.1 | Plan graphs, with `securityLevel: "strict"` |
| diff2html | 3.4.48 | Diff view |

## Tested

- [Invariants](Invariants) lists every guarantee and its guard; CI checks it against the code.
- `server_test.go` covers every endpoint, the security checks, the 200-record bound, and Temporal being down, against a fake Temporal that really runs plans in Temporal's test suite and records them with loom's `Recorder`, so compiles, runs, records and diffs are real.
- The page was driven in headless Chromium through the whole hello world story: a live syntax error with position, the plan graph, a run, changed evidence, and the diff. The libraries were served from their npm packages, which also checked the integrity hashes. The screenshots on these pages come from that run. That browser run isn't in CI; the API behaviour it exercises is.
