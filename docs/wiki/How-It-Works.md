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
| `GET /api/info` | | `ref` (the default history), `temporalUI`, `namespace`, `commands`, `skills` (the commands that are skills), `about` (what each built-in command does, in a line: loom's `BuiltinCommands`, as its program writer tells Claude; the page reads only its own names from it), `examples` |
| `GET /api/refs` | | `{"refs": [...], "default", "heads"}`: every history under `refs/loom/`, the default one even before its first run, and each one's head commit |
| `GET /api/beliefs?ref=` | | `{"ref", "beliefs": [...]}`: the latest run of every question asked on that history (`loom.Beliefs`), each with `program`, `outputs` and `leaves` |
| `POST /api/compile` | `{"program": "…"}` | `{"plan": …, "shape": …, "actHosts": […]}` (`actHosts`: where its act steps may act) (`shape` is the program's composition, or null; see [the graph](#runs-steps-and-the-graph)), or `{"error", "line", "col"}` (200 either way; `line` and `col` only for syntax errors) |
| `POST /api/runs` | `{"program": "…", "ref": "…", "actHosts": […]}` (`ref` optional; `actHosts` the hosts shown for its act steps) | 202 `{"workflowId", "runId"}`; 422 with the compile error, or `{"error", "actHosts"}` when it has act steps and `actHosts` isn't exactly theirs; 502 if Temporal refuses |
| `GET /api/runs?ref=` | | `{"runs": [...]}`, newest first, plus `temporalError` if Temporal is unreachable. Merge commits are rows with status `Merged`, the commit merged in (`merged`), the first parent (`parent`) and the number of resolved conflicts (`resolved`) |
| `GET /api/runs/{workflow}/{run}?ref=` | | `execution` (from Temporal), `record` (from warp: commit, program, plan, outputs, `previous`, `parent`, and `files`: for each step, the files its record holds under `files/<node>/`, each with `path`, `size`, `blob`, `before` and `status` (`added`, `changed`, `same` or `deleted`) against `previous`; every file of both runs is compared, then at most 500 are listed in all, in node then path order, then `moreFiles`). 404 with Temporal's error if neither knows the run |
| `GET /api/schedules` | | `{"schedules": [...]}`: each with `name`, `program`, `ref`, `spec` (`every` in nanoseconds, or `cron` and `timeZone`), `paused`, `next` and `recent` runs (`workflowId`, `runId`, `at`); 502 if Temporal is unreachable |
| `POST /api/schedules` | `{"name", "program", "ref", "every", "actHosts"}` or `{…, "cron", "timeZone"}` (`every` a Go duration such as `24h`; `actHosts` as for runs) | 201 `{"name"}`; 422 with the compile error, or when act hosts weren't shown; 400 for a name or time that makes no sense; 409 for a name taken; 502 if Temporal refuses |
| `POST /api/schedules/{name}/{action}` | `{}` | `action` is `pause`, `resume`, `delete` or `run` (once, now); 404 for another action or no such schedule |
| `GET /api/connectors` | | `{"file", "connectors": [...], "anthropic", "keychain", "error"}`: the worker's connectors as its file has them now, each with `secrets`: where each key is found (`environment`, `keychain` or `missing`, with `error` if the keychain can't be read). Never a value |
| `POST /api/connectors/catalog` | `{"search", "cursor"}` | `{"servers": [...], "next", "registry"}`: a page of the MCP Registry, each server with `name`, `title`, `description`, `link`, `suggest` (a connector name), and `fit`: `ready` with its `url` and `token` (whether it needs one), or `no` with `why`; 502 if the registry fails, answers too much or redirects elsewhere |
| `POST /api/connectors/add`, `POST /api/connectors/remove` | `{"name", "url", "token"}` (`name` only to remove) | `{"name", "removed"}`; 403 unless from this machine (as for keys), 409 for a name already there or a file with a problem, 400 for a change that fails the file's check |
| `POST /api/connectors/connect` | `{"name", "url"}` | `{"signIn": false}` for a server that needs no token, or `{"signIn": true, "authorize"}`: the sign-in page to open; 403 unless from this machine, 409 for a name or token name in use, 502 if the server's sign-in can't be found or registered with |
| `GET /oauth/callback?code=&state=` | | an HTML page saying whether the connector was added; 400 for a state this server isn't waiting for, 403 unless from this machine |
| `POST /api/secrets`, `POST /api/secrets/delete` | `{"name", "value"}` (`value` only to set; a delete with one is refused) | where the key is found now; 403 unless from a loopback address with no forwarding headers, to a server without `-hosts`, 400 for a name no connector uses (other than `ANTHROPIC_API_KEY`) or a value the keychain won't keep |
| `GET /api/live/{workflow}` | | `{"frames": [{"activity", "kind", "attempt", "url", "image"}]}`: the latest heartbeat frame of each browsing step the run is executing (`kind` is `browse` or `act`; an act step before its first action has none), read with `DescribeWorkflowExecution` on its plan (`<workflow>/plan`); `temporalError` if Temporal is unreachable |
| `GET /api/steps/{workflow}/{run}` | | `{"steps": [...]}`: each step as Temporal's history records it, in order, then loom's record: `node`, `activity`, `status`, `attempts`, `scheduled`, `started`, `closed`, and the last `failure` (at most 2 KiB). With Temporal unreachable: no steps and `temporalError`, still 200 |
| `GET /api/diff/{from}/{to}` | | Unified diff text. 400 unless both are full commit IDs |
| `GET /api/skills` | | `{"skills": [...], "pending": [...], "problems": [...]}`: the newest version of every skill in the store (treadle's `Library.Skills`), each with `name`, `description`, `version`, `commit` and, if imported, `source`; the imports waiting for review (`Library.Pending`), each with `"pending": true`; and why any skill or import can't be used |
| `GET /api/writes/{workflow}` (a run's workflow ID, or a merge re-run's, `…/rerun-N`) | | `{"writes": [...]}`: a running run's queued writes so far and their status (loom's `WritesQuery`); a finished run's are in its record (`record.writes`, from `writes.json`). 400 for anything but a run's workflow ID, 502 if Temporal fails |
| `POST /api/writes/{workflow}` | `{"node", "id", "approve"}` | Approves or declines one write waiting for approval by signalling the run (loom's `WriteSignal`); the page never runs a write. Answers the run's writes |
| `POST /api/write` | `{"description"}` | Has a worker's Claude write a program for the task (loom's `WriteProgramWorkflow`), from its commands and skills; answers `{"program", "plan", "attempts"}`. Nothing runs. 400 for an empty or overlong description, 422 if no program compiled, 502 if Temporal or the worker failed |
| `POST /api/ask` | `{"request", "earlier", "today", "timeZone"}` | Has a worker's Claude propose what heedle would do (loom's `AskWorkflow`), from its commands and skills, the conversation so far (`earlier`: each turn's request, summary and program) and your day and time zone; answers the proposal: `{"summary", "program", "plan", "schedule", "name", "skill", "ready", "attempts", "actHosts", "remember", "memory"}` (`remember`: what Claude suggests remembering; `memory`: the IDs of the memories sent to Claude), `actHosts` naming the hosts its act steps may submit forms on (loom's `ActHosts`), `ready` saying whether the worker can run it now. Nothing runs. 422 for a request loom refuses (empty or over 4 KiB, a day or time zone that isn't one) or no usable answer, 502 if Temporal or the worker failed |
| `GET /api/memory` | | `{"memories": [{"id", "text", "added", "used"}], "version", "file"}`: everything heedle remembers about you, word for word (loom's `ReadMemory`), the version a change must be based on, and the file (`-memory`, or `memory.json` beside `-connectors`); `file` empty for a server with none. 409 if the file has a problem |
| `POST /api/memory/add`, `/edit`, `/forget`, `/forget-all` | `{"text", "version"}` (add; `version` optional), `{"id", "text", "version"}` (edit), `{"id", "version"}` (forget), `{"version"}` (forget-all) | What's remembered afterwards, with `memory` for an add (one already remembered is that one, unchanged); 400 for anything that looks like a key, a card number or a password (never repeated), or a change missing what it takes; 404 for an ID not remembered; 409 if the file isn't the version the change was based on (edited by hand meanwhile); 403 unless from this machine (as for keys); 501 for a server with no memory file |
| `POST /api/ready` | `{"program"}` | Whether the program can run now (loom's `CheckReady`, with this server's skills, connectors and keychain): `{"needs", "claude", "claudeDetail", "agent", "browser", "browserAgent", "error", "ready"}`. 422 if it doesn't compile |
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

## The top bar

[[/images/top-bar.png|alt=drawdown's top bar: the brand and the history picker on the left; Runs (underlined in blue, the current section), Skills with a count of 1, Schedules with 2, Connectors with 2 and Memory on the right; then Temporal with an arrow, set apart by a thin line]]

The header holds the brand and the **history** picker (or, on an agent's page, its name) on the left, and on the right drawdown's five sections: **Runs** (the home page), **Skills**, **Schedules**, **Connectors** and **Memory**. Each is an ordinary link to its page (`#/`, `#/skills`, `#/schedules`, `#/connectors`, `#/memory`). Memory has no count: nothing there waits for you. The section you're in is underlined with a thread in its own colour and marked `aria-current="page"`; a page inside a section counts as that section, so a skill's page (`#/skill/…`) and a review (`#/review/…`) are Skills, and a run, a step, a diff and an agent's page are Runs. Which page a route shows and which section it's in both come from `lib.js`'s `page`, so they can't disagree; anything no page takes shows the home page, which is Runs.

A small count beside a section says how many things there need you:

| Beside | Counts | Read from |
|---|---|---|
| Skills | skills waiting for review | `GET /api/skills` (`skillsWaiting`) |
| Schedules | schedules paused after a run failed or timed out: Temporal's own notes for that pause, not one from heedle or anywhere else | `GET /api/schedules` (`schedulesStopped`) |
| Connectors | keys set nowhere, Claude's included, as the Connectors page counts them. A sign-in keeps its token as one of the connector's keys, so a connector signed in to counts once its token is gone; one whose sign-in has expired still has its token, so it isn't counted until a step finds the token can't be refreshed and says to sign in again | `GET /api/connectors` (`keysToSet`) |

The bar asks once when the page loads and again whenever the route changes, never on a timer. When the Skills, Schedules or Connectors page loads its own answer, after an approval, a resumed schedule or a saved key too, it hands the bar that same answer, so the count beside it always agrees with the page. A screen reader reads each section with its count once, such as "Skills (1 waiting for review)". A count is shown only from an answer that is well formed; a request that fails, or an answer that isn't understood, shows no count, and nothing in the bar says so: the section's own page says what's wrong.

**Temporal** comes last, quieter and set apart: it opens Temporal's Web UI (`-temporal-ui`) in a new tab, since it's a developer's tool rather than a part of drawdown.

There's no commands count any more. It looked like a button and did nothing, and a list of commands wouldn't add anything: `/api/info` has only their names, and **New run**'s **Insert a command** row already lists every one, with what it inserts.

On a narrow screen the sections take a row of their own under the brand (at 375 px, Memory wraps to a second line of it), and Temporal moves up beside the history picker, still last for the keyboard; at 375 px wide nothing scrolls sideways, and a long agent name wraps. CI checks the bar in Chromium (`ui/topbar.check.js`, the `topbar` step): every route marks exactly its section, the bar fits at 375 and 1280 px in light and dark mode (and an agent's page at 320 px), every link is reached by keyboard with a visible focus ring, and broken answers give no count.

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

[[/images/run-detail.png|alt=A run's page: status and info pills, the program, its provenance in Git, the timeline of its steps with a retry badge, the composition graph, and output cards for three sources and an assessment]]

A run's page puts its **timeline** first: one lane per step, read from Temporal's own history (`/api/steps`). A hatched bar is the time a step waited for a worker; a solid bar, the time it ran; moving stripes, a step still running. A red badge counts attempts when Temporal retried a step. When a plan fails, shuttle stops at the first failure; the steps it never heard back from are shown faded as **Abandoned** at the moment the run ended. Hovering a bar shows its timings, attempts, the failure that caused a retry, and the start of its output.

The **composition graph** draws the program as it was written. Steps run one after another (`;`, a pipe) left to right, and side by side (`⊗`, a par) stacked in a shaded box; nested groups nest. Every group inside the program folds to one line that names its first six steps (and how many more) and counts them by status; folding keeps focus on the same button. Each step is a card in its kind's colour, with its status, its arguments, a red badge when Temporal retried it, how long it ran, the size of its output and the start of it, and badges for the files it changed, the writes it queued and an agent's turns. The chevron opens the card in place to show everything the record knows about the step: what it runs (with the skill's version badge), its arguments in full, which steps it waits for and which it feeds (each a link), its status, queue and run times, the failure Temporal recorded, its files, its writes, an agent's model, turns, commands and files, and its output. The icons under each card open the step inspector, the skill at the version the plan pins, the diff from this program's previous run, the record in Git (the diff from the record before it), and the run's event history in Temporal. Hovering or focusing an arrow shows exactly what it hands over: each step's output, its size and its start. **Show every detail** opens every card, **Collapse all** closes them, **Fold groups** folds every group, and the corner button opens the graph full screen, fitted to the screen, to pan and zoom (scroll, or `+` and `−`); **Fit** fits it again and **100%** shows it at its own size:

[[/images/graph.png|alt=The composition graph full screen: a step, then three branches side by side (one of them two steps one after another), then a last step; one card is open, showing its waits, feeds, timings, the failure Temporal retried and its output]]

The shape comes from draft (`draft.Composition`), compiled again from the run's program with the commands the server has now. The server sends it only if it names exactly the plan's steps, in order, and implies exactly what each waits for; otherwise (say a skill the program used is gone) the graph is drawn in layers from what each step waits for, says so, and shows on each step which steps it waits for, since the layers alone would suggest more waiting than there is. In the editor, what is open or folded starts afresh when the program changes shape, and while a typo is being fixed the last drawing stays, faded. The page checks the shape again before drawing it (`lib.js`'s `composition`, which `ui/lib.test.js` checks).

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

## Ask heedle: the front door

The home page opens with **What should heedle do?** Type a request in plain words ("Plan three days in Lisbon from 12 December. I like food, tiles and viewpoints."), or pick one of the examples, and **Ask**: a worker's Claude proposes what heedle would do ([loom → The front door](https://github.com/heedle-ai/loom/wiki/How-It-Works#the-front-door-ask)). The answer is a card:

- **The summary**, in plain words.
- **What it needs**, a line each: Claude, an agent image for agent and skill steps, a browser image for browse steps, a browser-agent image for act steps, and every connector its steps ask for (each skill step's as it would be granted, each agent step's grants), each **ready** or what's missing (not connected, tools it doesn't allow, a key not set or that can't be read now, such as a sign-in that expired) with **Connect**, a link to the Connectors page. Keys are read as steps read them, refreshing a signed-in connector's token. A connector whose tools change something outside the run says so in bold: **Can change things: send, each waiting for your approval**, or, in red, **without asking you**. Coming back to the page checks the latest card again (`POST /api/ready`), as does **Check again**; a program that no longer compiles (a skill removed) can't run.
- **Where act steps act**, in red, when it has any: **Its act steps can click, type and submit forms on forms.example.org without asking again**, naming every host they may reach (roadmap 9.5).
- **The plan**, drawn as the program composes it (the same graph as everywhere), and **The program** itself.
- **Run it now**, the ordinary run, and, when the request said when, **Run it every Monday at 8:00 (Europe/Lisbon)** as a name you can change (the next free one if a schedule has it already), which makes the schedule as proposed (the ordinary `POST /api/schedules`). Both wait until the worker says everything it needs is ready. **Edit the program** puts it in the editor below, which offers to put back the program it replaced.
- When nothing heedle has can do it, the card says which skill would, and **Teach heedle this skill** has Claude write it with its test; it [waits for your review](#skills) like any created skill.

What you typed stays in the box until it's answered. The box then asks **Change something, or ask for something else**: "make it four days" or "every Monday at 8" refines the proposal, since the conversation so far goes with each request. Earlier proposals fold to their summary. The conversation is kept for the browser tab, so **Connect** and back finds it where it was, and the latest card checks again. **Start over** forgets it; nothing of it is kept anywhere but the tab (`lib.js`'s `asProposal`, `readyLines`, `earlierTurns`, `cronWords`). Schedules read in words where their cron is simple: every day, every weekday or one day of the week at a time.

## Memory

heedle remembers short facts about you that you've said yes to, such as "Vegetarian." or "Home airport: IAD.", and sends them to Claude with every request to **Ask heedle**, as facts about you, never as instructions ([loom → Memory you can see](https://github.com/heedle-ai/loom/wiki/How-It-Works#the-front-door-ask)). They're in one file: `-memory FILE`, or `memory.json` beside the `-connectors` file, which for heedle up is `~/.heedle/memory.json`; never in the Git store, whose history keeps everything.

- **Nothing is remembered without your yes.** When a request states something lasting about you ("I'm vegetarian"), the card shows it under **Remember for next time?** with **Remember** and **Not now**. Only **Remember** saves it (`POST /api/memory/add`); the proposal runs the same either way. "Remember that …" alone proposes only the memory.
- **You know when it's used.** A card made with memory says **Used 2 things heedle remembers**, linking to them.
- **The Memory page** (`#/memory`, in the top bar) lists everything remembered, word for word, with when each was added and last used. Add, **Edit** in place, **Forget**, or **Forget everything**, which asks first. It says that Claude sees all of it, so details for forms such as your address or a card don't belong there; anything that looks like a key, a card number or a password is refused, without repeating it.
- **Forget means forgotten.** Forget rewrites the file without it; nothing else drawdown keeps holds it. What you typed when you asked stays in Temporal's history with that request, as every request does.
- **A hand edit is never lost.** Every change says which version of the file it was based on; if the file changed meanwhile (edited by hand, or from another tab), the change is refused and the page shows what the file holds now. Changes come only from this machine.

Memory text is shown as text everywhere: the page never reads it as HTML.

## Act steps

[[/images/act.svg|alt=An act step: the instruction, start page and hosts become a question; Claude's loop in pirn, bounded, offered only the form tools; each call goes through podman exec to Playwright MCP and Chromium in a fresh reed container that reaches only allowed hosts; a screenshot after every action is heartbeated to the run page; the result is strict JSON recorded in Git]]

An `(act "instruction" "https://start" "host"…)` step (roadmap 9.5) has Claude fill in and submit a form in a fresh browser that reaches only the hosts it names ([pirn → Act steps](https://github.com/heedle-ai/pirn/wiki/How-It-Works#act-steps)). It acts without asking again, so a proposal with act steps says where, in red, above **Run it now**; without a browser-agent image or the Anthropic key, it says what's missing and Run waits:

[[/images/act-card.png|alt=A proposal card: the act steps line and the Claude line say what's missing, and a red note says its act steps can click, type and submit forms on cdn.example.org and forms.example.org without asking again]]

While it runs, the run's live view shows its latest screenshot, marked **Claude in a browser**. Afterwards its step page shows Claude's reply, how it ended (Claude finished, Claude stopped and said why, or a limit on actions, turns or time), the hosts it could reach and how many requests were blocked; then **Actions**: every action in order, each with its input, the page it left, what it saw and a screenshot of that page, then the blocked requests. A screenshot is shown only if the record holds it as a JPEG data URL. act steps have their own dye, blue. The card isn't the only way in, so the server holds the line: `POST /api/runs` and `POST /api/schedules` start a program with act steps only when the request carries exactly the hosts the page showed (`actHosts`, as loom's `ActHosts` reads the plan), and answer 422 naming them otherwise. The editor shows the same red note above **Run** when its program has act steps, and sends those hosts with Run and Schedule. How an act step ended reads as Claude's own word ("Claude said it finished"), since a page could talk it into saying so; a step that lost Claude after acting says that, and blocked requests the browser couldn't list read as unknown, never as none.

[[/images/act-run.png|alt=An act step's page: its summary, where it ran, what it decided, and its actions in order, each with a screenshot]]

## Describing a task

**New run** starts with **Describe a task**: Claude, on a worker, writes the program from the commands and skills the worker has (loom's [program writer](https://github.com/heedle-ai/loom/wiki/How-It-Works#writing-programs)). The program goes into the editor, which compiles it and draws its plan, so you see every step before anything runs; Run submits it like any program.

## Reading and editing programs

Every program the page shows, on a proposal card, a run's page or in the editor, reads as draft reads it. One tokenizer (`lib.js`'s `tokens`) is draft's lexer rule for rule and in its order: comments (`;` anywhere, `//` where a token starts), whitespace, strings with draft's five escapes (`\n \t \r \" \\`), brackets and atoms. A string draft can't read is marked as an error. `testdata/tokens.json` holds programs that `TestInv_TokensAgreeWithDraft` reads with draft and `ui/lib.test.js` splits with the page, so the two can't drift.

[[/images/program-viewer.png|alt=The program on a proposal card: brackets in four colours by depth, the pointed-at par form tinted teal with both its brackets outlined, agent and ask in their dyes, a long instruction folded with a more button, the grants maps and maps/directions underlined, and a muted italic comment]]

- **Brackets** take their depth's colour, four in turn (each at least 4.5:1 on the page in both modes). Pointing at a bracket, or moving between brackets with the arrow keys once the program has focus, outlines it and its partner and tints the form between them. A bracket with no partner is marked as an error. Brackets inside strings and comments are text.
- **Words** read by kind: `pipe` and `par` as structure, each command in its step's dye, skills in the skill dye. Hovering a command says what it does (`/api/info`'s `about`); a skill links to its page and says its description.
- **Links.** In an agent step, each grant after the instruction (`"maps"`, `"maps/directions"`) links to **Connectors**, and says what it grants. `"browse"` says instead that it is a connector of that name, not the `browse` command. In a string, an `http` or `https` URL that starts a word opens in a new tab with `rel="noopener noreferrer"`; no other scheme is ever a link (`javascript:`, `data:`, and `blob:https://…` all stay text). Links are React elements, never HTML.
- **Long strings** wrap with a hanging indent under their line, keeping the program's own line breaks and indents (a tab is 2 columns). A string over 240 characters folds to its start, with **more**. **Copy** puts the exact program on the clipboard, never the folded view.
- **Long programs** stay quick: pointing at a bracket redraws only the lines of its form.

[[/images/program-editor.png|alt=The editor in dark mode: a program whose pipe bracket is never closed, marked with a red wavy underline, the assess form at the cursor lit, and draft's error below: unclosed ( at end of input]]

The **editor** under New run is [CodeMirror 5](https://codemirror.net/5/), its core only, coloured by the same tokenizer as you type, with the bracket at the cursor and its partner lit. It compiles as you type, as the plain field did. It keeps the program exactly as typed, pasted or composed with an input method: Enter adds a line break and nothing else, and a paste goes in as it is (CodeMirror's own paste would turn `\r\n` into `\n`). It puts in a program from outside (an example, Ask heedle's, one put back) only if it isn't one the editor itself sent, so the page never undoes an edit with an older program. It grows with the program up to 70% of the window, then scrolls, and colours only the lines in view, so its own work per keystroke stays small however long the program is. (A long program that compiles also redraws its composition graph as you type, which takes most of the time at thousands of steps.) Its cursor starts at the end, so a command inserted before you click goes after the program. **Tab** indents; to leave the editor by keyboard, press **Esc**, then **Tab**. If CodeMirror doesn't load, the editor is a plain text field.

## Writes

A run whose agent steps queued writes ([loom → Writes](https://github.com/heedle-ai/loom/wiki/How-It-Works#writes)) shows them under **Writes** on its page: each connector and tool, its input, its status, and what came of it. While the run waits for approval, a write that needs it has **Approve** and **Decline** buttons; deciding signals the run, which runs the write once if approved. An agent step's own page lists every connector call it made (run by Anthropic's MCP connector or on the worker) and every write it queued, with what the step was granted. Inputs, outputs and errors are shown as text, with control and invisible format characters as `⟨U+XXXX⟩`.

drawdown's own worker (`-worker`) takes the same `-connectors FILE` as `loom worker`.

## Schedules

[[/images/schedules.png|alt=The Schedules page: one schedule, shipment-check, at cron 0 9 * * 1-5 in UTC, with its next run, its program, a recent run linked, and Run now, Pause and Delete]]

**Schedule…** beside **Run** makes a schedule of the program in the editor: a name, and every hour, 6 hours, day or week, or cron times in a time zone (your browser's, to begin with). It's [loom's schedule](https://github.com/heedle-ai/loom/wiki/How-It-Works#schedules): Temporal runs the program as compiled now, each run recorded like any other, on the history you're looking at. **Schedules** in the top bar opens the Schedules page (`#/schedules`): each schedule with when it runs (an interval counts from when it was made), or that it's paused and why (a run that fails pauses it), its history, its next run, its program, and links to its recent runs, with **Run now** (if a run of it is still going, the new one starts when that ends), **Pause** or **Resume**, and **Delete** (its runs' records stay). Each scheduled run's **Compare** finds the previous run of its program, scheduled or not, by the record's `Loom-Program`.

## Connectors

[[/images/connectors.png|alt=The Connectors page: Claude's key, not set, with a field to paste it; a remote maps connector whose one write waits for approval, its key in the keychain, with Replace and Remove; a local search connector in a container, its key in the keychain]]

**Connectors** in the top bar opens the Connectors page (`#/connectors`): the MCP servers agent steps can be granted ([pirn → Connectors](https://github.com/heedle-ai/pirn/wiki/How-It-Works#connectors)), as the worker's connectors file (`-connectors`) has them now, and Claude's own key. Each connector shows whether it's remote or a local container, its tools, and its writes, and whether they wait for approval. Each key it needs shows where it's found: in the environment where heedle runs (which comes first), in your keychain, or not set. Paste a key and **Save** (or **Replace**), or **Remove** it: it goes straight from this page to this machine's keychain (pirn's `Keychain`), never to Temporal, Git or a log, and the page never gets a value back. Only a name a connector uses, or `ANTHROPIC_API_KEY`, can be set, and only from the machine heedle runs on, at localhost: a request through a proxy (with forwarding headers), or to a server given `-hosts`, is refused, because a proxy on this machine makes every request look local; use `heedle secret set` there. A connectors file that fails its check lists no connector, says why, and names no key, and the worker uses none of it until it's fixed; one connector the page can't read is left out and counted, never hiding the others or Claude's key. The worker reads its connectors file and its keys again for every step, so a key saved here, or a connector added to the file, is used from the next step, with no restart.

[[/images/connectors-catalog.png|alt=Searching the MCP Registry for maps: two servers with Add buttons, one needing a token; one that needs an X-API-Key header and one that runs as a local package, each saying why it can't be added here]]

**What a step is missing is said where it failed.** A step that failed for want of a connector, a key or an unlocked keychain says so above its failure: on the run's page under **What went wrong** (a failed run has no record, so this is where its steps' failures are shown), and in the step inspector and the composition graph's card when there is a record, in plain words with the connector's or key's name (`lib.js`'s `connectorProblem`, which reads pirn's own sentences, whole and ending the failure). A connector the worker lacks, one whose tools don't cover the step, or a key that isn't set (or that the keychain holds in a form heedle can't use) comes with a link to this page; a keychain that was locked, or waiting for you to allow access in its window, comes with what to do instead, since unlocking it is done on the desktop. Any other failure, including one where the keychain couldn't be read for another reason, gets no note: its own words stand. A skill's page shows each connector it asks for as connected (added, every key found), key not set, or not connected, with a link to connect the ones that aren't: a skill that needs `maps` names `maps`, so add the connector under that name.

**Add from the MCP Registry** searches the [official MCP Registry](https://registry.modelcontextprotocol.io) (`GET /v0/servers?search=…&version=latest`, at most 30 servers a page, 2 MiB, 10 seconds, following no redirect; the server asks it, the page never does). Anyone can publish there, so everything it says is shown as text, only `https://` links are kept, and an entry whose metadata can't be read is left out. A server is offered with **Add** only if heedle can reach it as it is: a remote server over Streamable HTTP, at a plain `https://` address, that needs at most an `Authorization` token, since remote servers go through Anthropic's MCP connector, which sends only that. Any other says why it can't be added here: a required header such as `X-API-Key`, an address with values to fill in, the older SSE transport, or a package to run on your machine (which needs a container image). **Add** takes a connector name (the one grants use, suggested from the server's), then **Sign in and add**, or a token pasted from the server's settings.

**Signing in** follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), with the MCP Go SDK's `oauthex` for discovery and registration and `golang.org/x/oauth2` for the rest. The server asks the MCP server to start a session with no token. If it answers 2xx, it needs none, and the connector is added as it is. If it answers 401, the server finds its protected resource metadata (from the `WWW-Authenticate` challenge, else the well-known places), then its authorization server's metadata (which must offer PKCE, with its sign-in, token and registration endpoints all at the issuer's own origin: a server mustn't send you to sign in at one provider while heedle hands the code to another host), following no redirect and reading at most a MiB of any answer, registers heedle there as a public client whose only redirect is this server's `/oauth/callback` (at `127.0.0.1` or `localhost`, so open heedle there to sign in), and, once the page has told you which host you'll sign in at and you choose to go there, opens the sign-in page in a new tab: with PKCE (S256), a random state, the scopes the challenge or metadata names, and the MCP server as the `resource`. When the provider sends the browser back, the callback takes only a state this server is waiting for, once, within 10 minutes, on this machine; exchanges the code with PKCE's verifier; keeps the access token in the keychain as `HEEDLE_CONNECTOR_<NAME>_TOKEN`, and what refreshes it (the client, the token endpoint, the refresh token and when the token expires) as `HEEDLE_CONNECTOR_<NAME>_OAUTH`, never in the file; and only then adds the connector. Each value is at most 3 KiB (what a macOS keychain line takes): a provider whose tokens are longer can't be signed in to here. The Connectors page picks it up and marks it signed in. heedle's worker (`OAuthVault`) refreshes the token when it is within 2 minutes of expiring (a token that says nothing of when it expires is taken to last an hour), naming the MCP server as the `resource` as on every token request, and keeps the new refresh token before the new access token. A refresh refused once the token has expired says to sign in again; one that failed for now (the endpoint down) is retried. One worker refreshes at a time; two heedles sharing a keychain may race. A token pasted over a signed-in one ends its refreshing, and a sign-in's leftover in the keychain blocks its name until it's removed. `loom worker` uses the token as it is, without refreshing it. An authorization server that doesn't let heedle register itself can't be signed in to here: paste a token from its settings instead. The address goes into the connectors file and the token into the keychain under `HEEDLE_CONNECTOR_<NAME>_TOKEN` (shown before you add it), never the file. That name is never one another tool sets: a server named `github` must not be handed a `GITHUB_TOKEN` the worker's environment holds, since the environment comes before the keychain. If the environment, another connector or the keychain already has the name, nothing is added; choose another name. Add a server only if you trust its publisher: a step granted it sends it what the step was given. The file is replaced all at once (a new file, written and synced, renamed over it), keeping its mode and writing through a symbolic link to the file it names; only if the whole file then passes its check; only if it still holds what was read, so a hand edit made meanwhile is never lost; and only from this machine, like keys. A token that can't be stored adds nothing. **Remove** takes a connector out of the file, and then, only once the file no longer names it, the token the page made for it; keys you set otherwise are never the page's to delete.

## Skills

**Skills** in the top bar opens the Skills page (`#/skills`): every skill the store keeps ([treadle](https://github.com/heedle-ai/treadle/wiki)), with its description, newest version, and whether it was imported. A skill's page (`#/skill/<name>`) shows its `SKILL.md` as text, its files with their sizes, and every version, newest first, with where each was imported from; for a GitHub source, a link to the exact folder at the exact commit, built only from checked parts so it can only point at github.com.

Wherever a step follows a skill, it says so with a badge naming the skill and the version its plan pins, linking to that version: on the graph (an opened step names `weather @72ba7cf`, and its arguments), in hover cards, in the run's outputs and in the step inspector. A run that pinned an older version opens that version, marked *not the newest*.

**Browse a repository** lists every skill in a repository of Agent Skills, such as `github.com/anthropics/skills`: its name, its description and its folder, or why treadle can't import it. A worker does the listing (`loom.ListSkills`), fetching only the `SKILL.md` files; the page asks for whole https:// repositories only. Give a branch or tag to list that instead of the default branch. Choose any number and **Import** them: each goes through the ordinary import, so from a repository you haven't trusted each waits for your review, and the list says which. Nothing is imported until you choose. The list warns when two of its skills share a name (they'd replace each other, so only one of them can be chosen) and when one would replace a skill of yours from somewhere else. An import fetches the branch as it is then; if that isn't the commit that was listed, the list says *changed since it was listed*, and the review shows exactly what was fetched.

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

All page content is rendered as text by React (the composition graph included), and diff2html escapes diff content. A program's links are React elements to `http` and `https` URLs only (see [Reading and editing programs](#reading-and-editing-programs)).

Every response also carries a **Content-Security-Policy**: scripts only from drawdown itself and `cdn.jsdelivr.net`, network requests only to drawdown, no plugins, no framing. If a library were ever compromised past its integrity hash, it still couldn't send your data anywhere else. Inline styles are allowed for the page's own style sheet.

The server reads warp only through the `History` interface (`Resolve`, `Log`, `Tree`, `Blob`, `Blobs`, `Parents`, `FindByTrailer`, `Diff`, `Refs`), so it has no way to write history: runs are recorded only by loom's workflow.

These checks are tested in `TestGuard_RefusesCrossSiteAndRebinding`, `TestPage` (the policy) and `TestInv_UIOnlyReadsHistory`.

## The page

`static/index.html`, `static/lib.js` and `static/app.js`, embedded in the binary. `lib.js` holds the page's pure logic (reading outputs, durations, the timeline's span), which CI tests with Node (`node --test ui/lib.test.js`), and CI opens the page in Chromium to check the top bar (`ui/topbar.check.js`); every step output is read through its checked parse, so JSON that only looks like a page or an answer is shown as text. No build step: the libraries load from jsDelivr, each pinned to an exact version with a Subresource Integrity hash, so the browser refuses a file that doesn't match.

| Library | Version | Used for |
|---|---|---|
| React, ReactDOM | 18.3.1 (UMD) | Components |
| htm | 3.1.1 | JSX-style markup without a compiler |
| diff2html | 3.4.48 | Diff view |
| CodeMirror | 5.65.21 (`lib/codemirror.js` and `.css`, no add-ons) | The program editor |

Its two fonts, Bricolage Grotesque and JetBrains Mono, are served by drawdown itself from `static/fonts`, with their SIL Open Font License files, so the Content-Security-Policy keeps fonts to this server (`TestInv_FontsAreServedHere`).

## Tested

- [Invariants](Invariants) lists every guarantee and its guard; CI checks it against the code.
- `ui/browser.test.js` drives the program viewer and editor in headless Chromium (Playwright) on the real server with the fake Temporal (`TestServeForBrowser`), with the libraries served from their npm packages: typing, pasting and input-method text kept exactly, Tab and Esc, colours and compiling as you type, Copy, and links. CI runs it as the `browser` step.
- `server_test.go` covers every endpoint, the security checks, the 200-record bound, and Temporal being down, against a fake Temporal that really runs plans in Temporal's test suite and records them with loom's `Recorder`, so compiles, runs, records and diffs are real.
- The agent tabs were driven in headless Chromium against real records: reed visited a test site from a real browser in Podman, and its pages and a live frame were served through the fake Temporal. Checked: the tree, the named tab target, that opening an agent twice reuses its tab, each tab's title and icon, the live view, and recorded pages with their blocked requests. `TestInv_AgentTabs` checks the tab code in CI.
- The redesigned pages (drawdown, timeline, graph, step inspector) were driven in headless Chromium in light and dark mode against demo records and a stand-in Temporal, with no console errors; the screenshots on these pages come from that run. The API they use is tested in CI (`TestInv_StepsComeFromTemporalHistory`, `TestSteps_ReportsTemporalErrorsWithoutFailing`).
- The page was first driven in headless Chromium through the whole hello world story: a live syntax error with position, the plan graph, a run, changed evidence, and the diff. The libraries were served from their npm packages, which also checked the integrity hashes. That browser run isn't in CI; the API behaviour it exercises is.
