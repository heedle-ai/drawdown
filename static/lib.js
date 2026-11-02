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

  // asPage is v if it's a browse step's page (reed's JSON, format 1), with
  // every field the page reads of the right type; else null.
  function asPage(v) {
    if (!v || typeof v !== "object" || v.reed !== 1) return null;
    if (!str(v.url) || !opt(v.title, str) || !opt(v.text, str) || !opt(v.screenshot, str)) return null;
    if (!strs(v.allowed) || !strs(v.blocked) || !opt(v.blockedTotal, num)) return null;
    return v;
  }

  // parse reads a step's output: {answer}, {page}, or {text} for anything
  // else, including JSON that only looks like an answer or a page.
  function parse(text) {
    if (!str(text)) return { text: "" };
    let v;
    try { v = JSON.parse(text); } catch { return { text }; }
    const answer = asAnswer(v);
    if (answer) return { answer };
    const page = asPage(v);
    if (page) return { page };
    return { text };
  }

  // preview is an output as plain text, for hover cards.
  function preview(text) {
    const o = parse(text);
    if (o.answer) return o.answer.text;
    if (o.page) return `${o.page.title || o.page.url}\n${(o.page.text || "").slice(0, 300)}`;
    return o.text;
  }

  // decisions are what a step concluded, as [label, value] rows.
  function decisions(kind, text) {
    if (!str(text)) return [];
    const o = parse(text);
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

  return { asAnswer, asPage, parse, preview, decisions, ancestors, dur, span, tokens };
})();
if (typeof module !== "undefined") module.exports = DD;
