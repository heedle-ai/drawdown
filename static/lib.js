// drawdown's pure logic: no React, no DOM. app.js uses it as DD; CI runs
// ui/lib.test.js against it with Node's test runner.
const DD = (() => {
  const str = (v) => typeof v === "string";
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const strs = (v) => v === undefined || (Array.isArray(v) && v.every(str));
  const opt = (v, ok) => v === undefined || ok(v);

  // asAnswer is v if it's an ask step's answer (pirn's JSON, format 1),
  // with every field the page reads of the right type; else null.
  function asAnswer(v) {
    if (!v || typeof v !== "object" || v.pirn !== 1) return null;
    if (!str(v.model) || !v.model || !str(v.text)) return null;
    if (!opt(v.stopReason, str) || !opt(v.inputTokens, num) || !opt(v.outputTokens, num)) return null;
    return v;
  }

  const KINDS = ["added", "changed", "deleted"];
  const SHA256 = /^[0-9a-f]{64}$/;
  // A registry repository, host/path in lower case with no tag or digest:
  // pirn's and loom's own pattern, so nothing else reaches a command.
  const OCI_REPO = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
  const objs = (v, ok) => Array.isArray(v) && v.every((x) => x && typeof x === "object" && ok(x));

  // asAgent is v if it's an agent step's result (pirn's JSON, agent format
  // 1), with every field the page reads of the right type; else null.
  function asAgent(v) {
    if (!asAnswer(v) || v.agent !== 1 || !str(v.image) || !num(v.turns)) return null;
    if (!objs(v.commands, (c) => str(c.command) && num(c.exitCode) && opt(c.stdout, str) && opt(c.stderr, str) && opt(c.ms, num) && opt(c.error, str))) return null;
    if (!objs(v.files, (f) => str(f.path) && num(f.size) && opt(f.text, str) && opt(f.base64, str) &&
      (f.oci === undefined ? f.sha256 === undefined : str(f.oci) && OCI_REPO.test(f.oci) && SHA256.test(f.sha256) && f.text === undefined && f.base64 === undefined))) return null;
    // Only the kinds podman diff reports: the page groups by kind.
    if (!objs(v.changes, (c) => KINDS.includes(c.kind) && str(c.path)) || !strs(v.skipped)) return null;
    if (!opt(v.skippedMore, num) || !opt(v.moreChanges, num)) return null;
    if (!v.inputs || typeof v.inputs !== "object" || !Object.values(v.inputs).every(str)) return null;
    // Connector calls and queued writes (pirn's ToolCall and Write).
    if (!opt(v.grant, str) || !opt(v.tools, (t) => objs(t, (c) => str(c.connector) && str(c.tool) && str(c.input) &&
      opt(c.output, str) && opt(c.isError, bool) && opt(c.remote, bool) && opt(c.write, str)))) return null;
    if (!opt(v.writes, (ws) => objs(ws, isWrite))) return null;
    return v;
  }

  // asAct is v if it's an act step's result (pirn's JSON, act format 1;
  // roadmap 9.5), with every field the page reads of the right type and
  // every screenshot a JPEG data URL; else null.
  const JPEG_DATA = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
  const ENDED = ["finished", "stopped", "max_calls", "max_turns", "timeout", "error", "cancelled"];
  function asAct(v) {
    if (!asAnswer(v) || v.act !== 1 || !str(v.image) || !num(v.turns) || !str(v.url) || !ENDED.includes(v.ended)) return null;
    if (!objs(v.calls, (c) => str(c.tool) && str(c.input) && opt(c.output, str) && opt(c.isError, bool) && opt(c.truncated, bool) &&
      opt(c.url, str) && opt(c.screenshot, (x) => str(x) && JPEG_DATA.test(x)))) return null;
    if (!strs(v.allowed) || !strs(v.blocked) || !num(v.blockedTotal) || !strs(v.inputs) || !opt(v.blockedUnknown, bool)) return null;
    // Roadmap 9.7: the sends it held for a person, and whether its program
    // let it send without asking (records from 9.5 have neither).
    if (!opt(v.held, strs) || !opt(v.heldTotal, num) || !opt(v.sendWithoutAsking, bool)) return null;
    // Roadmap 9.9: the script it kept, and what it replayed of an earlier
    // run's (records before 9.9 have neither).
    if (!v.calls.every((c) => opt(c.replayed, bool)) || !opt(v.scriptInputs, str) || !opt(v.replay, isReplay)) return null;
    if (!opt(v.script, (s) => objs(s, (st) => str(st.tool) && str(st.input) && str(st.outline) && str(st.outlineSha256) && opt(st.replayed, bool) &&
      opt(st.targets, (ts) => objs(ts, (l) => str(l.role) && str(l.name) && opt(l.nth, num)))))) return null;
    return v;
  }
  const isReplay = (r) => r && typeof r === "object" && num(r.steps) && num(r.replayed) && opt(r.from, str) && opt(r.record, str) && opt(r.handedOver, bool) && opt(r.at, num) && opt(r.why, str);

  // replayWords says, in words, what an act step replayed (roadmap 9.9),
  // or "" if it found no script.
  function replayWords(r) {
    if (!r) return "";
    const from = r.from ? ` from run ${r.from.slice(0, 12)}` : "";
    if (replayedAll(r)) return `replayed all ${r.steps} action${r.steps === 1 ? "" : "s"}${from}, without Claude`;
    // Review 51: one cut short (a send not confirmed) isn't all of it.
    if (!r.handedOver) return `replayed ${r.replayed} of ${r.steps}${from}, then stopped at action ${r.at}: ${r.why || "no reason given"}`;
    if (r.replayed === 0) return `didn't replay${from}: ${r.why || "no reason given"}`;
    return `replayed ${r.replayed} of ${r.steps}${from}, then Claude from action ${r.at}: ${r.why || ""}`;
  }
  // replayedAll is whether a replay did the whole script, Claude never asked.
  const replayedAll = (r) => !!r && !r.handedOver && r.replayed === r.steps;

  // actEndingOf is how an act step ended, in words: a whole replay
  // finished as the run it replayed did, not on Claude's word.
  function actEndingOf(a) {
    if (a.ended === "finished" && replayedAll(a.replay)) return "finished, as the run it replayed did";
    return actEnding(a.ended);
  }

  // locatorText is a script step's element in Playwright's words.
  function locatorText(l) {
    return `getByRole(${JSON.stringify(l.role)}, { name: ${JSON.stringify(l.name)}, exact: true })${l.nth ? `.nth(${l.nth})` : ""}`;
  }

  // actEnding says, in words, how an act step ended.
  function actEnding(ended) {
    return {
      // Claude's own word, which a page could talk it into (review 39).
      finished: "Claude said it finished",
      stopped: "Claude stopped and said why",
      error: "stopped: asking Claude failed after it had acted",
      max_calls: "stopped at the limit on actions",
      max_turns: "stopped at the turn limit",
      timeout: "stopped when its time ran out",
      cancelled: "cancelled: nothing was sent",
    }[ended] || ended;
  }

  const bool = (v) => typeof v === "boolean";
  const isWrite = (w) => str(w.id) && str(w.connector) && str(w.tool) && w.input !== undefined && opt(w.approve, bool);
  const WRITE_STATUS = ["waiting", "approved", "declined", "expired", "done", "failed", "refused"];

  // asWrites is a run's writes (loom's WriteOutcome) if every one is well
  // formed, each input shown as JSON text; else [].
  function asWrites(v) {
    if (!objs(v, (w) => isWrite(w) && str(w.node) && WRITE_STATUS.includes(w.status) && opt(w.output, str) && opt(w.error, str) && opt(w.isError, bool))) return [];
    return v.map((w) => ({ ...w, inputText: JSON.stringify(w.input) }));
  }

  // asPage is v if it's a browse step's page (reed's JSON, format 1), with
  // every field the page reads of the right type; else null.
  function asPage(v) {
    if (!v || typeof v !== "object" || v.reed !== 1) return null;
    if (!str(v.url) || !opt(v.title, str) || !opt(v.text, str) || !opt(v.screenshot, str)) return null;
    if (!strs(v.allowed) || !strs(v.blocked) || !opt(v.blockedTotal, num)) return null;
    return v;
  }

  // parse reads a step's output: {agent}, {act}, {answer}, {page}, or {text} for
  // anything else, including JSON that only looks like one of them.
  function parse(text) {
    if (!str(text)) return { text: "" };
    let v;
    try { v = JSON.parse(text); } catch { return { text }; }
    if (v && v.agent !== undefined) {
      const agent = asAgent(v);
      return agent ? { agent } : { text };
    }
    if (v && v.act !== undefined) {
      const act = asAct(v);
      return act ? { act } : { text };
    }
    const answer = asAnswer(v);
    if (answer) return { answer };
    const page = asPage(v);
    if (page) return { page };
    return { text };
  }

  // preview is an output as plain text, for hover cards.
  function preview(text) {
    const o = parse(text);
    if (o.agent) return o.agent.text;
    if (o.act) return o.act.text;
    if (o.answer) return o.answer.text;
    if (o.page) return `${o.page.title || o.page.url}\n${(o.page.text || "").slice(0, 300)}`;
    return o.text;
  }

  // decisions are what a step concluded, as [label, value] rows.
  function decisions(kind, text) {
    if (!str(text)) return [];
    const o = parse(text);
    if (o.agent) {
      const a = o.agent;
      const failed = a.commands.filter((c) => c.exitCode !== 0 || c.error).length;
      const rows = [["Model", a.model], ["Turns", String(a.turns)],
        ["Commands", `${a.commands.length} run${failed ? `, ${failed} failed` : ""}`],
        ["Files kept", a.files.length ? a.files.map((f) => f.path).join(", ") : "none"],
        ["Changed", `${a.changes.length}${a.moreChanges ? `+${a.moreChanges}` : ""} paths in the container`]];
      if (num(a.inputTokens) && num(a.outputTokens)) rows.push(["Tokens", `${a.inputTokens} in, ${a.outputTokens} out`]);
      if (a.stopReason) rows.push(["Stopped", a.stopReason === "max_turns" ? "at the turn limit, without a final reply" : `on its own (${a.stopReason})`]);
      return rows;
    }
    if (o.act) {
      const a = o.act;
      const rows = [["Model", a.model], ["Turns", String(a.turns)], ["Actions", String(a.calls.length)], ["Ended", actEndingOf(a)],
        ["Last page", a.url || "none"], ["Could reach", a.allowed.join(", ")], ["Blocked", a.blockedUnknown ? "unknown: the browser couldn't say" : `${a.blockedTotal} request${a.blockedTotal === 1 ? "" : "s"}`]];
      if (a.sendWithoutAsking) rows.push(["Sending", "without asking: its program said so"]);
      else if (num(a.heldTotal)) rows.push(["Held", `${a.heldTotal} send${a.heldTotal === 1 ? "" : "s"} until a person said so`]);
      if (num(a.inputTokens) && num(a.outputTokens)) rows.push(["Tokens", `${a.inputTokens} in, ${a.outputTokens} out`]);
      if (a.replay) rows.push(["Replay", replayWords(a.replay)]);
      return rows;
    }
    if (o.answer) {
      const a = o.answer;
      const rows = [["Model", a.model]];
      if (num(a.inputTokens) && num(a.outputTokens)) rows.push(["Tokens", `${a.inputTokens} in, ${a.outputTokens} out`]);
      if (a.stopReason) rows.push(["Stopped", a.stopReason === "max_tokens" ? "at the token limit: the answer is cut off" : `on its own (${a.stopReason})`]);
      const cites = [...new Set(a.text.match(/\[n\d+\]/g) || [])];
      if (cites.length) rows.push(["Cited", cites.join(" ")]);
      return rows;
    }
    if (o.page) {
      const p = o.page;
      return [["Ended at", p.url], ["Allowed", (p.allowed || []).join(", ")], ["Refused", `${p.blockedTotal ?? (p.blocked || []).length} requests`]];
    }
    if (kind === "assess") {
      const rows = [["Verdict", (text.split("\n")[0] || "").trim()]];
      const f = /^\s*for:\s*(.*)$/m.exec(text), a = /^\s*against:\s*(.*)$/m.exec(text);
      if (f) rows.push(["For", f[1]]);
      if (a) rows.push(["Against", a[1]]);
      return rows;
    }
    if (kind === "source") {
      const i = text.indexOf(":"), j = text.indexOf(":", i + 1);
      if (i >= 0 && j > i) return [["Verdict", text.slice(i + 1, j).trim()]];
    }
    return [];
  }

  const STATUSES = ["added", "changed", "same", "deleted"];
  const blob = (v) => str(v) && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v);

  // asFiles is a step's recorded files from the API (the record's files
  // for one node), keeping only well-formed entries: a blob for every
  // file that exists now, and a before for every one the previous run had.
  function asFiles(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((f) => f && typeof f === "object" && str(f.path) && num(f.size) && STATUSES.includes(f.status) &&
      (f.status === "deleted" ? !f.blob : blob(f.blob)) && (f.status === "added" ? !f.before : blob(f.before)));
  }

  // fileSummary counts a step's files by status, for a line like
  // "1 added, 2 changed, 3 the same".
  function fileSummary(files) {
    const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const f of files) n[f.status]++;
    const words = { added: "added", changed: "changed", same: "the same", deleted: "deleted" };
    return STATUSES.filter((s) => n[s]).map((s) => `${n[s]} ${words[s]}`).join(", ");
  }

  // size writes a byte count for people.
  function size(n) {
    if (!num(n) || n < 0) return "";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
  }

  const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

  // fetchCommand is the command that gets back a file an agent step kept
  // in a registry: pirn's FetchCommand, character for character.
  function fetchCommand(repo, sum, file) {
    if (file.startsWith("-")) file = "./" + file; // "-" is standard output to oras
    return `oras blob fetch --output ${quote(file)} ${repo}@sha256:${sum}`;
  }

  const HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
  const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  // skillOf is a plan node's skill, {name, version, args}, if it runs one
  // (treadle's Skill activity, Bound to the skill's name and version);
  // else null.
  function skillOf(n) {
    if (!n || n.activity !== "Skill" || !Array.isArray(n.args) || n.args.length < 2) return null;
    const [name, version, ...args] = n.args;
    if (!str(name) || !SKILL_NAME.test(name) || !str(version) || !HEX.test(version)) return null;
    return { name, version, args };
  }

  // asSkill is v if it's a skill as the API lists it, with every field
  // the page reads of the right type; else null.
  function asSkill(v) {
    if (!v || typeof v !== "object" || !str(v.name) || !SKILL_NAME.test(v.name) || !str(v.description) || !HEX.test(v.version) || !HEX.test(v.commit) ||
      !opt(v.pending, (b) => typeof b === "boolean")) return null;
    const s = v.source;
    if (s !== undefined && (!s || typeof s !== "object" || !str(s.repo) || !opt(s.ref, str) || !opt(s.path, str) || !opt(s.commit, str))) return null;
    if (!opt(v.connectors, str) || !opt(v.created, str)) return null;
    return v;
  }

  // request calls the API with fetchFn (the browser's fetch): a GET, or a
  // POST of body as JSON. It never throws: a network failure is
  // { ok: false, status: 0, data: { error } }, so no button is left busy
  // (review 24).
  async function request(fetchFn, path, body) {
    try {
      const res = await fetchFn(path, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const ct = (res.headers && res.headers.get("Content-Type")) || "";
      const data = ct.includes("application/json") ? await res.json() : await res.text();
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: `The page couldn't reach drawdown: ${e && e.message ? e.message : e}` } };
    }
  }

  // catalogNotes says, for each entry of a listing (by repo#path), what
  // to know before importing it: another entry has the same name (only
  // one can be imported: they'd replace each other), or the library has a
  // skill of that name from elsewhere, which it would replace (review 24).
  function catalogNotes(entries, library) {
    const notes = {}, count = {};
    for (const e of entries) if (e.name && !e.problem) count[e.name] = (count[e.name] || 0) + 1;
    const mine = new Map((library || []).map((s) => [s.name, s]));
    for (const e of entries) {
      if (!e.name || e.problem) continue;
      const k = e.source.repo + "#" + (e.source.path || "");
      if (count[e.name] > 1) notes[k] = { dup: true, text: `another skill here is also named ${e.name}: import one of them` };
      const have = mine.get(e.name);
      if (have && !(have.source && have.source.repo === e.source.repo && (have.source.path || "") === (e.source.path || ""))) {
        notes[k] = { ...(notes[k] || {}), replaces: true, text: (notes[k] ? notes[k].text + "; " : "") + `would replace your ${e.name}, ${have.source ? "from " + have.source.repo : "added by hand"}` };
      }
    }
    return notes;
  }

  // asCatalog is a repository's listing from the API, keeping only the
  // entries whose fields have the right shapes: { entries, omitted }, or
  // null for anything that isn't a listing.
  function asCatalog(v) {
    if (!v || typeof v !== "object" || !Array.isArray(v.entries) || !opt(v.omitted, (n) => Number.isInteger(n) && n >= 0)) return null;
    const entries = v.entries.filter((e) => e && typeof e === "object" && e.source && typeof e.source === "object" &&
      str(e.source.repo) && opt(e.source.path, str) && opt(e.source.ref, str) && opt(e.source.commit, str) &&
      opt(e.name, str) && opt(e.description, str) && opt(e.problem, str) && (str(e.name) || str(e.problem)));
    return { entries, omitted: v.omitted || 0 };
  }

  // sourceLink is the web page of the exact folder a skill version was
  // imported from, for a GitHub repository at a known commit; else null.
  // Every part is checked, so the link can only point at github.com.
  function sourceLink(s) {
    if (!s || !str(s.repo) || !str(s.commit) || !/^[0-9a-f]{40}$/.test(s.commit)) return null;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(s.repo);
    if (!m) return null;
    const path = s.path || "";
    if (path && !/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(path)) return null;
    return `https://github.com/${m[1]}/${m[2]}/tree/${s.commit}${path ? "/" + path : ""}`;
  }

  // visible is text with every control character but tabs and line ends,
  // and every invisible format character (bidirectional overrides,
  // zero-width spaces) but the zero-width joiner, written as ⟨U+XXXX⟩, so
  // a review reads as the bytes say (review 17: U+202E reordered text in
  // the browser).
  function visible(text) {
    return String(text).replace(/(?![\t\n\r\u200d])[\p{Cc}\p{Cf}]/gu,
      (c) => "⟨U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + "⟩");
  }

  // MAX_UPLOAD is the most a folder added from the page may hold (loom's
  // MaxSkillsChangeBytes): a change travels as a workflow's input.
  const MAX_UPLOAD = 1 << 20;

  // base64 is text's UTF-8 bytes in base64, as Go's JSON reads []byte.
  function base64(text) {
    let bin = "";
    for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  // readFolder turns the files of a picked folder into {path: base64},
  // with paths relative to the folder (its own name dropped) and hidden
  // files and folders left out, as loom skills -add does; or {error}
  // when there's nothing to add or it's over MAX_UPLOAD. read(file)
  // gives a file's base64.
  async function readFolder(list, read) {
    const files = {};
    let count = 0, bytes = 0, skipped = 0;
    for (const f of list) {
      const parts = String(f.webkitRelativePath || f.name).split("/").slice(1);
      if (parts.length === 0 || parts.some((p) => p === "" || p.startsWith("."))) { skipped++; continue; }
      bytes += f.size + parts.join("/").length; count++;
      if (bytes > MAX_UPLOAD) return { error: `The folder holds more than ${size(MAX_UPLOAD)}: add it with loom skills -add.` };
      files[parts.join("/")] = null;
    }
    if (!Object.prototype.hasOwnProperty.call(files, "SKILL.md")) return { error: "The folder has no SKILL.md at its top." };
    for (const f of list) {
      const p = String(f.webkitRelativePath || f.name).split("/").slice(1).join("/");
      if (Object.prototype.hasOwnProperty.call(files, p)) files[p] = await read(f);
    }
    return { files, count, bytes, skipped };
  }

  // ancestors are every node id depends on, directly or not.
  function ancestors(plan, id) {
    const req = new Map(((plan && plan.nodes) || []).map((n) => [n.id, n.requires || []]));
    const seen = new Set(), stack = [...(req.get(id) || [])];
    while (stack.length) {
      const x = stack.pop();
      if (!seen.has(x)) { seen.add(x); stack.push(...(req.get(x) || [])); }
    }
    return seen;
  }

  // dur writes a duration in milliseconds for people.
  function dur(ms) {
    if (!num(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)} min ${s % 60} s`;
  }

  const time = (t) => (str(t) && t && !t.startsWith("0001") ? new Date(t).getTime() : null);

  // span is the time a timeline covers: from the first step scheduled to
  // the last close, or to now only for steps of a run that's still going.
  // It's never empty, infinite or NaN.
  function span(steps, now, running) {
    const ts = (steps || []).map((s) => time(s.scheduled)).filter((x) => x != null && Number.isFinite(x));
    if (!ts.length) return { t0: now, t1: now + 1 };
    const t0 = Math.min(...ts);
    let t1 = t0;
    for (const s of steps) {
      const open = running && (s.status === "Running" || s.status === "Scheduled");
      const end = time(s.closed) ?? (open ? now : time(s.started) ?? time(s.scheduled));
      if (end != null && Number.isFinite(end) && end > t1) t1 = end;
    }
    return { t0, t1: Math.max(t1, t0 + 1) };
  }

  // dayKey is the local calendar day ("2026-11-02") a time falls on, or ""
  // for a time that isn't one.
  function dayKey(t) {
    const d = new Date(t);
    // Go's zero time (0001-01-01) means "not known", not a day.
    if (!t || isNaN(d) || d.getFullYear() < 1970) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // byDay counts runs by the local day they started: how many, and how
  // many failed or are still running.
  function byDay(runs) {
    const out = {};
    for (const r of runs || []) {
      if (r.merged) continue; // a merge joins histories; it isn't a run
      const k = dayKey(r.start);
      if (!k) continue;
      const d = (out[k] ||= { runs: 0, failed: 0, running: 0 });
      d.runs++;
      if (r.status === "Running") d.running++;
      else if (["Failed", "Terminated", "TimedOut", "Canceled"].includes(r.status)) d.failed++;
    }
    return out;
  }

  // monthGrid is a month as weeks of seven days, Monday first; days of the
  // neighbouring months that fill the first and last weeks have inMonth
  // false. month is 0-based, as in Date.
  function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
    const weeks = [];
    for (let d = new Date(start); weeks.length < 6; ) {
      const week = [];
      for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
        week.push({ key: dayKey(d), day: d.getDate(), inMonth: d.getMonth() === month });
      }
      weeks.push(week);
      if (d.getMonth() !== month) break;
    }
    return weeks;
  }

  // onDay is the runs that started on a day ("" for all of them).
  function onDay(runs, key) {
    return key ? (runs || []).filter((r) => !r.merged && dayKey(r.start) === key) : runs || [];
  }

  // contrast is the WCAG contrast ratio of two #rrggbb colours.
  function contrast(a, b) {
    const lum = (h) => {
      const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  // mix is #rrggbb a at weight t over b.
  function mix(a, b, t) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const x = p(a), y = p(b);
    return "#" + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
  }

  // tint is a calendar day's background, from share (0 to 1, its runs
  // against the busiest day's) and the colours of the theme, with the
  // text that reads best on it: the tint runs from 15% to 85% of color,
  // stepped down where neither text would reach WCAG's 4.5:1 (review 23).
  function tint(share, color, ground, ...texts) {
    let t = 0.15 + 0.7 * Math.min(1, Math.max(0, share));
    for (;;) {
      const bg = mix(color, ground, t), text = readable(bg, ...texts);
      if (contrast(bg, text) >= 4.5 || t <= 0.05) return { bg, text };
      t -= 0.01;
    }
  }

  // readable is whichever of the text colours reads best on bg.
  function readable(bg, ...texts) {
    return texts.reduce((best, t) => (contrast(bg, t) > contrast(bg, best) ? t : best));
  }

  // replaced is the program a written one replaces, worth putting back:
  // the editor's text unless it was empty or is what was written.
  function replaced(before, written) {
    return typeof before === "string" && before.trim() !== "" && before !== written ? before : "";
  }

  // === Programs, as draft reads them ========================================
  // tokens splits a program as draft's lexer (draft/sexpr) does, rule for
  // rule and in its order, the first rule to match at a place winning:
  // comments (";" anywhere, "//" only where a token starts), whitespace
  // (unicode.IsSpace's), strings (escapes \n \t \r \" \\ only), brackets
  // and atoms. A string draft can't read (another escape, or no closing
  // quote) is one "bad" token, so every character is kept and joining the
  // tokens gives back the program. testdata/tokens.json holds programs
  // both must split alike (TestInv_TokensAgreeWithDraft, ui/lib.test.js).
  const SPACE = "\\t\\n\\f\\r \\v\\u0085\\p{Z}";
  const LEX = new RegExp(
    `(;[^\\n]*|//[^\\n]*)|([${SPACE}]+)|("(?:\\\\[ntr"\\\\]|[^"\\\\])*")|([()])|([^${SPACE}()";]+)|("(?:[^"\\\\]|\\\\[^])*"?|[^])`, "uy");
  const TOKEN_KINDS = ["comment", "space", "str", "paren", "word", "bad"];
  function tokens(src) {
    const out = [];
    src = String(src);
    LEX.lastIndex = 0;
    while (LEX.lastIndex < src.length) {
      const m = LEX.exec(src);
      const i = m.findIndex((g, k) => k > 0 && g !== undefined);
      out.push([TOKEN_KINDS[i - 1], m[0]]);
    }
    return out;
  }

  // program is a program's tokens with where each sits: start (its offset
  // in the source), depth (for a bracket, how many forms enclose the one
  // it opens or closes; for anything else, how many forms enclose it),
  // partner (a bracket's other half, -1 if it has none) and, inside a
  // form, its head word and arg (0 for the head, then 1, 2, … for each
  // form after it). Brackets in strings and comments are text: they
  // don't count.
  function program(src) {
    const out = [];
    const open = [];
    let at = 0;
    for (const [kind, text] of tokens(src)) {
      const t = { kind, text, start: at, depth: open.length, partner: -1, head: null, arg: -1 };
      at += text.length;
      const i = out.length;
      out.push(t);
      if (kind === "paren" && text === ")") {
        if (open.length) {
          const o = open.pop();
          t.partner = o.i; out[o.i].partner = i;
          t.depth = open.length;
        }
        continue;
      }
      if (kind === "space" || kind === "comment") continue;
      const form = open[open.length - 1];
      if (form) {
        t.arg = form.n++;
        if (t.arg === 0 && kind === "word") form.head = text;
        t.head = form.head;
      }
      if (kind === "paren") open.push({ i, n: 0, head: null });
    }
    return out;
  }

  // unquote is the text a string token stands for, or null if draft can't
  // read it.
  function unquote(text) {
    if (!/^"(?:\\[ntr"\\]|[^"\\])*"$/u.test(text)) return null;
    return text.slice(1, -1).replace(/\\([ntr"\\])/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] || c);
  }

  // GRANT is an agent step's grant: a connector, or connector/tool (pirn's
  // connectorName and toolName).
  const GRANT = /^([a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?)(?:\/([A-Za-z0-9_.-]{1,64}))?$/;

  // grantOf is the connector and tool a program's token grants, if it is
  // an agent step's grant: a string after its instruction. Else null.
  function grantOf(t) {
    if (t.kind !== "str" || t.head !== "agent" || t.arg < 2) return null;
    const m = GRANT.exec(unquote(t.text) || "");
    return m ? { connector: m[1], tool: m[2] || "" } : null;
  }

  // links splits a string's text into pieces, each { text } or, for an
  // http or https URL, { text, url }. No other scheme is ever a link. A
  // URL starts a word (the text's start, or after whitespace, an opening
  // bracket or a quote, such as the one a program's string opens with:
  // (browse "https://…")), so "blob:https://…" is no link; it ends at whitespace, a
  // quote, a backslash or an angle bracket, and leaves off closing
  // punctuation (a bracket only if it closes nothing).
  function links(text) {
    const out = [];
    const re = /(?<=^|[\s(\[{<'‘“"])https?:\/\/[^\s"\\<>]+/giu;
    let last = 0, m;
    while ((m = re.exec(text))) {
      let u = m[0];
      for (;;) {
        const c = u[u.length - 1];
        if (/[.,;:!?'’]/.test(c)) u = u.slice(0, -1);
        else if (c === ")" && (u.match(/\)/g) || []).length > (u.match(/\(/g) || []).length) u = u.slice(0, -1);
        else if (c === "]" && (u.match(/\]/g) || []).length > (u.match(/\[/g) || []).length) u = u.slice(0, -1);
        else break;
      }
      re.lastIndex = m.index + u.length;
      let ok = false;
      try { const p = new URL(u); ok = (p.protocol === "http:" || p.protocol === "https:") && p.hostname !== ""; } catch {}
      if (!ok) continue;
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: u, url: u });
      last = m.index + u.length;
    }
    if (last < text.length || !out.length) out.push({ text: text.slice(last) });
    return out;
  }

  // tokenClass is the classes a program's token is coloured by. kinds
  // maps a built-in command to its kind of step, skills holds the skills'
  // names (a Map or Set) and about the built-ins' descriptions: only their
  // own names count, never an Object member such as toString (review 38).
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  function tokenClass(t, kinds, skills, about) {
    if (t.kind === "paren") return "p d" + (t.depth % 4) + (t.partner < 0 ? " unmatched" : "");
    if (t.kind === "comment") return "cm";
    if (t.kind === "str") return "str";
    if (t.kind === "bad") return "bad";
    if (t.kind !== "word") return "";
    if (t.text === "pipe" || t.text === "par") return "comb";
    if (skills && skills.has(t.text)) return "sk";
    if (own(kinds, t.text)) return "cmd k-" + kinds[t.text];
    if (own(about, t.text)) return "cmd k-other";
    return "";
  }

  // FOLD_AT is how long a string grows before it folds to its start,
  // FOLD_SHOW how much of it shows when folded.
  const FOLD_AT = 240, FOLD_SHOW = 160;

  // lines splits pieces of text, { text, off, ... }, at line breaks: the
  // result is the program's lines, each a list of pieces with no line
  // break in them, and each line's indent (its leading spaces and tabs,
  // a tab counted as 2, as the page sets tab-size). A piece's off (where
  // its text starts in its token, 0 if not given) moves on with each part,
  // so a part knows where it is (review 38: links were placed by the
  // whole string's offsets in every line of it).
  function lines(pieces) {
    const out = [[]];
    for (const p of pieces) {
      let off = p.off || 0;
      p.text.split("\n").forEach((t, k) => {
        if (k > 0) { out.push([]); off += 1; }
        if (t !== "") out[out.length - 1].push({ ...p, text: t, off });
        off += t.length;
      });
    }
    return out.map((ps) => {
      const lead = /^[ \t]*/.exec(ps.map((p) => p.text).join(""))[0];
      return { pieces: ps, indent: [...lead].reduce((n, c) => n + (c === "\t" ? 2 : 1), 0) };
    });
  }

  // === Composition ==========================================================
  // A program's shape (draft.Composition): steps, run one after another in
  // a pipe (`;`) or side by side in a par (`⊗`).

  // asShape is v if it's a well-formed shape: every step names a node,
  // every group has at least two parts, and nesting stays under 64 deep;
  // else null.
  function asShape(v, depth = 0) {
    if (!v || typeof v !== "object" || depth > 64) return null;
    if (v.kind === "step") return str(v.node) && v.node !== "" && v.parts === undefined ? v : null;
    if (v.kind !== "pipe" && v.kind !== "par") return null;
    if (!Array.isArray(v.parts) || v.parts.length < 2) return null;
    return v.parts.every((p) => asShape(p, depth + 1)) ? v : null;
  }

  // stepsOf lists a shape's steps in order.
  function stepsOf(sh) {
    return sh.kind === "step" ? [sh.node] : sh.parts.flatMap(stepsOf);
  }

  // layered is the shape a plan's requires alone imply: its steps in
  // layers, each layer side by side, the layers one after another. It is
  // what the graph draws when there is no composition to draw.
  function layered(plan) {
    const nodes = (plan && plan.nodes) || [];
    const ids = new Set(nodes.map((n) => n.id));
    const depth = new Map();
    const depthOf = (n, seen = new Set()) => {
      if (depth.has(n.id)) return depth.get(n.id);
      if (seen.has(n.id)) return 0; // a cycle: Validate refuses these
      seen.add(n.id);
      let d = 0;
      for (const r of n.requires || []) {
        const p = nodes.find((x) => x.id === r);
        if (p && ids.has(r)) d = Math.max(d, depthOf(p, seen) + 1);
      }
      depth.set(n.id, d);
      return d;
    };
    const layers = [];
    for (const n of nodes) (layers[depthOf(n)] ||= []).push({ kind: "step", node: n.id });
    const group = (kind, parts) => (parts.length === 1 ? parts[0] : { kind, parts });
    const flat = layers.filter(Boolean).map((l) => group("par", l));
    return flat.length ? group("pipe", flat) : null;
  }

  // composition is what the graph draws: the program's shape when it has
  // one that names exactly the plan's steps, else the plan's layers. exact
  // says which.
  function composition(shape, plan) {
    const want = ((plan && plan.nodes) || []).map((n) => n.id);
    const sh = asShape(shape);
    if (sh) {
      const got = stepsOf(sh);
      if (got.length === want.length && got.every((id, i) => id === want[i])) return { shape: sh, exact: true };
    }
    return { shape: layered(plan), exact: false };
  }

  // groupKeys names every group in a shape by its path ("0", "0.1", …),
  // the keys the graph folds groups by.
  function groupKeys(sh, path = "0") {
    if (!sh || sh.kind === "step") return [];
    return [path, ...sh.parts.flatMap((p, i) => groupKeys(p, path + "." + i))];
  }

  // flowsInto is every hand-over into the steps of part: each from a step
  // that came before it to a step of part that waits for it.
  function flowsInto(plan, before, part) {
    const earlier = new Set(before);
    const out = [];
    for (const id of part) {
      const n = ((plan && plan.nodes) || []).find((x) => x.id === id);
      for (const r of (n && n.requires) || []) if (earlier.has(r)) out.push({ from: r, to: id });
    }
    return out;
  }

  // tally counts a group's steps by status ("Completed", "Failed", …;
  // "none" for steps Temporal hasn't reported).
  function tally(ids, statusOf) {
    const out = {};
    for (const id of ids) {
      const s = statusOf(id) || "none";
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }

  // === Connectors ===========================================================

  const FROM = ["environment", "keychain", "missing"];
  const isKey = (k) => k && str(k.name) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k.name) && FROM.includes(k.from) && opt(k.error, str);

  const isConnector = (c) => c && typeof c === "object" && str(c.name) && opt(c.url, str) && opt(c.image, str) && strs(c.command) &&
    strs(c.tools) && strs(c.writes) && opt(c.approve, bool) && opt(c.signedIn, bool) && objs(c.secrets, isKey);

  // asConnectors is the Connectors page's data if its frame is well formed
  // (the file, Claude's key, a list), else null. Each connector a name with
  // its keys, each key a name and where it's found, is kept; any other is
  // left out and counted in unreadable, so one bad entry never hides the
  // rest, or the form for Claude's key (review 27). A value is never sent,
  // so none is read.
  function asConnectors(v) {
    if (!v || typeof v !== "object" || !str(v.file) || !isKey(v.anthropic) || !opt(v.error, str) || !Array.isArray(v.connectors)) return null;
    const good = v.connectors.filter(isConnector);
    return { ...v, connectors: good, unreadable: v.connectors.length - good.length };
  }

  // asRegistryPage is a page of the MCP Registry as the server sends it,
  // keeping only well-formed servers: name, description and fit, and an
  // https:// address for one that's ready; else null.
  function asRegistryPage(v) {
    if (!v || typeof v !== "object" || !Array.isArray(v.servers) || !opt(v.next, str)) return null;
    const https = (u) => str(u) && /^https:\/\/[^\s]+$/.test(u);
    const servers = v.servers.filter((e) => e && typeof e === "object" && str(e.name) && opt(e.title, str) && str(e.description) &&
      str(e.suggest) && opt(e.why, str) && opt(e.token, bool) && opt(e.link, (l) => l === "" || https(l)) &&
      (e.fit === "ready" ? https(e.url) : e.fit === "no" && str(e.why)));
    return { servers, next: v.next || "", hidden: v.servers.length - servers.length };
  }

  // freeName is a connector name like want that none of taken has, within
  // the 24 characters a name may have (review 28).
  function freeName(want, taken) {
    if (!taken.includes(want)) return want;
    for (let i = 2; ; i++) {
      const n = want.slice(0, 24 - String(i).length - 1).replace(/-+$/, "") + "-" + i;
      if (!taken.includes(n)) return n;
    }
  }

  // signInURL is u if it's somewhere a sign-in may send the browser: an
  // https:// address (or this machine's, for testing); else "".
  function signInURL(u) {
    return typeof u === "string" && /^(https:\/\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s]*)$/.test(u) ? u : "";
  }

  // connectorProblem is what a step's failure says is missing to reach a
  // connector, from pirn's own words, or null: {missing: [connector
  // names]} for connectors the worker doesn't have, {tools: [connector
  // names]} for connectors it has but without every tool the step asks
  // for, {key, connector} for a key not set (again: it must be stored
  // again), {locked: true} for a keychain locked or waiting to be
  // allowed. Each sentence must be pirn's whole sentence, ending the
  // failure, so text a tool returned can't easily pass for one (review 31).
  function connectorProblem(failure) {
    if (!str(failure)) return null;
    const NAME = /^[a-z0-9-]{1,24}$/;
    const names = (g) => [...new Set(g.split(/\s+/).filter(Boolean).map((x) => x.split("/")[0]))];
    let m = /the step asks for "([^"]*)", but this worker grants only "([^"]*)" of it \(its connectors: "([^"]*)"\)$/.exec(failure);
    if (m) {
      // What the worker has is its connectors (the third), not what of
      // the ask it covers (the second): a connector it has with fewer
      // tools is not missing (review 31).
      const has = new Set(names(m[3]));
      const asked = names(m[1]).filter((n) => NAME.test(n));
      const missing = asked.filter((n) => !has.has(n));
      if (missing.length) return { missing };
      const got = new Set(m[2].split(/\s+/).filter(Boolean));
      const tools = names(m[1].split(/\s+/).filter((g) => g && !got.has(g)).join(" ")).filter((n) => NAME.test(n));
      return tools.length ? { tools } : null;
    }
    m = /connector "([a-z0-9-]{1,24})" needs ([A-Za-z_][A-Za-z0-9_]{0,63}): store it with `heedle secret set \2` \(or `loom secret set \2`\), or set it where the worker runs$/.exec(failure);
    if (m) return { connector: m[1], key: m[2] };
    m = /connector "([a-z0-9-]{1,24})": can't read ([A-Za-z_][A-Za-z0-9_]{0,63}) now: .*the keychain's \2 isn't one line of printable ASCII \(was it made outside heedle\?\): store it again with `heedle secret set \2`$/.exec(failure);
    if (m) return { connector: m[1], key: m[2], again: true };
    if (/the worker has no Anthropic API key: run `heedle secret set ANTHROPIC_API_KEY`, or set ANTHROPIC_API_KEY where it runs$/.test(failure)) return { key: "ANTHROPIC_API_KEY" };
    // Only a keychain that is locked, or waiting for a window to be
    // answered, is fixed by unlocking it; other reasons it couldn't be
    // read stand as they are (review 31).
    if (/can't read (?:[A-Za-z_][A-Za-z0-9_]*|its Anthropic API key) now: .*(?:keychain: the keyring holding [A-Za-z_][A-Za-z0-9_]* is locked: unlock it|keychain: \S+ didn't answer in \S+: is it waiting for you to allow access in a window, or locked\?)/.test(failure)) return { locked: true };
    return null;
  }

  // skillConnectors is, for each connector a skill's grant names, whether
  // this worker can use it: "connected" (it has it, every key found),
  // "key" (it has it, a key missing), "absent", or "unknown" when the
  // connectors couldn't be read or its file fails its check (review 31:
  // a connector without its key isn't connected).
  function skillConnectors(grant, v) {
    const names = [...new Set(String(grant || "").split(/\s+/).filter(Boolean).map((g) => g.split("/")[0]))];
    return names.map((name) => {
      if (!v || v.error) return { name, state: "unknown" };
      const c = v.connectors.find((x) => x.name === name);
      return { name, state: !c ? "absent" : c.secrets.some((k) => k.from === "missing") ? "key" : "connected" };
    });
  }

  // stoppedBy is the steps that ended a run without finishing, each with
  // what Temporal last said went wrong: failed or timed out, with a
  // failure. A step retried and then completed isn't one.
  function stoppedBy(steps) {
    return (Array.isArray(steps) ? steps : []).filter((s) => s && (s.status === "Failed" || s.status === "TimedOut") && str(s.failure));
  }

  // === The front door =======================================================

  const NEED = /^(|absent|tools|key|unreadable)$/;
  const isNeed = (n) => n && typeof n === "object" && str(n.connector) && /^[a-z0-9-]{1,24}$/.test(n.connector) && opt(n.tools, strs) &&
    (n.problem === undefined || NEED.test(n.problem)) && opt(n.key, str) && opt(n.detail, str) && opt(n.writes, strs) && opt(n.approve, bool);
  const isReady = (r) => r && typeof r === "object" && objs(r.needs || [], isNeed) && (r.claude === undefined || /^(|key|unreadable)$/.test(r.claude)) &&
    opt(r.claudeDetail, str) && opt(r.agent, str) && opt(r.browser, str) && opt(r.browserAgent, str) && opt(r.error, str) && bool(r.ready);
  // An act step's host, as reed's allowlist writes it: a lower-case name
  // or address.
  const ACT_HOST = /^[a-z0-9.:\[\]-]{1,253}$/;
  // pendingForm is a live frame's form waiting to be sent (roadmap 9.7),
  // or null.
  function pendingForm(f) {
    const p = f && f.kind === "act" && f.pending;
    return p && typeof p === "object" && str(p.id) && /^[0-9a-f]{1,64}$/.test(p.id) && str(p.summary) && opt(p.node, str) && str(p.url) ? p : null;
  }

  // PROFILE are the person's details act steps may use (roadmap 9.8), in
  // words; usesOf says whether v names some of them, each once.
  const PROFILE = { name: "name", email: "email", phone: "phone number", address: "address", birthdate: "date of birth" };
  const usesOf = (v) => strs(v) && v.every((f) => Object.hasOwn(PROFILE, f)) && new Set(v).size === v.length;
  // usesWords is a list of details in words: "your name, email and date of birth".
  function usesWords(v) {
    const w = (usesOf(v) ? v : []).map((f) => PROFILE[f]);
    return w.length < 2 ? w.join("") : w.slice(0, -1).join(", ") + " and " + w[w.length - 1];
  }

  // strsOf is v if it's a list of hosts as act writes them, else [].
  function strsOf(v) { return strs(v) && v.every((x) => ACT_HOST.test(x)) ? v : []; }

  // asProposal is a proposal as the API sends it, if well formed: a
  // summary, and a program with its plan (perhaps a schedule with a name,
  // and whether it can run now) or a skill to create; else null.
  function asProposal(v) {
    if (!v || typeof v !== "object" || !str(v.summary) || !v.summary.trim() || !opt(v.program, str) || !opt(v.skill, str) || !opt(v.name, str)) return null;
    const program = v.program || "", skill = v.skill || "";
    // What it suggests remembering, and the memories that went to Claude
    // (roadmap 10.1); a proposal may be only something to remember.
    if (!opt(v.remember, (r) => strs(r) && r.every((x) => x.trim() && x.length <= 2000)) || !opt(v.memory, (m) => strs(m) && m.every((x) => MEMORY_ID.test(x)))) return null;
    const remember = v.remember || [];
    if (!program === !skill && !(!program && !skill && remember.length)) return null;
    if (program && (!v.plan || !Array.isArray(v.plan.nodes))) return null;
    const sp = v.schedule;
    if (sp !== undefined && sp !== null && (!program || typeof sp !== "object" || !opt(sp.every, num) || !opt(sp.cron, str) || !opt(sp.timeZone, str) ||
      !sp.every === !sp.cron || !/^[a-z0-9-]{1,40}$/.test(v.name || ""))) return null;
    if (v.ready !== undefined && v.ready !== null && !isReady(v.ready)) return null;
    // The hosts its act steps may submit forms on, disclosed before Run
    // (roadmap 9.5): only with a program.
    if (!opt(v.actHosts, (h) => strs(h) && h.every((x) => ACT_HOST.test(x))) || (v.actHosts && v.actHosts.length && !program)) return null;
    // Roadmap 9.7: the hosts whose act steps send without asking, each one
    // of actHosts.
    if (!opt(v.actSendsFreely, (h) => strs(h) && h.every((x) => (v.actHosts || []).includes(x)))) return null;
    // Roadmap 9.8: the person's details they may use, by name.
    if (!opt(v.actUses, usesOf) || (v.actUses && v.actUses.length && !program)) return null;
    return { summary: v.summary, program, plan: program ? v.plan : null, schedule: sp || null, name: sp ? v.name : "", skill, ready: v.ready ? { ...v.ready, needs: v.ready.needs || [] } : null,
      actHosts: v.actHosts || [], actSendsFreely: v.actSendsFreely || [], actUses: v.actUses || [], remember, memory: v.memory || [], usage: asStepUsages(v.usage) };
  }

  // === Memory (roadmap 10.1) ===============================================

  const MEMORY_ID = /^m[0-9a-f]{12}$/;
  const isTime = (v) => str(v) && !Number.isNaN(Date.parse(v));

  // asMemory is /api/memory's answer, if well formed: everything heedle
  // remembers, word for word, with the version a change is based on and
  // the file it's in; else null.
  function asMemory(v) {
    if (!v || typeof v !== "object" || !Array.isArray(v.memories) || !str(v.version) || !str(v.file)) return null;
    // A memory edited by hand into one heedle won't send has a problem:
    // why, to see and forget it (review 47).
    if (!opt(v.problems, (p) => p && typeof p === "object" && !Array.isArray(p) && Object.values(p).every(str))) return null;
    const ok = v.memories.every((m) => m && typeof m === "object" && MEMORY_ID.test(m.id) && str(m.text) && (m.added === undefined || isTime(m.added)) && opt(m.used, isTime));
    const problems = v.problems || {};
    return ok ? { memories: v.memories.map((m) => ({ id: m.id, text: m.text, added: m.added || "", used: m.used || "", problem: Object.prototype.hasOwnProperty.call(problems, m.id) ? problems[m.id] : "" })),
      version: v.version, file: v.file, problem: Object.prototype.hasOwnProperty.call(problems, "") ? problems[""] : "" } : null;
  }

  // forgetInConversation is the conversation kept for the tab (json),
  // without the turns made with any of the memories ids, just forgotten:
  // what they proposed may repeat them (review 47).
  // The forgotten words (texts) leave the suggestions the kept turns made,
  // too.
  function forgetInConversation(json, ids, texts = []) {
    const gone = new Set(ids), words = new Set(texts.map((t) => t.toLowerCase()));
    return restoreConversation(json).filter((t) => !(t.proposal && t.proposal.memory.some((id) => gone.has(id))))
      .map((t) => (t.proposal ? { ...t, proposal: { ...t.proposal, remember: t.proposal.remember.filter((r) => !words.has(r.toLowerCase())) } } : t));
  }

  // notNow is the suggestions turned down with Not now for this tab, as
  // kept in json: a list of strings, the newest 50; anything else, none.
  function notNow(json, add) {
    let v;
    try { v = JSON.parse(json || "[]"); } catch { v = []; }
    const kept = Array.isArray(v) ? v.filter(str) : [];
    return add === undefined ? kept : [...kept.filter((t) => t !== add), add].slice(-50);
  }

  // usedMemory is the card's line for the memories a request sent to
  // Claude: "Used 1 thing heedle remembers", or "" for none.
  function usedMemory(ids) {
    const n = Array.isArray(ids) ? ids.length : 0;
    return n ? `Used ${n} thing${n === 1 ? "" : "s"} heedle remembers` : "";
  }

  // asReadiness is /api/ready's answer, if well formed; else null.
  function asReadiness(v) { return isReady(v) ? { ...v, needs: v.needs || [] } : null; }

  // readyLines are what a proposal needs, a line each: what it is, whether
  // it's there, and if not, what to do and where (a link to the Connectors
  // page, or none when it isn't done there).
  function readyLines(r) {
    if (!r) return [];
    if (r.error) return [{ what: "This plan", ok: false, fix: `Can't run as it is: ${r.error}`, href: "" }];
    const out = [];
    if (r.agent) out.push({ what: "Agent steps", ok: false, fix: r.agent, href: "" });
    if (r.browser) out.push({ what: "Browse steps", ok: false, fix: r.browser, href: "" });
    if (r.browserAgent) out.push({ what: "Act steps", ok: false, fix: r.browserAgent, href: "" });
    if (r.claude === "key") out.push({ what: "Claude", ok: false, fix: "No Anthropic API key yet. Paste one on the connectors page.", href: "#/connectors" });
    else if (r.claude === "unreadable") out.push({ what: "Claude", ok: false, fix: `Can't read the Anthropic API key now: ${r.claudeDetail || "the keychain didn't answer"}.`, href: "#/connectors" });
    for (const n of r.needs) {
      const what = n.tools && n.tools.length ? `${n.connector} (${n.tools.join(", ")})` : n.connector;
      const fix = {
        "": "",
        absent: `Not connected. Add a connector named ${n.connector}.`,
        tools: `Connected, but it doesn't allow ${n.tools && n.tools.length ? "those tools" : "every tool"}. Add them to its tools.`,
        key: `Connected, but its key ${n.key} isn't set.`,
        // Review 33: an expired sign-in reads as this too; the connectors
        // page is where to sign in again, or see what's wrong.
        unreadable: `Can't read its key ${n.key} now: ${n.detail || "the keychain didn't answer"}.`,
      }[n.problem || ""];
      // What a step could change, said before it runs (review 33).
      const writes = n.writes && n.writes.length ? `Can change things: ${n.writes.join(", ")}, ${n.approve ? "each waiting for your approval" : "without asking you"}.` : "";
      out.push({ what, ok: !n.problem, fix, writes, asks: !!n.approve, href: n.problem ? "#/connectors" : "" });
    }
    return out;
  }

  // restoreConversation is a conversation the page kept (JSON), keeping
  // only well-formed turns, newest ten; [] if there's none.
  function restoreConversation(json) {
    let v;
    try { v = JSON.parse(json || "[]"); } catch { return []; }
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const t of v) {
      if (!t || !str(t.request)) continue;
      if (str(t.error)) out.push({ request: t.request, error: t.error });
      else { const p = asProposal(t.proposal); if (p) out.push({ request: t.request, proposal: p }); }
    }
    return out.slice(-10);
  }

  // goDuration is nanoseconds as a Go duration ("168h", "90m").
  function goDuration(ns) {
    const m = Math.round(ns / 6e10);
    return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  }

  // earlierTurns is what the API is told of the conversation before a
  // request: each turn's request, summary and program, newest MaxTurns.
  function earlierTurns(conv, max = 10) {
    // Each with the memories it was made with, so loom leaves out what a
    // turn made with a memory since forgotten proposed (review 47).
    return conv.filter((t) => t.proposal).slice(-max).map((t) => ({ request: t.request, summary: t.proposal.summary, program: t.proposal.program || "", memory: t.proposal.memory || [] }));
  }

  // localDay is d's date where the browser is, as YYYY-MM-DD.
  function localDay(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // === Schedules ============================================================

  const RUN_ID = /^[A-Za-z0-9._:\-]{1,300}$/;

  // asSchedules is the schedules the API lists, keeping only well-formed
  // ones: a name, a program, when it runs, and runs with workflow and run
  // IDs fit for a link; else [].
  function asSchedules(v) {
    if (!v || !Array.isArray(v.schedules)) return [];
    return v.schedules.filter((s) => s && str(s.name) && /^[a-z0-9-]{1,40}$/.test(s.name) && str(s.program) && str(s.ref) &&
      s.spec && typeof s.spec === "object" && opt(s.spec.every, num) && opt(s.spec.cron, str) && opt(s.spec.timeZone, str) &&
      bool(s.paused) && opt(s.note, str) && (s.next === null || strs(s.next)) && (s.budget === undefined || asBudget(s.budget)) &&
      (s.recent === null || objs(s.recent, (r) => str(r.workflowId) && RUN_ID.test(r.workflowId) && str(r.runId) && RUN_ID.test(r.runId) && str(r.at))));
  }

  // when says when a schedule runs, for people: its spec's every (Go's
  // nanoseconds) or cron times and zone.
  function when(spec) {
    if (spec.every) {
      const m = Math.round(spec.every / 6e10);
      if (m % 1440 === 0) return m === 1440 ? "every day" : `every ${m / 1440} days`;
      if (m % 60 === 0) return m === 60 ? "every hour" : `every ${m / 60} hours`;
      return m === 1 ? "every minute" : `every ${m} minutes`;
    }
    const words = cronWords(spec.cron);
    return words ? `${words} (${spec.timeZone || "UTC"})` : `at cron ${spec.cron} (${spec.timeZone || "UTC"})`;
  }

  // cronWords says a simple cron expression in words: a minute and an hour,
  // every day of the month and month, on every day, weekdays, or one day
  // of the week ("every Monday at 8:00"); else "".
  function cronWords(cron) {
    const f = String(cron || "").trim().split(/\s+/);
    if (f.length !== 5 || !/^\d{1,2}$/.test(f[0]) || !/^\d{1,2}$/.test(f[1]) || f[2] !== "*" || f[3] !== "*") return "";
    const m = +f[0], h = +f[1];
    if (m > 59 || h > 23) return "";
    const at = `at ${h}:${String(m).padStart(2, "0")}`;
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    if (f[4] === "*") return `every day ${at}`;
    if (f[4] === "1-5") return `every weekday ${at}`;
    if (/^[0-7]$/.test(f[4])) return `every ${DAYS[+f[4]]} ${at}`;
    return "";
  }

  // tokenName is the keychain name the server keeps a connector's token
  // under (drawdown.TokenName).
  const tokenName = (name) => "HEEDLE_CONNECTOR_" + name.toUpperCase().replace(/-/g, "_") + "_TOKEN";

  // keysMissing counts the keys, the Anthropic key's included, that are
  // found nowhere.
  function keysMissing(v) {
    return [v.anthropic, ...v.connectors.flatMap((c) => c.secrets)].filter((k) => k.from === "missing").length;
  }

  // === The top bar ==========================================================

  // SECTIONS are the top bar's sections, in its order.
  const SECTIONS = ["runs", "skills", "schedules", "costs", "connectors", "memory", "system"];

  // PAGES is every page the app shows other than the home page: the
  // route's first segment, the lengths of route it takes, and the section
  // it belongs to. App picks what to show from page(), so a page and its
  // section can't disagree.
  const PAGES = {
    agent: { sizes: [2], section: "runs" },
    run: { sizes: [3], section: "runs" },
    step: { sizes: [4], section: "runs" },
    diff: { sizes: [3], section: "runs" },
    skills: { sizes: [1], section: "skills" },
    skill: { sizes: [2, 3], section: "skills" },
    review: { sizes: [2], section: "skills" },
    schedules: { sizes: [1], section: "schedules" },
    costs: { sizes: [1], section: "costs" },
    connectors: { sizes: [1], section: "connectors" },
    memory: { sizes: [1], section: "memory" },
    system: { sizes: [1], section: "system" },
  };

  // page is the page a route (the hash's decoded segments) shows, and its
  // section: {name, section}. Any route no page takes, "" included, shows
  // the home page, which is Runs. Only PAGES' own names count, so a route
  // like #/constructor is the home page too.
  function page(route) {
    const r = Array.isArray(route) ? route : [];
    const p = str(r[0]) && Object.prototype.hasOwnProperty.call(PAGES, r[0]) ? PAGES[r[0]] : null;
    return p && p.sizes.includes(r.length) ? { name: r[0], section: p.section } : { name: "home", section: "runs" };
  }

  // A count beside a section says how many things there need you. Each is
  // read from a request()'s answer only if it's well formed: a failed or
  // malformed answer gives null, and the bar shows no count.
  const answered = (res) => res && typeof res === "object" && res.ok === true && res.data && typeof res.data === "object" && !Array.isArray(res.data);

  // skillsWaiting counts the skills waiting for review, as the Skills page
  // lists them.
  function skillsWaiting(res) {
    if (!answered(res) || !Array.isArray(res.data.skills) || !opt(res.data.pending, Array.isArray)) return null;
    return (res.data.pending || []).filter((s) => asSkill(s) && s.pending === true).length;
  }

  // keysToSet counts the keys, Claude's included, that are set nowhere:
  // the number the Connectors page says aren't set yet. A connector
  // signed in to keeps its token as a key, so a sign-in to do again
  // counts too.
  function keysToSet(res) {
    const v = answered(res) ? asConnectors(res.data) : null;
    return v ? keysMissing(v) : null;
  }

  // Temporal's notes for a schedule it paused because a run failed or timed
  // out (PauseOnFailure), from its workflow-backed scheduler and from the
  // newer one. A pause from heedle or anywhere else isn't a failure.
  const FAILURE_PAUSE = /^(paused due to workflow (failure|timeout): |paused, workflow (failed|timedout): )/;

  // schedulesStopped counts the schedules paused by a run that failed, or
  // by their monthly budget (roadmap 10.4).
  function schedulesStopped(res) {
    if (!answered(res) || !Array.isArray(res.data.schedules)) return null;
    return asSchedules(res.data).filter((s) => s.paused && str(s.note) && (FAILURE_PAUSE.test(s.note) || BUDGET_PAUSE.test(s.note))).length;
  }

  // === System (roadmap 9.2) ================================================

  const KINDS9 = ["agent", "skill", "container", "connector", "browse", "act"];
  const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,254}$/;
  const label = (v) => v === undefined || v === "" || (str(v) && LABEL_VALUE.test(v));
  const isContainer = (c) => c && typeof c === "object" && str(c.id) && /^[0-9a-f]{64}$/.test(c.id) && str(c.name) && str(c.image) &&
    c.labels && typeof c.labels === "object" && KINDS9.includes(c.labels.kind) && label(c.labels.workflow) && label(c.labels.run) && label(c.labels.step) &&
    str(c.created) && str(c.state) && opt(c.cpu, str) && opt(c.memory, str) && label(c.workflow) && label(c.run) && opt(c.status, str) && opt(c.stoppable, bool);
  const isImage = (im) => im && typeof im === "object" && str(im.id) && strs(im.names) && im.names.length > 0 && num(im.size) && num(im.containers) && bool(im.pinned) && str(im.created);
  const isMachine = (m) => m && typeof m === "object" && str(m.name) && bool(m.running) && num(m.cpus) && num(m.memory) && num(m.disk);

  // asSystem is /api/system's answer if its frame is well formed: the
  // containers, images and notes it lists, each kept only if well formed
  // and the others counted in unreadable, so one bad entry never hides the
  // rest; else null.
  function asSystem(v) {
    if (!v || typeof v !== "object" || !Array.isArray(v.containers) || !Array.isArray(v.images) || !strs(v.keep) || !strs(v.notes) ||
      !(v.machine === null || isMachine(v.machine)) || !v.errors || typeof v.errors !== "object" || !Object.values(v.errors).every(str)) return null;
    const containers = v.containers.filter(isContainer), images = v.images.filter(isImage);
    return { ...v, containers, images, unreadable: v.containers.length - containers.length + v.images.length - images.length };
  }

  // runOf is a container's run as a link to its page, if it names one a
  // link can hold; else null.
  function runOf(c) {
    return c.workflow && c.run && RUN_ID.test(c.workflow) && RUN_ID.test(c.run)
      ? { href: "#/run/" + encodeURIComponent(c.workflow) + "/" + encodeURIComponent(c.run), workflow: c.workflow } : null;
  }

  // stoppable says whether a container's run can be stopped from the page:
  // the server says Temporal knows it as a run that is running (DRAW-506),
  // and the page knows exactly which run it is.
  const stoppable = (c) => c.stoppable === true && !!c.workflow && !!c.run;

  // oldImages are the images a prune would remove: not kept, used by no
  // container; and their bytes.
  function oldImages(images) {
    const old = images.filter((im) => !im.pinned && im.containers === 0);
    return { images: old, bytes: old.reduce((n, im) => n + im.size, 0) };
  }

  // === Costs (roadmap 10.4) =================================================
  // Tokens are what the records say; dollars are estimates, and a figure is
  // shown only when every step it covers had a price.

  // loom's note for a schedule its budget paused (loom.BudgetPaused).
  const BUDGET_PAUSE = /^paused: monthly budget \$[0-9]+\.[0-9]{2} (reached \((at most \$[0-9]+\.[0-9]{2}, )?est\.\)|can't be checked) in [A-Z][a-z]+ [0-9]{4}/;
  const isTokens = (t) => t && typeof t === "object" && num(t.input) && num(t.output) && t.input >= 0 && t.output >= 0;
  const isStepUsage = (s) => str(s.node) && str(s.kind) && opt(s.model, str) && isTokens(s.tokens) && opt(s.requests, num) && opt(s.missing, str) &&
    opt(s.replayed, (r) => r === "all" || r === "part");
  const isUnpriced = (u) => str(u.node) && opt(u.model, str) && isTokens(u.tokens) && str(u.why) && opt(u.atMost, num);
  // isSpent is drawdown's spent: tokens, and usd only if all was priced.
  const isSpent = (v) => v && typeof v === "object" && num(v.runs) && isTokens(v.tokens) && (v.usd === null || num(v.usd)) && num(v.priced) && opt(v.atMost, num) && objs(v.unpriced, isUnpriced);
  // asStepUsages is a usage's steps, if well formed; else [].
  function asStepUsages(v) { return v && objs(v.steps, isStepUsage) ? v.steps : []; }
  // asBudget is a schedule's budget, if it has one and it's well formed.
  function asBudget(b) { return b && typeof b === "object" && num(b.usd) && b.usd > 0 && opt(b.resumeNextMonth, bool) ? b : null; }
  // asRunUsage is the run page's usage: each Claude step and the cost.
  function asRunUsage(v) {
    if (!v || typeof v !== "object" || !objs(v.steps, isStepUsage) || !isTokens(v.total) || !v.cost || typeof v.cost !== "object") return null;
    const c = v.cost;
    if (!num(c.usd) || !bool(c.complete) || !objs(c.unpriced, isUnpriced) || !str(c.asOf) || !str(c.source) || !c.byModel || typeof c.byModel !== "object") return null;
    return { steps: v.steps, total: v.total, cost: c, pricesError: str(v.pricesError) ? v.pricesError : "" };
  }
  // asSpend is the Schedules page's spend per schedule: month and last30.
  function asSpend(v) {
    const out = {};
    if (!v || typeof v.spend !== "object" || v.spend === null) return out;
    for (const [k, x] of Object.entries(v.spend)) if (x && isSpent(x.month) && isSpent(x.last30)) out[k] = x;
    return out;
  }
  // asCosts is the Costs page's answer, if well formed; else null.
  function asCosts(v) {
    if (!v || typeof v !== "object" || !str(v.asOf) || !str(v.source) || !str(v.zone) || !opt(v.yours, strs) || !opt(v.pricesError, str)) return null;
    const months = objs(v.months, (m) => str(m.month) && /^\d{4}-\d{2}$/.test(m.month) && isSpent(m) && objs(m.byModel, (x) => str(x.model) && isSpent(x)) && opt(m.replayed, num));
    const runs = objs(v.runs, (r) => str(r.workflowId) && RUN_ID.test(r.workflowId) && str(r.runId) && RUN_ID.test(r.runId) && opt(r.schedule, str) && str(r.at) && isSpent(r));
    const scheds = objs(v.schedules, (s) => str(s.name) && /^[a-z0-9-]{1,40}$/.test(s.name) && isSpent(s));
    return months && runs && scheds ? { ...v, yours: v.yours || [] } : null;
  }
  // usd is dollars to the cent, or "<$0.01" for less than half a cent.
  const usd = (x) => (x > 0 && x < 0.005 ? "<$0.01" : `$${x.toFixed(2)}`);
  // estimate says what a spent costs: a figure only if every step had a
  // price; a bound if every step could be bounded, as a budget counts it
  // ("at most"); otherwise the priced part, saying how many steps have no
  // estimate.
  function estimate(v) {
    if (v.usd !== null) return `${usd(v.usd)} est.`;
    // A bound rounds up, never under (review 48 round 3).
    if (num(v.atMost)) return `at most ${usd(Math.ceil(v.atMost * 100 - 1e-9) / 100)} est.`;
    const n = v.unpriced.length;
    return v.priced > 0 ? `${usd(v.priced)} est. + ${n} step${n === 1 ? "" : "s"} with no estimate` : "no estimate";
  }
  // count is n with thousands separated.
  const count = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  // === Share a skill (roadmap 10.6) ========================================

  // shellWord is s as one word of a POSIX shell; a leading ~/ stays
  // unquoted, so the shell still reads it as your home.
  function shellWord(s) {
    s = String(s);
    const home = s.startsWith("~/") ? "~/" : "";
    const rest = home ? s.slice(2) : s;
    // A word starting with = is expanded by zsh: quoted (review 49).
    if (rest !== "" && /^[A-Za-z0-9._\/@:+-][A-Za-z0-9._\/@:+=-]*$/.test(rest)) return home + rest;
    return home + "'" + rest.replace(/'/g, "'\\''") + "'";
  }
  // publishCommand is the command that publishes a skill into a clone.
  const publishCommand = (name, repo, store) => `heedle skills publish ${shellWord(name)} -repo ${shellWord(repo || "~/src/my-skills")} -store ${shellWord(store || "~/.heedle/store.git")}`;
  // pushCommand pushes a clone's branch, setting its upstream: a fresh
  // clone has none (review 49).
  const pushCommand = (repo) => `git -C ${shellWord(repo || "~/src/my-skills")} push -u origin HEAD`;
  // shareLink is the link a friend imports a published skill with: its
  // folder on GitHub, from your repository's link and branch; "" unless
  // that is a GitHub repository's link.
  function shareLink(repo, branch, name) {
    const m = /^(?:https:\/\/)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(repo).trim());
    const b = String(branch || "main").trim();
    // A branch with / reads, in a GitHub link, as a branch and a folder
    // (treadle's ParseGitHub): refused (review 49).
    if (!m || !/^[A-Za-z0-9._-]+$/.test(b) || b.includes("..") || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "";
    return `https://github.com/${m[1]}/${m[2]}/tree/${b}/skills/${name}`;
  }

  return { asMemory, usedMemory, asSystem, runOf, stoppable, oldImages, SECTIONS, PAGES, page, skillsWaiting, keysToSet, schedulesStopped, asAnswer, asAgent, asAct, actEnding, actEndingOf, replayedAll, replayWords, locatorText, strsOf, pendingForm, PROFILE, usesOf, usesWords, asPage, asFiles, fileSummary, size, fetchCommand, skillOf, asSkill, sourceLink, visible, asWrites, MAX_UPLOAD, base64, readFolder, parse, preview, decisions, ancestors, dur, span, tokens, replaced, dayKey, byDay, monthGrid, onDay, contrast, readable, mix, tint, asCatalog, request, catalogNotes, asShape, stepsOf, layered, composition, groupKeys, flowsInto, tally, asConnectors, keysMissing, asRegistryPage, freeName, tokenName, signInURL, asSchedules, when, connectorProblem, skillConnectors, stoppedBy, asProposal, asReadiness, readyLines, goDuration, earlierTurns, localDay, restoreConversation, program, unquote, grantOf, links, lines, FOLD_AT, FOLD_SHOW, tokenClass, forgetInConversation, notNow, asStepUsages, asBudget, asRunUsage, asSpend, asCosts, usd, estimate, count, BUDGET_PAUSE, shellWord, publishCommand, shareLink, pushCommand };
})();
if (typeof module !== "undefined") module.exports = DD;
