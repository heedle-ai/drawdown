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

All responses are JSON except the diffs, which are plain text.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/info` | | `ref` (the default history), `temporalUI`, `namespace`, `commands`, `examples` |
| `GET /api/refs` | | `{"refs": [...], "default", "heads"}`: every history under `refs/loom/`, the default one even before its first run, and each one's head commit |
| `GET /api/beliefs?ref=` | | `{"ref", "beliefs": [...]}`: the latest run of every question asked on that history (`loom.Beliefs`), each with `program`, `outputs` and `leaves` |
| `POST /api/compile` | `{"program": "…"}` | `{"plan": …}`, or `{"error", "line", "col"}` (200 either way; `line` and `col` only for syntax errors) |
| `POST /api/runs` | `{"program": "…", "ref": "…"}` (`ref` optional) | 202 `{"workflowId", "runId"}`; 422 with the compile error; 502 if Temporal refuses |
| `GET /api/runs?ref=` | | `{"runs": [...]}`, newest first, plus `temporalError` if Temporal is unreachable. Merge commits are rows with status `Merged`, the commit merged in (`merged`), the first parent (`parent`) and the number of resolved conflicts (`resolved`) |
| `GET /api/runs/{workflow}/{run}?ref=` | | `execution` (from Temporal), `record` (from warp: commit, program, plan, outputs, `previous`, `parent`, and `files`: for each step, the files its record holds under `files/<node>/`, each with `path`, `size`, `blob`, `before` and `status` (`added`, `changed`, `same` or `deleted`) against `previous`; every file of both runs is compared, then at most 500 are listed in all, in node then path order, then `moreFiles`). 404 with Temporal's error if neither knows the run |
| `GET /api/live/{workflow}` | | `{"frames": [{"activity", "attempt", "url", "image"}]}`: the latest heartbeat frame of each browsing step the run is executing, read with `DescribeWorkflowExecution` on its plan (`<workflow>/plan`); `temporalError` if Temporal is unreachable |
| `GET /api/steps/{workflow}/{run}` | | `{"steps": [...]}`: each step as Temporal's history records it, in order, then loom's record: `node`, `activity`, `status`, `attempts`, `scheduled`, `started`, `closed`, and the last `failure` (at most 2 KiB). With Temporal unreachable: no steps and `temporalError`, still 200 |
| `GET /api/diff/{from}/{to}` | | Unified diff text. 400 unless both are full commit IDs |
| `GET /api/skills` | | `{"skills": [...], "pending": [...], "problems": [...]}`: the newest version of every skill in the store (treadle's `Library.Skills`), each with `name`, `description`, `version`, `commit` and, if imported, `source`; the imports waiting for review (`Library.Pending`), each with `"pending": true`; and why any skill or import can't be used |
| `GET /api/writes/{workflow}` (a run's workflow ID, or a merge re-run's, `…/rerun-N`) | | `{"writes": [...]}`: a running run's queued writes so far and their status (loom's `WritesQuery`); a finished run's are in its record (`record.writes`, from `writes.json`). 400 for anything but a run's workflow ID, 502 if Temporal fails |
| `POST /api/writes/{workflow}` | `{"node", "id", "approve"}` | Approves or declines one write waiting for approval by signalling the run (loom's `WriteSignal`); the page never runs a write. Answers the run's writes |
| `POST /api/write` | `{"description"}` | Has a worker's Claude write a program for the task (loom's `WriteProgramWorkflow`), from its commands and skills; answers `{"program", "plan", "attempts"}`. Nothing runs. 400 for an empty or overlong description, 422 if no program compiled, 502 if Temporal or the worker failed |
| `POST /api/skills/create` | `{"description"}` | Has a worker's agent write a skill and its test from the description (loom's `SkillsCreate`); answers `{"skill"}`, waiting for review. Takes as long as an agent step |
| `POST /api/skills/import` | `{"link", "path", "branch"}` | Imports a skill from a GitHub link, or an `https://` repository URL with its folder and branch (treadle's `SourceFor`; never `file://`, which would read the worker's disk), by running loom's skills workflow on a worker; `{"skill"}`, with `"pending": true` if it waits for review. 400 with the reason if refused, 502 if Temporal or the worker failed |
| `POST /api/skills/add` | `{"files": {"PATH": "BASE64", ...}}` | Adds a folder given by hand (pasted or uploaded), at most 1 MiB, through the same workflow; it needs no review |
| `POST /api/skills/{name}/approve` | `{"version", "replaces"}` | Approves exactly the version the review showed, against the version its diff was from (`replaces`, empty for a new skill) |
| `POST /api/skills/{name}/reject` | `{"version"}` | Rejects exactly that version |
| `GET /api/skills/{name}/review` | | `{"skill", "replaces", "current", "files": [{"path", "size"}], "skillMD", "diff", "binary"}`: the import of the skill waiting for review (treadle's `Library.Review`), the version it would replace (`replaces` empty and `current` absent for a new skill), its unified diff from it, and the files git takes for binary, which the diff can't show; a diff over `MaxReviewDiff` (1 MiB) is left out, with `diffTooLarge` its size. 404 if nothing is waiting |
| `GET /api/skills/{name}` | | `{"versions": [...]}`: every version of the skill, newest first. 404 if there's no such skill, 400 for a name a skill can't have |
| `GET /api/skills/{name}/{version}` | | `{"skill", "files": [{"path", "size"}], "skillMD"}`: one version's files and its `SKILL.md` (treadle's `Library.Folder`), only for a version that was added to that skill and is within pirn's limits (404 if it isn't that skill's, even for another tree in the store; 400 if it's over the limits) |
| `GET /api/blobdiff/{from}/{to}` | | One file's change: the unified diff of two blobs (warp's `DiffBlobs`), binary content reported but never printed. 400 unless both are full blob IDs; 413 if either is over 1 MiB (`MaxDiffBlob`), naming the `git diff` to run instead. Like `/api/diff`, it serves any object in the store by its full ID |

Requests are limited to 1 MB, and unknown JSON fields and trailing data are rejected. Every `ref` (query parameter or body field) is optional and defaults to the server's `-ref`; otherwise it must be a valid ref under `refs/loom/` (400 if not).

## Histories

The header's **history** selector switches between refs: the default one and every [branch](https://github.com/heedle-ai/loom/wiki/Branching-and-Merging) under `refs/loom/`. Runs submitted from the page are recorded on the selected history. Each history shows:

- **Beliefs:** for every question asked on it, the latest answer (the run's leaf outputs).
- **Runs:** its own records, and Temporal's executions for it. loom's `Submit` stores the ref in each workflow's memo (`loom-ref`), so a running execution appears only on its own history's list; an execution without the memo is shown on the default history.
- **Merges:** a `Merged` row per merge commit. Clicking it shows the diff from the first parent: the beliefs that came in, and any re-run.

Branching and merging are done with `loom branch` and `loom merge`; the UI only reads and submits.

## Agents, one tab each

[[/images/agents.png|alt=drawdown's Agents list: runs and its sub-agent web, each with its head commit and an Open tab link]]

Every ref under `refs/loom/` is an **agent**. Its sub-agents are the refs that extend its name with a dot: `research.web` is a sub-agent of `research`, and `research.web.pricing` of `research.web`. (Dots, not slashes: Git can't hold both `refs/loom/research` and `refs/loom/research/web`.) Make a sub-agent by branching: `loom branch -from refs/loom/research -to refs/loom/research.web`. The tree is drawn from the refs every time; drawdown keeps no list of its own.

**Open tab ↗** opens the agent in a browser tab named after it (`target="heedle-agent-research.web.pricing"`), so opening it again, from anywhere, focuses that same tab instead of piling up new ones. Each agent's tab is titled with its name and gets a coloured dot as its icon, one colour per family (the first part of the name). This works in any browser; it needs no extension. (Chrome's tab groups would need one, so they're not used.)

[[/images/agent-tab.png|alt=An agent's tab: its name, head commit and record count, then its own drawdown of recent runs, its beliefs, a new-run box and its runs]]

An agent's tab (`#/agent/<ref>`) shows:

- **Drawdown:** this agent's recent runs, woven, as on the home page.
- **Running now:** for each running run, the live view of its browsing steps: the latest frame of each [reed](https://github.com/heedle-ai/reed/wiki) browser, from Temporal, refreshed every 2 seconds. It's view only.
- **Beliefs, Runs and New run,** for this agent's history. A run submitted here is recorded on this agent.
- **Family:** its parent and sub-agents, each a link to its own tab.

A browse step's output (reed's JSON) is shown as the page it saw: the screenshot, title, URL, allowlist and blocked requests, with the page text behind a fold. Images from outputs and live frames are shown only if they're JPEG data URLs.

## The woven grid and its calendar

The home page weaves the recent runs: one column per run, its top edge coloured by status, one cell per step coloured by the kind of step. Beside it are counts by status and by kind, and a **calendar** of the month. Each day is tinted by how many runs started that day (in your time zone) among the latest records the page reads: up to 200 records from Git, and Temporal's latest executions. Merges aren't counted as runs. A red dot marks a day where a run failed. Choosing a day shows only that day's runs, in the grid and in the runs table, until you choose it again or **Show every day**. A chosen day stays clickable even if it no longer has runs among the latest records, and changing history clears the choice. The arrows move between months. Each day's text is whichever of the theme's text colours reads best on its tint, and the tint is kept where that reaches WCAG's 4.5:1. The logic is `lib.js`'s `dayKey`, `byDay`, `monthGrid`, `onDay` and `tint`, which `ui/lib.test.js` checks.

## Runs, steps and the graph

[[/images/run-detail.png|alt=A run's page: status and info pills, the program, the timeline of its steps with a retry badge, the plan graph, and output cards for two web pages and Claude's answer]]

A run's page puts its **timeline** first: one lane per step, read from Temporal's own history (`/api/steps`). A hatched bar is the time a step waited for a worker; a solid bar, the time it ran; moving stripes, a step still running. A red badge counts attempts when Temporal retried a step. When a plan fails, shuttle stops at the first failure; the steps it never heard back from are shown faded as **Abandoned** at the moment the run ended. Hovering a bar shows its timings, attempts, the failure that caused a retry, and the start of its output.

The **plan graph** is drawn small, coloured by the kind of each step. Every step in it opens that step, every arrow shows what it carries, and the expand button opens it full screen to pan, zoom and follow the links:

[[/images/graph.png|alt=The plan graph opened full screen, with zoom, fit and close buttons]]

Under the run's header, **Provenance** shows where its record sits in Git. It names the same program's previous run, the record before it, and this run's own commit, and a click on either earlier record opens the diff from it to this one. It also gives the full commit, the history (ref) it was recorded on, and the Temporal workflow and run that produced it, linked to their event history in Temporal's Web UI.

Clicking a step, here or in the drawdown on the home page, opens the **step inspector** (`#/step/<workflow>/<run>/<node>`):

[[/images/step.png|alt=The step inspector for an ask step: given two web pages, ran as one request to Claude with no files and only the Claude API, decided with model, tokens and citations, produced its answer]]

- **Given:** exactly what was shared with the step: its parents' outputs, nothing else.
- **Ran in:** where it ran and what it could touch: files, network, what it gets and what it leaves. For a container or browse step this is a fresh container, removed afterwards, with nothing mounted. A container step has no network at all; a browse step's limit is Chromium's own settings, on a container that does have a network. `TestInv_InspectorTellsTheTruth` checks these claims against bobbin's and reed's real code.
- **Decided:** what the step concluded: an assessment's verdict, a page's final URL and refused requests, Claude's model, tokens and citations. And any failure Temporal retried past.
- **Work**, for an agent step: every command Claude ran in its container, in order, with exit code, time and output; the files it kept from `/work/out`; and every path that changed in the container.
- **Files**, for a step whose record holds files (an agent's `/work/out`, recorded by loom under `files/<node>/`): each file with its size, marked added, changed, the same or deleted against the previous run of the same program. A changed file opens to its diff; an added text file of an agent step opens to its contents. A file the agent kept in an OCI registry, being too big for the record, is marked *in the registry* and opens to the `oras blob fetch` command that gets it back.
- **Produced:** its output, where it is in Git (`outputs/<node>` in the run's commit), and the steps it was passed to.
- **Not shared with this step:** every other step whose output was never given to it, marked as running alongside, running after it, or reaching it only through its parents. What its parents passed on may still include parts of those outputs.

## Describing a task

**New run** starts with **Describe a task**: Claude, on a worker, writes the program from the commands and skills the worker has (loom's [program writer](https://github.com/heedle-ai/loom/wiki/How-It-Works#writing-programs)). The program goes into the editor, which compiles it and draws its plan, so you see every step before anything runs; Run submits it like any program.

## Writes

A run whose agent steps queued writes ([loom → Writes](https://github.com/heedle-ai/loom/wiki/How-It-Works#writes)) shows them under **Writes** on its page: each connector and tool, its input, its status, and what came of it. While the run waits for approval, a write that needs it has **Approve** and **Decline** buttons; deciding signals the run, which runs the write once if approved. An agent step's own page lists every connector call it made (run by Anthropic's MCP connector or on the worker) and every write it queued, with what the step was granted. Inputs, outputs and errors are shown as text, with control and invisible format characters as `⟨U+XXXX⟩`.

drawdown's own worker (`-worker`) takes the same `-connectors FILE` as `loom worker`.

## Skills

The **skills** link opens the Skills page (`#/skills`): every skill the store keeps ([treadle](https://github.com/heedle-ai/treadle/wiki)), with its description, newest version, and whether it was imported. A skill's page (`#/skill/<name>`) shows its `SKILL.md` as text, its files with their sizes, and every version, newest first, with where each was imported from; for a GitHub source, a link to the exact folder at the exact commit, built only from checked parts so it can only point at github.com.

Wherever a step follows a skill, it says so with a badge naming the skill and the version its plan pins, linking to that version: on the graph (`n1 weather @72ba7cf "Boston"`), in hover cards, in the run's outputs and in the step inspector. A run that pinned an older version opens that version, marked *not the newest*.

Imports from repositories that aren't trusted wait for review (treadle's [trust levels](https://github.com/heedle-ai/treadle/wiki/How-It-Works#trust-and-review)) and are listed apart, under *Waiting for review*; no program can use one. Its review page (`#/review/<name>`) shows its source, its diff from the version it would replace (every file, for a new skill), any files the diff can't show because git takes them for binary, its `SKILL.md` and files (control and invisible format characters shown as `⟨U+XXXX⟩`), and **Approve** and **Reject** buttons that act on exactly the version shown (and, to approve, the version its diff is from). The `loom skills -approve` and `-reject` commands for the same versions are shown too.

**Describe a skill** has Claude write one, with a test it runs, in an agent step on a worker; the skill then waits for review, showing the description it came from. A skill that asks for connectors says so on its page, and its review flags it.

The Skills page also adds skills: import a GitHub link (or a repository URL with its folder and branch), paste a `SKILL.md`, or upload a folder of up to 1 MiB (hidden files left out, as `loom skills -add` does; bigger folders with `loom skills -add`). A pasted or uploaded skill is yours, so it needs no review; an import from a repository that isn't trusted waits for it. Trusted prefixes are set only at the terminal (`loom skills -trust`). drawdown has no login: anyone who can use the page can add a skill, and approve one, so trust levels guard against what's imported, not against the page's users; keep drawdown on loopback (its default) unless everyone who can reach it may change skills.

drawdown still never writes to the store: every change runs loom's skills workflow ([loom → Changing skills](https://github.com/heedle-ai/loom/wiki/How-It-Works#changing-skills)) on a worker, so it needs one running, `-worker` or `loom worker`. Every compile uses the store's newest skills (read again only when a skill has changed), so a skill added or approved can be used at once, without restarting anything. A change that no worker finishes within loom's `SkillsTimeout` is reported as failed and dropped, never made later.

## Security

drawdown has no login. It's meant for your own machine, so it listens on `127.0.0.1` by default. Because a web page on any other site can still send requests to localhost, every request is checked:

| Check | Stops |
|---|---|
| `POST` bodies must be `Content-Type: application/json` (415 otherwise) | A hidden HTML form on another site submitting a run |
| An `Origin` header must match the host the UI was opened on (403 otherwise) | Scripts on another site calling the API |
| The `Host` header must be localhost, a loopback address, or listed with `-hosts` (403 otherwise) | DNS rebinding: another site pointing its own name at your machine |

All page content is rendered as text by React, mermaid runs with `securityLevel: "strict"` and graph IDs are positions rather than plan data, and diff2html escapes diff content.

Every response also carries a **Content-Security-Policy**: scripts only from drawdown itself and `cdn.jsdelivr.net`, network requests only to drawdown, no plugins, no framing. If a library were ever compromised past its integrity hash, it still couldn't send your data anywhere else. Inline styles are allowed because mermaid draws with them.

The server reads warp only through the `History` interface (`Resolve`, `Log`, `Tree`, `Blob`, `Blobs`, `Parents`, `FindByTrailer`, `Diff`, `Refs`), so it has no way to write history: runs are recorded only by loom's workflow.

These checks are tested in `TestGuard_RefusesCrossSiteAndRebinding`, `TestPage` (the policy) and `TestInv_UIOnlyReadsHistory`.

## The page

`static/index.html`, `static/lib.js` and `static/app.js`, embedded in the binary. `lib.js` holds the page's pure logic (reading outputs, durations, the timeline's span), which CI tests with Node (`node --test ui/lib.test.js`); every step output is read through its checked parse, so JSON that only looks like a page or an answer is shown as text. No build step: the libraries load from jsDelivr, each pinned to an exact version with a Subresource Integrity hash, so the browser refuses a file that doesn't match.

| Library | Version | Used for |
|---|---|---|
| React, ReactDOM | 18.3.1 (UMD) | Components |
| htm | 3.1.1 | JSX-style markup without a compiler |
| mermaid | 10.9.1 | Plan graphs, with `securityLevel: "strict"` |
| diff2html | 3.4.48 | Diff view |

Its two fonts, Bricolage Grotesque and JetBrains Mono, are served by drawdown itself from `static/fonts`, with their SIL Open Font License files, so the Content-Security-Policy keeps fonts to this server (`TestInv_FontsAreServedHere`).

## Tested

- [Invariants](Invariants) lists every guarantee and its guard; CI checks it against the code.
- `server_test.go` covers every endpoint, the security checks, the 200-record bound, and Temporal being down, against a fake Temporal that really runs plans in Temporal's test suite and records them with loom's `Recorder`, so compiles, runs, records and diffs are real.
- The agent tabs were driven in headless Chromium against real records: reed visited a test site from a real browser in Podman, and its pages and a live frame were served through the fake Temporal. Checked: the tree, the named tab target, that opening an agent twice reuses its tab, each tab's title and icon, the live view, and recorded pages with their blocked requests. `TestInv_AgentTabs` checks the tab code in CI.
- The redesigned pages (drawdown, timeline, graph, step inspector) were driven in headless Chromium in light and dark mode against demo records and a stand-in Temporal, with no console errors; the screenshots on these pages come from that run. The API they use is tested in CI (`TestInv_StepsComeFromTemporalHistory`, `TestSteps_ReportsTemporalErrorsWithoutFailing`).
- The page was first driven in headless Chromium through the whole hello world story: a live syntax error with position, the plan graph, a run, changed evidence, and the diff. The libraries were served from their npm packages, which also checked the integrity hashes. That browser run isn't in CI; the API behaviour it exercises is.
