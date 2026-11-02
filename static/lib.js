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

  // parse reads a step's output: {agent}, {answer}, {page}, or {text} for
  // anything else, including JSON that only looks like one of them.
  function parse(text) {
    if (!str(text)) return { text: "" };
    let v;
    try { v = JSON.parse(text); } catch { return { text }; }
    if (v && v.agent !== undefined) {
      const agent = asAgent(v);
      return agent ? { agent } : { text };
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
    return v;
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

  // tokens splits a program into strings, parentheses, words and spaces,
  // keeping every character.
  function tokens(src) {
    const out = [];
    const re = /("(?:[^"\\]|\\.)*"?)|([()])|([^\s()"]+)|(\s+)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[1]) out.push(["str", m[1]]);
      else if (m[2]) out.push(["paren", m[2]]);
      else if (m[3]) out.push(["word", m[3]]);
      else out.push(["space", m[4]]);
    }
    return out;
  }

  return { asAnswer, asAgent, asPage, asFiles, fileSummary, size, fetchCommand, skillOf, asSkill, sourceLink, visible, asWrites, MAX_UPLOAD, base64, readFolder, parse, preview, decisions, ancestors, dur, span, tokens };
})();
if (typeof module !== "undefined") module.exports = DD;
