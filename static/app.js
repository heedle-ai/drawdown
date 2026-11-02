// drawdown: React (UMD) with htm for JSX-style markup, mermaid for plan
// graphs, diff2html for diffs. No build step.
const { useState, useEffect, useRef, useLayoutEffect, useContext, createContext } = React;
const html = htm.bind(React.createElement);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: { fontFamily: "Bricolage Grotesque, system-ui, sans-serif", lineColor: css("--muted"), primaryTextColor: css("--ink") },
  flowchart: { curve: "basis", nodeSpacing: 28, rankSpacing: 44 },
});

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const ct = res.headers.get("Content-Type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

// === Routing: #/, #/run/<workflow>/<run>, #/diff/<from>/<to>, #/agent/<ref> ==

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.slice(2).split("/").map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } });
}

const go = (...parts) => { location.hash = "#/" + parts.map(encodeURIComponent).join("/"); };
const short = (id) => (id ? id.slice(0, 7) : "");
const real = (t) => t && !t.startsWith("0001");
const when = (t) => (real(t) ? new Date(t).toLocaleString() : "");
const ms = (a, b) => (real(a) && real(b) ? new Date(b) - new Date(a) : null);
const dur = (n) => (n == null ? "" : DD.dur(n));
const took = (a, b) => dur(ms(a, b));
const ago = (t) => {
  if (!real(t)) return "";
  const s = Math.round((Date.now() - new Date(t)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const bytes = (s) => { const n = new Blob([s || ""]).size; return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`; };

// === Kinds of step: one dye each ===========================================

const KIND_OF_ACTIVITY = { Echo: "echo", Source: "source", Assess: "assess", Browse: "browse", Ask: "ask", Agent: "agent", Container: "container", Image: "image", Skill: "skill", LoomRecord: "record" };
const KIND_OF_COMMAND = { echo: "echo", source: "source", assess: "assess", browse: "browse", ask: "ask", agent: "agent", container: "container", image: "image" };
const KIND_LABEL = { echo: "echo", source: "source", assess: "assess", browse: "browse", ask: "ask Claude", agent: "Claude agent", container: "container", image: "image build", skill: "skill", record: "Git record", other: "step" };
const kindOf = (activity) => KIND_OF_ACTIVITY[activity] || "other";
const kindColor = (kind) => css("--" + kind) || css("--other");

function Pill({ cls, children, mono, big, plain }) {
  return html`<span class=${["pill", cls, mono && "mono", big && "big", plain && "plain"].filter(Boolean).join(" ")}>${children}</span>`;
}
const StatusPill = ({ status, big }) => html`<${Pill} cls=${"s-" + status} big=${big}>${status}<//>`;
const KindPill = ({ kind, children }) => html`<${Pill} cls=${"k-" + kind}>${children || KIND_LABEL[kind]}<//>`;

// === Hover cards ===========================================================
// One card for the whole page, shown beside whatever is hovered or focused.

const TipContext = createContext({ show() {}, hide() {} });

function TipLayer({ tip }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!tip || !ref.current) { setPos(null); return; }
    const r = tip.rect, w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    let left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
    setPos({ left, top });
  }, [tip]);
  if (!tip) return null;
  return html`<div class="tip" ref=${ref} role="tooltip" id="tip"
    style=${{ left: (pos ? pos.left : -9999) + "px", top: (pos ? pos.top : -9999) + "px", "--c": tip.color || "" }}>${tip.content}</div>`;
}

// Tip wraps children so hovering or focusing them shows content.
function Tip({ content, color, tag = "span", focusable = true, children, ...rest }) {
  const tip = useContext(TipContext);
  const show = (e) => tip.show(e.currentTarget, content, color);
  return React.createElement(tag, {
    ...rest, tabIndex: focusable ? (rest.tabIndex ?? 0) : undefined, "aria-describedby": "tip",
    onMouseEnter: show, onFocus: show, onMouseLeave: tip.hide, onBlur: tip.hide,
  }, children);
}

function Card({ title, children }) {
  return html`<div><h4>${title}</h4><dl>${children}</dl></div>`;
}
const Field = ({ k, children }) => children === "" || children == null || children === false ? null : html`<dt>${k}</dt><dd>${children}</dd>`;

// === Programs, highlighted =================================================

function Program({ text, max }) {
  const src = max && text.length > max ? text.slice(0, max) + " …" : text;
  const out = DD.tokens(src).map(([kind, v], k) => {
    if (kind === "str") return html`<span key=${k} class="str">${v}</span>`;
    if (kind === "paren") return html`<span key=${k} class="p">${v}</span>`;
    if (kind === "word") {
      const c = KIND_OF_COMMAND[v];
      if (c) return html`<span key=${k} class=${"cmd k-" + c}>${v}</span>`;
      if (v === "pipe" || v === "par") return html`<span key=${k} class="comb">${v}</span>`;
    }
    return v;
  });
  return html`<pre class="prog">${out}</pre>`;
}

// === Agents: one tab each ==================================================
// An agent is a ref under refs/loom/. Its sub-agents are the refs that
// extend its name with a dot: research.web is a sub-agent of research.
// (Git can't have both refs/loom/research and refs/loom/research/web.)

const AGENT_PREFIX = "refs/loom/";
const agentName = (ref) => (ref.startsWith(AGENT_PREFIX) ? ref.slice(AGENT_PREFIX.length) : ref);
const parentRef = (ref) => {
  const name = agentName(ref);
  const i = name.lastIndexOf(".");
  return i < 0 ? null : AGENT_PREFIX + name.slice(0, i);
};
const FAMILY = ["#3b5bdb", "#c98f00", "#0f8a6c", "#7a3fe0", "#c2185b", "#0f8fa8", "#8d5a2b"];
const familyColor = (ref) => {
  const root = agentName(ref).split(".")[0];
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FAMILY[h % FAMILY.length];
};
// Every agent's links open in one named tab per agent: opening an agent
// again focuses its tab instead of making another.
const tabName = (ref) => "heedle-agent-" + agentName(ref);
const agentHref = (ref) => "#/agent/" + encodeURIComponent(ref);

// setTab names this tab and gives it the agent family's colour.
function setTab(title, color) {
  document.title = title;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;
  let link = document.querySelector("link[rel=icon]");
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}

function AgentLink({ agent, children }) {
  return html`<a href=${agentHref(agent)} target=${tabName(agent)}>${children}</a>`;
}

function usePoll(path, every, deps) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true, timer;
    setData(null);
    const load = async () => {
      try { const r = await api(path); if (live) setData(r.data); } catch {}
      if (live && every) timer = setTimeout(load, every);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, deps);
  return data;
}

// A browse step's output is the page it saw (reed's JSON), and an ask step's
// is Claude's answer (pirn's JSON); show each as what it is.
// AgentWork shows what an agent step did: its reply, every command it ran,
// the files it kept and what changed in its container.
function AgentWork({ agent: a, part = "all" }) {
  const failed = a.commands.filter((c) => c.exitCode !== 0 || c.error).length;
  const groups = { added: [], changed: [], deleted: [] };
  for (const c of a.changes) groups[c.kind].push(c.path);
  const summary = part !== "work", work = part !== "summary";
  return html`
    <div class="answer agent-work">
      ${summary && html`<pre class="answer-text">${a.text}</pre>`}
      ${summary && html`
      <div class="pills muted">
        <${Pill} cls="k-agent">${a.model}<//>
        <${Pill} cls="k-other" plain>${a.turns} turn${a.turns === 1 ? "" : "s"}<//>
        <${Pill} cls=${failed ? "s-Failed" : "s-Completed"}>${a.commands.length} commands${failed ? `, ${failed} failed` : ""}<//>
        <${Pill} cls="k-record">${a.files.length} file${a.files.length === 1 ? "" : "s"} kept<//>
        ${a.inputTokens != null && html`<${Pill} cls="k-other" plain>${a.inputTokens} tokens in, ${a.outputTokens} out<//>`}
        ${a.stopReason === "max_turns" && html`<${Pill} cls="s-Failed">stopped at the turn limit<//>`}
        <${Pill} cls="k-container" mono>image ${a.image.replace(/^sha256:/, "").slice(0, 12)}<//>
      </div>`}
      ${work && html`<details open=${part === "work" || a.commands.length <= 6}><summary>Commands (${a.commands.length})</summary>
        <ol class="commands">${a.commands.map((c, i) => html`
          <li key=${i}>
            <div class="cmd-line"><span class=${"exit " + (c.exitCode === 0 && !c.error ? "ok" : "bad")}>${c.error ? "!" : c.exitCode}</span>
              <code>${c.command}</code><span class="muted">${c.ms != null ? dur(c.ms) : ""}</span></div>
            ${(c.stdout || c.stderr || c.error) && html`<pre class="cmd-out">${c.error ? c.error + "\n" : ""}${c.stdout || ""}${c.stderr ? "\n" + c.stderr : ""}${c.truncated ? "\n[cut]" : ""}</pre>`}
          </li>`)}</ol>
      </details>`}
      ${work && (a.tools || []).length > 0 && html`<details open><summary>Connector calls (${a.tools.length})${a.grant ? html` <span class="muted">granted ${a.grant}</span>` : ""}</summary>
        <ol class="commands">${a.tools.map((c, i) => html`
          <li key=${i}>
            <div class="cmd-line"><span class=${"exit " + (c.isError ? "bad" : "ok")}>${c.write ? "⏸" : c.isError ? "!" : "✓"}</span>
              <code>${c.connector}/${c.tool}</code><span class="muted">${c.write ? `queued as ${c.write}` : c.remote ? "run by Anthropic's MCP connector" : "run on the worker"}</span></div>
            <pre class="cmd-out">${DD.visible(c.input)}${c.output ? "\n→ " + DD.visible(c.output) : ""}${c.truncated ? "\n[cut]" : ""}</pre>
          </li>`)}</ol>
      </details>`}
      ${work && a.files.length > 0 && html`<details open><summary>Files kept from /work/out (${a.files.length})</summary>
        ${a.files.map((f) => html`<details key=${f.path} class="file"><summary><code>${f.path}</code> <span class="muted">${DD.size(f.size)}${f.oci ? ", in the registry" : f.base64 != null ? ", binary" : ""}</span></summary>
          ${f.oci ? html`<${RegistryFile} f=${f} />` : f.text != null ? html`<pre>${f.text}</pre>` : html`<p class="muted">A binary file of ${f.size} bytes, kept in the record as base64.</p>`}</details>`)}
      </details>`}
      ${work && (a.skipped || []).length > 0 && html`<p class="muted">Not kept: ${a.skipped.join("; ")}${a.skippedMore ? `, and ${a.skippedMore} more` : ""}</p>`}
      ${work && html`<details><summary>Changed in the container (${a.changes.length}${a.moreChanges ? `+${a.moreChanges}` : ""})</summary>
        ${["added", "changed", "deleted"].filter((k) => groups[k].length).map((k) => html`<div key=${k}><strong>${k}</strong><pre>${groups[k].join("\n")}</pre></div>`)}
      </details>`}
    </div>`;
}

function Output({ text }) {
  const { agent, answer, page } = DD.parse(text);
  if (agent) return html`<${AgentWork} agent=${agent} />`;
  if (answer) return html`
    <div class="answer">
      <pre class="answer-text">${answer.text}</pre>
      <div class="pills muted">
        <${Pill} cls="k-ask">${answer.model}<//>
        ${answer.inputTokens != null && html`<${Pill} cls="k-other" plain>${answer.inputTokens} tokens in<//>`}
        ${answer.outputTokens != null && html`<${Pill} cls="k-other" plain>${answer.outputTokens} tokens out<//>`}
        ${answer.stopReason === "max_tokens" && html`<${Pill} cls="s-Failed">cut off at the token limit<//>`}
      </div>
    </div>`;
  if (!page) return html`<pre>${text}</pre>`;
  const blocked = page.blockedTotal ?? (page.blocked || []).length;
  return html`
    <div class="page">
      ${page.screenshot && page.screenshot.startsWith("data:image/jpeg;base64,") &&
        html`<img src=${page.screenshot} alt=${"Screenshot of " + page.url} />`}
      <div>
        <div><strong>${page.title || "(no title)"}</strong></div>
        <div class="mono muted">${page.url}</div>
        <div class="pills" style=${{ margin: "8px 0" }}>
          ${(page.allowed || []).map((h) => html`<${Pill} key=${h} cls="s-Completed" mono>${h}<//>`)}
          <${Pill} cls=${blocked ? "s-Failed" : "k-other"}>${blocked} blocked<//>
        </div>
        <details><summary>Page text (${bytes(page.text || "")})</summary><pre>${page.text || ""}</pre></details>
        ${(page.blocked || []).length > 0 && html`<details><summary>Blocked requests</summary><pre>${page.blocked.join("\n")}</pre></details>`}
      </div>
    </div>`;
}

const preview = (text) => DD.preview(text);

// === Agents ================================================================

function AgentTree({ refs, heads, current }) {
  const sorted = [...refs].sort((a, b) => agentName(a).localeCompare(agentName(b)));
  return html`
    <ul class="tree" aria-label="Agents">${sorted.map((r) => {
      const depth = agentName(r).split(".").length - 1;
      const leaf = agentName(r).split(".").pop();
      const kids = refs.filter((c) => parentRef(c) === r).length;
      const card = html`<${Card} title=${html`<span class="dot" style=${{ "--c": familyColor(r) }}></span>${agentName(r)}`}>
        <${Field} k="Ref"><span class="mono">${r}</span><//>
        <${Field} k="Head">${heads[r] ? html`<span class="mono">${heads[r]}</span>` : "no runs yet"}<//>
        <${Field} k="Parent">${parentRef(r) ? agentName(parentRef(r)) : "none (a root agent)"}<//>
        <${Field} k="Sub-agents">${kids || "none"}<//>
        <${Field} k="Tab">opens in its own tab, ${tabName(r)}<//>
      <//>`;
      return html`<${Tip} tag="li" key=${r} content=${card} color=${familyColor(r)}
          style=${{ paddingLeft: 10 + depth * 22 + "px", "--c": familyColor(r) }} class=${r === current ? "current" : ""}>
        <span class="dot"></span>
        <span class="mono">${leaf}</span>
        ${heads[r] && html`<${Pill} cls="k-record" mono>${short(heads[r])}<//>`}
        ${kids > 0 && html`<${Pill} cls="k-other" plain>${kids} sub-agent${kids > 1 ? "s" : ""}<//>`}
        <span class="open"><${AgentLink} agent=${r}>Open tab ↗<//></span>
      <//>`;
    })}</ul>`;
}

// Live view: the latest frame of each browsing step a running run has.
function LiveView({ workflow }) {
  const data = usePoll(`/api/live/${encodeURIComponent(workflow)}`, 2000, [workflow]);
  if (!data || !data.frames || data.frames.length === 0) return null;
  return html`${data.frames.map((f) => html`
    <div class="panel live" key=${f.activity} style=${{ marginTop: "12px" }}>
      <div class="pills"><${StatusPill} status="Running" /> <${KindPill} kind="browse">live browser<//>
        <span class="mono">${f.url}</span>
        <${Pill} cls="k-other" plain>attempt ${f.attempt}<//><span class="muted">view only, updates every few seconds</span></div>
      ${f.image.startsWith("data:image/jpeg;base64,") && html`<img src=${f.image} alt=${"Live view of " + f.url} />`}
    </div>`)}`;
}

function AgentPage({ agent, refs, heads, info }) {
  useEffect(() => { setTab(agentName(agent).split(".").pop() + " · agent", familyColor(agent)); }, [agent]);
  const runs = useRuns(agent);
  const name = agentName(agent).split(".");
  const parent = parentRef(agent);
  const children = refs.filter((r) => parentRef(r) === agent);
  const running = runs && runs.runs ? runs.runs.filter((r) => r.status === "Running") : [];
  return html`
    <nav class="crumbs mono" aria-label="Breadcrumb">${name.map((seg, i) => {
      const ref = AGENT_PREFIX + name.slice(0, i + 1).join(".");
      return html`<span key=${ref}>${i > 0 && html`<span class="muted"> › </span>`}${i === name.length - 1
        ? html`<strong style=${{ color: familyColor(agent) }}>${seg}</strong>` : html`<${AgentLink} agent=${ref}>${seg}<//>`}</span>`;
    })}</nav>
    <div class="pills">
      ${heads[agent] && html`<${Pill} cls="k-record" mono>head ${short(heads[agent])}<//>`}
      ${runs && runs.runs && html`<${Pill} cls="k-other" plain>${runs.runs.length} records<//>`}
      ${parent ? html`<${Pill} cls="k-other" plain>sub-agent of ${agentName(parent)}<//>` : html`<${Pill} cls="k-other" plain>root agent<//>`}
    </div>
    ${running.length > 0 && html`<h2>Running now</h2>${running.map((r) => html`<${LiveView} key=${r.runId} workflow=${r.workflowId} />`)}`}
    <h2>Drawdown</h2>
    <p class="lede">This agent's recent runs, woven: one column per run, one cell per step.</p>
    <div class="panel"><${Weave} runs=${runs} /></div>
    <h2>Beliefs</h2>
    <p class="lede">The latest answer to every question this agent has asked.</p>
    <${Beliefs} history=${agent} />
    <h2>New run on this agent</h2><${NewRun} info=${info} history=${agent} />
    <h2>Runs</h2><${Runs} data=${runs} />
    <h2>Family</h2>
    <div class="panel">
      <div>Parent: ${parent ? html`<${AgentLink} agent=${parent}>${agentName(parent)}<//>` : html`<span class="muted">none (a root agent)</span>`}</div>
      <div>Sub-agents: ${children.length ? children.map((c, i) => html`<span key=${c}>${i > 0 && ", "}<${AgentLink} agent=${c}>${agentName(c).split(".").pop()}<//></span>`)
        : html`<span class="muted">none. Make one with <code>loom branch -from ${agent} -to ${agent}.name</code></span>`}</div>
    </div>`;
}

// === Plans: compiled once per program ======================================

const planCache = new Map();
function usePlans(programs) {
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    for (const p of programs) {
      if (!p || planCache.has(p)) continue;
      planCache.set(p, null);
      api("/api/compile", { program: p }).then((r) => {
        planCache.set(p, r.ok && r.data.plan ? r.data.plan : { nodes: [] });
        if (live) bump((n) => n + 1);
      }, () => planCache.delete(p)); // try again on the next refresh
    }
    return () => { live = false; };
  }, [programs.join("\u0000")]);
  return (p) => planCache.get(p) || null;
}

// === The drawdown: recent runs, woven ======================================

const WEAVE_RUNS = 48, WEAVE_ROWS = 12;

function Weave({ runs, all, day, onDay }) {
  const rows = runs && runs.runs ? runs.runs.slice(0, WEAVE_RUNS).reverse() : [];
  const planOf = usePlans(rows.map((r) => r.program || ""));
  if (!runs) return html`<p class="muted">Loading…</p>`;
  if (rows.length === 0 && !day) return html`<p class="muted">No runs yet. Run a program below and it appears here as a column.</p>`;
  const kinds = new Set();
  const cols = rows.map((r) => {
    const status = r.merged ? "Merged" : r.status;
    const nodes = r.merged ? [] : ((planOf(r.program || "") || { nodes: [] }).nodes || []);
    nodes.forEach((n) => kinds.add(kindOf(n.activity)));
    const summary = html`<${Card} title=${html`<${StatusPill} status=${status} /> ${r.merged ? "merge" : `${nodes.length} step${nodes.length === 1 ? "" : "s"}`}`}>
      <${Field} k="Started">${when(r.start)}<//>
      <${Field} k="Took">${took(r.start, r.close)}<//>
      <${Field} k="Record">${r.commit && html`<span class="mono">${short(r.commit)}</span>`}<//>
      <${Field} k="Workflow"><span class="mono">${r.workflowId}</span><//>
      ${r.merged && html`<${Field} k="Merged"><span class="mono">${short(r.merged)}</span>${r.resolved ? `, ${r.resolved} resolved` : ""}<//>`}
      ${!r.merged && r.program && html`<dt>Program</dt><dd><${Program} text=${r.program} max=${220} /></dd>`}
    <//>`;
    const open = () => (r.merged ? go("diff", r.parent, r.commit) : go("run", r.workflowId, r.runId));
    return html`<div key=${r.runId || r.commit} class=${"warp s-" + status} role="listitem">
      <${Tip} tag="button" class="selvedge" content=${summary} color=${css("--" + statusVar(status))}
        onClick=${open} aria-label=${`Open ${status.toLowerCase()} run, ${when(r.start)}`}><//>
      ${Array.from({ length: Math.min(WEAVE_ROWS, Math.max(nodes.length, 1)) }, (_, i) => {
        const n = nodes[i];
        if (!n) return html`<span key=${i} class=${"cell " + (r.merged ? "k-other" : "empty")}></span>`;
        const kind = kindOf(n.activity);
        return html`<${Tip} tag="button" key=${i} class=${"cell k-" + kind} color=${kindColor(kind)}
          content=${nodeCard(n)} aria-label=${`Inspect step ${n.id}, ${n.activity}`}
          onClick=${() => go("step", r.workflowId, r.runId, n.id)}><//>`;
      })}
    </div>`;
  });
  const byStatus = {}, byKind = {};
  let steps = 0;
  rows.forEach((r) => {
    const st = r.merged ? "Merged" : r.status;
    byStatus[st] = (byStatus[st] || 0) + 1;
    ((planOf(r.program || "") || { nodes: [] }).nodes || []).forEach((n) => { const k = kindOf(n.activity); byKind[k] = (byKind[k] || 0) + 1; steps++; });
  });
  return html`
    <div class="weave-row">
      <div class="weave-wrap"><div class="weave" role="list" aria-label="Recent runs">${cols}</div></div>
      <div class="weave-sum">
        <div class="big-num">${rows.length}<span> run${rows.length === 1 ? "" : "s"} · ${steps} steps</span></div>
        <div class="pills">${Object.entries(byStatus).map(([s, n]) => html`<${Pill} key=${s} cls=${"s-" + s}>${n} ${s.toLowerCase()}<//>`)}</div>
        <div class="pills">${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => html`<${Pill} key=${k} cls=${"k-" + k}>${n} ${KIND_LABEL[k]}<//>`)}</div>
      </div>
      ${all && html`<${Calendar} runs=${all.runs} day=${day} onDay=${onDay} />`}
    </div>
    <div class="legend">
      ${[...kinds].sort().map((k) => html`<${KindPill} key=${k} kind=${k} />`)}
      <span class="muted" style=${{ marginLeft: "8px" }}>top edge:</span>
      ${["Completed", "Running", "Failed", "Recorded", "Merged"].map((s) => html`<${StatusPill} key=${s} status=${s} />`)}
    </div>`;
}

// Calendar is a month of days beside the woven grid: each day is tinted by
// how many runs started on it and marked when one failed; choosing a day
// shows only its runs, and choosing it again shows all of them.
function Calendar({ runs, day, onDay }) {
  const counts = DD.byDay(runs);
  const latest = Object.keys(counts).sort().pop();
  const [shown, setShown] = useState(() => {
    const d = new Date((day || latest || DD.dayKey(new Date())) + "T12:00");
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const most = Math.max(1, ...Object.values(counts).map((c) => c.runs));
  const move = (k) => setShown(({ y, m }) => ({ y: m + k < 0 ? y - 1 : m + k > 11 ? y + 1 : y, m: (m + k + 12) % 12 }));
  const title = new Date(shown.y, shown.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const today = DD.dayKey(new Date());
  return html`
    <div class="cal" aria-label="Runs by day">
      <div class="cal-head">
        <button class="cal-nav" onClick=${() => move(-1)} aria-label="Previous month"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <strong>${title}</strong>
        <button class="cal-nav" onClick=${() => move(1)} aria-label="Next month"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="cal-grid" role="grid">
        ${["M", "T", "W", "T", "F", "S", "S"].map((d, i) => html`<span key=${"h" + i} class="cal-dow" aria-hidden="true">${d}</span>`)}
        ${DD.monthGrid(shown.y, shown.m).flat().map((d) => {
          const c = counts[d.key];
          const label = `${d.key}: ${c ? `${c.runs} run${c.runs === 1 ? "" : "s"}${c.failed ? `, ${c.failed} failed` : ""}` : "no runs"}`;
          const cls = ["cal-day", d.inMonth ? "" : "out", c ? "has" : "", c && c.failed ? "failed" : "", d.key === day ? "on" : "", d.key === today ? "today" : ""].join(" ");
          return html`<button key=${d.key} class=${cls} disabled=${!c} aria-pressed=${d.key === day} aria-label=${label} title=${label}
            style=${c ? { "--n": (0.25 + 0.75 * (c.runs / most)).toFixed(2), color: c.runs / most > 0.5 ? "var(--surface)" : "var(--ink)" } : null}
            onClick=${() => onDay(d.key === day ? "" : d.key)}>${d.day}</button>`;
        })}
      </div>
    </div>`;
}

const statusVar = (s) => ({ Completed: "ok", Running: "run", Recorded: "rec", Merged: "merge" }[s] || "bad");

// === Plan graph ============================================================

function hexMix(a, b, t) {
  const p = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.replace(/./g, "$&$&"); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  try {
    const x = p(a), y = p(b);
    if (x.some(isNaN) || y.some(isNaN)) return a;
    return "#" + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
  } catch { return a; }
}

function mermaidText(plan) {
  // Graph IDs are positions (g0, g1, …), never node IDs from the plan, so
  // nothing from the plan is parsed as mermaid syntax except quoted labels.
  const nodes = plan.nodes || [];
  const gid = new Map(nodes.map((n, i) => [n.id, `g${i}`]));
  const label = (n) => {
    const sk = DD.skillOf(n);
    if (sk) return [n.id, `${sk.name} @${sk.version.slice(0, 7)}`, ...sk.args.map((a) => JSON.stringify(a))].join(" ");
    return [n.id, n.activity, ...(n.args || []).map((a) => JSON.stringify(a))].join(" ");
  };
  const safe = (s) => s.replace(/[\\"<>&#;`{}[\]()|]/g, (c) => `#${c.charCodeAt(0)};`);
  const lines = ["graph LR"];
  for (const n of nodes) {
    lines.push(`  ${gid.get(n.id)}["${safe(label(n).slice(0, 80))}"]`);
    for (const r of n.requires || []) if (gid.has(r)) lines.push(`  ${gid.get(r)} --> ${gid.get(n.id)}`);
  }
  const surface = css("--surface"), ink = css("--ink");
  for (const k of Object.keys(KIND_LABEL)) {
    const c = kindColor(k);
    lines.push(`  classDef k_${k} fill:${hexMix(c, surface, 0.16)},stroke:${c},stroke-width:2px,color:${ink}`);
  }
  nodes.forEach((n, i) => lines.push(`  class g${i} k_${kindOf(n.activity)}`));
  return lines.join("\n");
}

let graphSeq = 0;

// wireGraph adds hover cards to a rendered plan graph, and, when onNode is
// given, makes nodes and edges open their steps. Mermaid names each node
// "…-g<i>-…" and each edge "L-g<i>-g<j>-…", after the graph IDs.
function wireGraph(root, plan, tip, describe, onNode) {
  const nodes = plan.nodes || [];
  for (const g of root.querySelectorAll("g.node")) {
    const m = /-g(\d+)-/.exec(g.id || "");
    const n = m && nodes[Number(m[1])];
    if (!n) continue;
    const show = () => tip.show(g, describe ? describe(n) : nodeCard(n), kindColor(kindOf(n.activity)));
    g.addEventListener("mouseenter", show);
    g.addEventListener("mouseleave", tip.hide);
    if (onNode) {
      g.style.cursor = "pointer";
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "link");
      g.setAttribute("aria-label", `Open step ${n.id}, ${n.activity}`);
      g.addEventListener("click", () => onNode(n));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter") onNode(n); });
      g.addEventListener("focus", show);
      g.addEventListener("blur", tip.hide);
    }
  }
  for (const e of root.querySelectorAll("path.flowchart-link, path[id^='L-']")) {
    const m = /L-g(\d+)-g(\d+)/.exec(e.id || "");
    const from = m && nodes[Number(m[1])], to = m && nodes[Number(m[2])];
    if (!from || !to) continue;
    e.style.strokeWidth = "2.5px";
    const card = html`<${Card} title=${html`<span class="mono">${from.id}</span> → <span class="mono">${to.id}</span>`}>
      <${Field} k="Means">${to.id} waits for ${from.id}, and is given its output<//>
      <${Field} k="Shared">only ${from.id}'s output, as text<//><//>`;
    e.addEventListener("mouseenter", () => tip.show(e, card, kindColor(kindOf(from.activity))));
    e.addEventListener("mouseleave", tip.hide);
    if (onNode) { e.style.cursor = "pointer"; e.addEventListener("click", () => onNode(to)); }
  }
}

// PlanGraph draws a plan small, with a button that opens it full screen
// to pan, zoom and follow its links.
function PlanGraph({ plan, describe, onNode }) {
  const ref = useRef(null);
  const expandRef = useRef(null);
  const [svg, setSvg] = useState(null);
  const [open, setOpen] = useState(false);
  const tip = useContext(TipContext);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  useEffect(() => {
    if (!plan || !ref.current) return;
    let live = true;
    mermaid.render(`plan-${++graphSeq}`, mermaidText(plan)).then(({ svg }) => {
      if (live && ref.current) ref.current.innerHTML = svg;
      if (!live || !ref.current) return;
      const el = ref.current.querySelector("svg");
      setSvg(el);
      wireGraph(ref.current, plan, tip, (n) => (describeRef.current ? describeRef.current(n) : nodeCard(n)), onNode);
    }).catch((e) => { if (live && ref.current) ref.current.textContent = String(e); });
    return () => { live = false; tip.hide(); };
  }, [JSON.stringify(plan)]);
  return html`
    <div class="graph-box">
      <div class="graph" ref=${ref}></div>
      ${svg && html`<button class="expand" type="button" ref=${expandRef} onClick=${() => setOpen(true)} aria-label="Expand the graph" title="Expand">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>`}
      ${open && svg && html`<${GraphViewer} source=${svg} plan=${plan} describe=${describeRef.current} onNode=${onNode}
        onClose=${() => { setOpen(false); setTimeout(() => expandRef.current && expandRef.current.focus(), 0); }} />`}
    </div>`;
}

// GraphViewer shows a copy of a rendered graph over the page: drag to pan,
// scroll or the buttons to zoom, Escape to close. The copy is made with
// cloneNode, so nothing is parsed as HTML.
function GraphViewer({ source, plan, describe, onNode, onClose }) {
  const stage = useRef(null);
  const tip = useContext(TipContext);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);
  const closeRef = useRef(null);
  const stageBox = useRef(null);
  useEffect(() => {
    const copy = source.cloneNode(true);
    copy.removeAttribute("style");
    copy.setAttribute("width", "100%");
    copy.setAttribute("height", "100%");
    stage.current.replaceChildren(copy);
    wireGraph(stage.current, plan, tip, describe, onNode && ((n) => { onClose(); onNode(n); }));
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc);
    // React's wheel listener is passive, so preventDefault there is ignored
    // and a trackpad pinch would zoom the whole page instead.
    const wheel = (e) => { e.preventDefault(); zoomRef.current(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY); };
    const box = stageBox.current;
    box.addEventListener("wheel", wheel, { passive: false });
    closeRef.current && closeRef.current.focus();
    return () => { removeEventListener("keydown", esc); box.removeEventListener("wheel", wheel); tip.hide(); };
  }, [source]);
  const zoom = (f, cx, cy) => setView((v) => {
    const k = Math.min(6, Math.max(0.3, v.k * f));
    const r = stage.current.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top;
    return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
  });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  return html`
    <div class="viewer" role="dialog" aria-modal="true" aria-label="Plan graph">
      <div class="viewer-bar">
        <strong>Plan</strong>
        <span class="muted">${(plan.nodes || []).length} steps. Drag to pan, scroll to zoom${onNode ? ", click a step to open it" : ""}.</span>
        <span class="spacer"></span>
        <button type="button" onClick=${() => zoom(1.25)} aria-label="Zoom in">+</button>
        <button type="button" onClick=${() => zoom(0.8)} aria-label="Zoom out">−</button>
        <button type="button" onClick=${() => setView({ x: 0, y: 0, k: 1 })}>Fit</button>
        <button type="button" ref=${closeRef} onClick=${onClose}>Close</button>
      </div>
      <div class="viewer-stage" ref=${stageBox}
        onPointerDown=${(e) => {
          // Steps and arrows are links: leave their clicks alone.
          if (e.target.closest("g.node, path[id^='L-']")) return;
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove=${(e) => { if (drag.current) setView((v) => ({ ...v, x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })); }}
        onPointerUp=${() => { drag.current = null; }}
        onPointerCancel=${() => { drag.current = null; }}
        onLostPointerCapture=${() => { drag.current = null; }}>
        <div class="viewer-canvas" ref=${stage} style=${{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}></div>
      </div>
    </div>`;
}

function nodeCard(n, step, output) {
  const kind = kindOf(n.activity);
  const sk = DD.skillOf(n);
  const args = sk ? sk.args : n.args || [];
  return html`<${Card} title=${html`<span class="mono">${n.id}</span> <${KindPill} kind=${kind}>${sk ? sk.name : n.activity}<//>${step && html` <${StatusPill} status=${step.status} />`}`}>
    ${sk && html`<${Field} k="Skill"><${SkillBadge} skill=${sk} /><//>`}
    <${Field} k="Arguments">${args.length ? html`<span class="mono">${args.map((a) => JSON.stringify(a)).join(" ")}</span>` : "none"}<//>
    <${Field} k="Waits for">${(n.requires || []).length ? html`<span class="mono">${n.requires.join(", ")}</span>` : "nothing: starts at once"}<//>
    ${step && html`
      <${Field} k="Attempts">${step.attempts > 1 ? html`<strong>${step.attempts}</strong> (Temporal retried it)` : step.attempts || ""}<//>
      <${Field} k="Queued">${took(step.scheduled, step.started)}<//>
      <${Field} k="Ran">${took(step.started, step.closed)}<//>
      <${Field} k="Started">${when(step.started)}<//>
      <${Field} k="Failure">${step.failure && html`<span class="mono">${step.failure.slice(0, 300)}</span>`}<//>`}
    ${output != null && html`<${Field} k="Output">${bytes(output)}<//>`}
  <//>
  ${output != null && html`<pre>${preview(output).slice(0, 400)}</pre>`}`;
}

// === Skills ================================================================

// SkillBadge names a skill at the version a plan pins, linking to it.
function SkillBadge({ skill }) {
  return html`<a href=${"#/skill/" + encodeURIComponent(skill.name) + "/" + encodeURIComponent(skill.version)}>
    <${Pill} cls="k-skill" mono>${skill.name} @${skill.version.slice(0, 7)}<//></a>`;
}

// AddSkill imports a skill from a link, or adds one pasted or uploaded.
// Each runs on a worker (loom's skills workflow); the page never writes.
// An import from a repository that isn't trusted waits for review.
function AddSkill({ onDone }) {
  const [mode, setMode] = useState("import");
  const [link, setLink] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const send = async (url, body) => {
    setBusy(true); setResult(null);
    const r = await api(url, body);
    setBusy(false);
    const sk = r.ok ? DD.asSkill(r.data.skill) : null;
    setResult(r.ok && sk ? { skill: sk } : { error: (r.data && r.data.error) || String(r.data) });
    if (r.ok) onDone();
  };
  const pick = async (e) => {
    setResult(null);
    const picked = await DD.readFolder(Array.from(e.target.files || []), (f) => new Promise((ok, bad) => {
      const rd = new FileReader();
      rd.onload = () => ok(String(rd.result).replace(/^data:[^,]*,/, ""));
      rd.onerror = () => bad(rd.error);
      rd.readAsDataURL(f);
    }));
    if (picked.error) { setFiles(null); setResult({ error: picked.error }); } else setFiles(picked);
  };
  const [describe, setDescribe] = useState("");
  const tab = (id, label) => html`<button role="tab" aria-selected=${mode === id} onClick=${() => { setMode(id); setResult(null); }}>${label}</button>`;
  return html`
    <div class="panel add-skill">
      <div class="tabs" role="tablist">${tab("import", "Import a link")}${tab("paste", "Paste a SKILL.md")}${tab("upload", "Upload a folder")}${tab("create", "Describe a skill")}</div>
      ${mode === "create" && html`
        <textarea aria-label="What the skill should do" value=${describe} onInput=${(e) => setDescribe(e.target.value)}
          placeholder="Sum the second column of a CSV file in the inputs, and report the total."></textarea>
        <div class="row"><button class="primary" disabled=${busy || !describe.trim()} onClick=${() => send("/api/skills/create", { description: describe })}>${busy ? "Claude is writing it… (a few minutes)" : "Create it"}</button>
          <span class="muted">Claude writes the skill and a test in a fresh container, runs the test, and the skill waits for your review.</span></div>`}
      ${mode === "import" && html`
        <div class="row">
          <label>GitHub link or repository URL<input type="text" value=${link} onInput=${(e) => setLink(e.target.value)}
            placeholder="github.com/anthropics/skills/tree/main/skills/pdf" /></label>
          <label style=${{ flex: "0 1 160px" }}>Folder, for a repository URL<input type="text" value=${path} onInput=${(e) => setPath(e.target.value)} /></label>
          <label style=${{ flex: "0 1 120px" }}>Branch or tag<input type="text" value=${branch} onInput=${(e) => setBranch(e.target.value)} /></label>
        </div>
        <div class="row"><button class="primary" disabled=${busy || !link.trim()} onClick=${() => send("/api/skills/import", { link, path, branch })}>${busy ? "Importing…" : "Import"}</button>
          <span class="muted">From a repository that isn't trusted, it waits for your review before any program can use it.</span></div>`}
      ${mode === "paste" && html`
        <textarea aria-label="SKILL.md" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${"---\nname: brief\ndescription: Writes a short brief.\n---\nKeep it under 200 words."}></textarea>
        <div class="row"><button class="primary" disabled=${busy || !text.trim()} onClick=${() => send("/api/skills/add", { files: { "SKILL.md": DD.base64(text) } })}>${busy ? "Adding…" : "Add"}</button>
          <span class="muted">You wrote it, so it needs no review.</span></div>`}
      ${mode === "upload" && html`
        <div class="row"><input type="file" webkitdirectory="" multiple onChange=${pick} aria-label="A skill's folder" /></div>
        ${files && html`<p class="muted">${files.count} files, ${DD.size(files.bytes)}${files.skipped ? `; ${files.skipped} hidden left out` : ""}.</p>`}
        <div class="row"><button class="primary" disabled=${busy || !files} onClick=${() => send("/api/skills/add", { files: files.files })}>${busy ? "Adding…" : "Add"}</button>
          <span class="muted">Up to ${DD.size(DD.MAX_UPLOAD)}; bigger folders with <code>loom skills -add</code>.</span></div>`}
      ${result && result.error && html`<p class="error">${result.error}</p>`}
      ${result && result.skill && html`<p>${result.skill.pending
        ? html`<a href=${"#/review/" + encodeURIComponent(result.skill.name)}>${result.skill.name}</a> is waiting for review.`
        : html`Added <a href=${"#/skill/" + encodeURIComponent(result.skill.name)}>${result.skill.name}</a> at <span class="mono">@${result.skill.version.slice(0, 7)}</span>; programs can use it now.`}</p>`}
    </div>`;
}

function SkillsPage() {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api("/api/skills").then(setData); }, [tick]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const skills = (data.data.skills || []).map(DD.asSkill).filter(Boolean);
  const pending = (data.data.pending || []).map(DD.asSkill).filter((s) => s && s.pending === true);
  const problems = (data.data.problems || []).filter((p) => typeof p === "string");
  return html`
    <h2>Skills</h2>
    <p class="lede">What steps can do by name: each skill is a folder whose SKILL.md tells Claude how. A program that uses one pins its exact version.</p>
    <${AddSkill} onDone=${() => setTick((t) => t + 1)} />
    ${skills.length === 0 && html`<div class="panel muted" style=${{ marginTop: "12px" }}>No skills yet. Import, paste or upload one above.</div>`}
    <div class="skills" style=${{ marginTop: "12px" }}>${skills.map((s) => html`
      <a key=${s.name} class="panel skill-card" href=${"#/skill/" + encodeURIComponent(s.name)}>
        <div class="pills"><${Pill} cls="k-skill">${s.name}<//><${Pill} cls="k-other" plain mono>@${s.version.slice(0, 7)}<//>
          ${s.source && html`<${Pill} cls="k-record" plain>imported<//>`}</div>
        <p>${s.description}</p>
        <p class="muted mono" style=${{ margin: 0 }}>(${s.name} …)</p>
      </a>`)}</div>
    ${pending.length > 0 && html`<h3>Waiting for review</h3>
      <p class="lede">Imported from repositories that aren't trusted. No program can use one until it's approved.</p>
      <div class="skills">${pending.map((s) => html`
        <a key=${s.name} class="panel skill-card" href=${"#/review/" + encodeURIComponent(s.name)}>
          <div class="pills"><${Pill} cls="k-skill">${s.name}<//><${Pill} cls="k-other" plain mono>@${s.version.slice(0, 7)}<//>
            <${Pill} cls="s-Scheduled" plain>waiting for review<//></div>
          <p>${s.description}</p>
          ${s.source && html`<p class="muted mono" style=${{ margin: 0 }}>from ${s.source.repo.replace(/^https:\/\//, "")}</p>`}
        </a>`)}</div>`}
    ${problems.length > 0 && html`<h3>Can't be used</h3><div class="panel">${problems.map((p, i) => html`<p key=${i} class="error mono">${p}</p>`)}</div>`}`;
}

function SkillPage({ name, version }) {
  const [versions, setVersions] = useState(null);
  const [detail, setDetail] = useState(null);
  useEffect(() => { setVersions(null); api(`/api/skills/${encodeURIComponent(name)}`).then(setVersions); }, [name]);
  const list = versions && versions.ok ? (versions.data.versions || []).map(DD.asSkill).filter(Boolean) : [];
  const shown = version || (list[0] && list[0].version);
  useEffect(() => {
    if (!shown) return;
    setDetail(null);
    api(`/api/skills/${encodeURIComponent(name)}/${encodeURIComponent(shown)}`).then(setDetail);
  }, [name, shown]);
  if (!versions) return html`<p class="muted">Loading…</p>`;
  if (!versions.ok) return html`<p class="error">${versions.data.error}</p>`;
  const cur = list.find((v) => v.version === shown);
  const link = cur && DD.sourceLink(cur.source);
  const files = detail && detail.ok ? (detail.data.files || []).filter((f) => f && typeof f.path === "string" && typeof f.size === "number") : [];
  return html`
    <p><a href="#/skills">← all skills</a></p>
    <div class="panel step-hero" style=${{ "--c": "var(--skill)" }}>
      <div class="pills"><${Pill} cls="k-skill" big>${name}<//>${cur && html`<${Pill} cls="k-other" plain mono>@${cur.version.slice(0, 12)}<//>`}
        ${cur && version && list[0] && list[0].version !== cur.version && html`<${Pill} cls="s-Failed" plain>not the newest<//>`}</div>
      ${cur && html`<p>${cur.description}</p>`}
      ${cur && cur.connectors && html`<p class="muted">Its steps may use <span class="mono">${cur.connectors}</span> (as far as the worker's connectors allow).</p>`}
      ${cur && cur.created && html`<p class="muted">Created by Claude from: “${cur.created}”</p>`}
      ${cur && cur.source && html`<p class="muted">Imported from <span class="mono">${cur.source.repo}${cur.source.path ? " " + cur.source.path : ""}</span>
        ${cur.source.commit && html` at <span class="mono">${cur.source.commit.slice(0, 12)}</span>`}${link && html` · <a href=${link} target="_blank" rel="noopener noreferrer">view the source ↗</a>`}</p>`}
    </div>
    <div class="skill-cols">
      <section>
        <h3>SKILL.md</h3>
        <div class="panel">${!detail ? html`<p class="muted">Loading…</p>` : !detail.ok ? html`<p class="error">${detail.data.error}</p>` : html`<pre class="skill-md">${DD.visible(detail.data.skillMD)}</pre>`}</div>
        <h3>Files</h3>
        <div class="panel">${files.map((f) => html`<div key=${f.path} class="pills"><code>${f.path}</code><span class="muted">${DD.size(f.size)}</span></div>`)}</div>
      </section>
      <section>
        <h3>Versions</h3>
        <p class="lede">Newest first. Runs keep the version they were compiled with.</p>
        <ol class="versions">${list.map((v, i) => html`
          <li key=${v.commit}><a href=${"#/skill/" + encodeURIComponent(name) + "/" + encodeURIComponent(v.version)}
            aria-current=${v.version === shown && list.findIndex((x) => x.version === shown) === i ? "true" : undefined}>
            <span class="mono">${v.version.slice(0, 12)}</span></a>
            ${v.source ? html` <span class="muted">from ${v.source.repo.replace(/^https:\/\//, "")}${v.source.commit ? " @" + v.source.commit.slice(0, 7) : ""}</span>` : v.created ? html` <span class="muted">created by Claude from a description</span>` : html` <span class="muted">added from a folder</span>`}</li>`)}</ol>
      </section>
    </div>`;
}

// Decide approves or rejects exactly the version a review shows (and, to
// approve, the version its diff is from), on a worker.
function Decide({ sk, replaces }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const decide = async (what) => {
    setBusy(what); setError("");
    const body = what === "approve" ? { version: sk.version, replaces } : { version: sk.version };
    const r = await api(`/api/skills/${encodeURIComponent(sk.name)}/${what}`, body);
    setBusy("");
    if (!r.ok) { setError((r.data && r.data.error) || String(r.data)); return; }
    location.hash = what === "approve" ? "#/skill/" + encodeURIComponent(sk.name) + "/" + encodeURIComponent(sk.version) : "#/skills";
  };
  return html`
    <div class="decide">
      <button class="primary" disabled=${!!busy} onClick=${() => decide("approve")}>${busy === "approve" ? "Approving…" : `Approve @${sk.version.slice(0, 7)}`}</button>
      <button class="reject" disabled=${!!busy} onClick=${() => decide("reject")}>${busy === "reject" ? "Rejecting…" : "Reject"}</button>
      <span class="muted">Approving lets programs use exactly what's shown here.</span>
    </div>
    ${error && html`<p class="error">${error}</p>`}`;
}

// ReviewPage is an import waiting for review: what it would add, file by
// file. Approving or rejecting is loom's; the page shows the commands,
// which name the exact version shown.
function ReviewPage({ name }) {
  const [data, setData] = useState(null);
  const ref = useRef(null);
  useEffect(() => { setData(null); api(`/api/skills/${encodeURIComponent(name)}/review`).then(setData); }, [name]);
  const d = data && data.ok ? data.data : null;
  const sk = d && DD.asSkill(d.skill);
  const cur = d && d.current !== undefined ? DD.asSkill(d.current) : null;
  const diff = d && typeof d.diff === "string" ? DD.visible(d.diff) : null;
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = "";
    if (diff && ref.current) ref.current.innerHTML = Diff2Html.html(diff, { drawFileList: true, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });
  }, [diff]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p><a href="#/skills">← all skills</a></p><p class="error">${data.data.error}</p>`;
  if (!sk || sk.pending !== true) return html`<p class="error">The review couldn't be read.</p>`;
  const link = DD.sourceLink(sk.source);
  const files = (d.files || []).filter((f) => f && typeof f.path === "string" && typeof f.size === "number");
  const at = `${sk.name}@${sk.version}`;
  const replaces = typeof d.replaces === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(d.replaces) ? d.replaces : "";
  const binary = (d.binary || []).filter((b) => typeof b === "string");
  return html`
    <p><a href="#/skills">← all skills</a></p>
    <div class="panel step-hero" style=${{ "--c": "var(--skill)" }}>
      <div class="pills"><${Pill} cls="k-skill" big>${sk.name}<//><${Pill} cls="k-other" plain mono>@${sk.version.slice(0, 12)}<//>
        <${Pill} cls="s-Scheduled" plain>waiting for review<//></div>
      <p>${sk.description}</p>
      ${sk.created && html`<p class="muted">Created by Claude from: “${sk.created}”. Read its files and its test before approving.</p>`}
      ${sk.connectors && html`<p class="error">It asks to use the connectors <span class="mono">${sk.connectors}</span>.</p>`}
      ${sk.source && html`<p class="muted">Imported from <span class="mono">${sk.source.repo}${sk.source.path ? " " + sk.source.path : ""}</span>
        ${sk.source.commit && html` at <span class="mono">${sk.source.commit.slice(0, 12)}</span>`}${link && html` · <a href=${link} target="_blank" rel="noopener noreferrer">view the source ↗</a>`}</p>`}
      <p>${replaces ? html`Replaces ${cur ? html`<a class="mono" href=${"#/skill/" + encodeURIComponent(cur.name) + "/" + encodeURIComponent(cur.version)}>@${replaces.slice(0, 12)}</a>` : html`<span class="mono">@${replaces.slice(0, 12)}</span>`}; the diff shows every change to a text file.`
        : "A new skill: the diff shows every text file."} No program can use it until it's approved.</p>
      ${binary.length > 0 && html`<p class="error">Not in the diff, because git takes them for binary: ${binary.map((b, i) => html`<code key=${i}>${b}</code> `)}. Read them yourself before approving.</p>`}
      <${Decide} sk=${sk} replaces=${replaces} />
      <p class="muted">Or at the terminal: <code>loom skills -store DIR -approve ${at}${replaces ? " -replacing " + replaces : ""}</code> or <code>-reject ${at}</code></p>
    </div>
    <h3>Changes</h3>
    ${diff === null && html`<div class="panel muted">The diff is too large to show here. Print it with <code>loom skills -store DIR -review ${sk.name}</code>.</div>`}
    <div class="panel" style=${{ display: diff ? "block" : "none" }}><div ref=${ref}></div></div>
    <div class="skill-cols">
      <section>
        <h3>SKILL.md</h3>
        <div class="panel"><pre class="skill-md">${typeof d.skillMD === "string" ? DD.visible(d.skillMD) : ""}</pre></div>
      </section>
      <section>
        <h3>Files</h3>
        <div class="panel">${files.map((f) => html`<div key=${f.path} class="pills"><code>${f.path}</code><span class="muted">${DD.size(f.size)}</span></div>`)}</div>
      </section>
    </div>`;
}

// === New run ===============================================================

const TEMPLATES = {
  echo: '(echo "hello")', source: '(source "weather")', assess: '(assess "the shipment will be late")',
  browse: '(browse "example.org")', ask: '(ask "Summarize the sources.")', agent: '(agent "Write out/summary.md from the inputs.")', container: '(container "IMAGE-ID" "arg")',
  image: '(image "FROM IMAGE@sha256:DIGEST\nCOPY in/n0.txt /n0.txt")',
};

// Describe has a worker's Claude write a program for a task, from the
// commands and skills the worker has. The program goes into the editor,
// where it compiles and shows its plan; nothing runs until Run.
function Describe({ program, onProgram }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const write = async () => {
    setBusy(true); setNote(null);
    const r = await api("/api/write", { description: text });
    setBusy(false);
    if (r.ok && typeof r.data.program === "string") {
      // Review 20: the program it replaces can be put back.
      const before = DD.replaced(program, r.data.program);
      onProgram(r.data.program);
      setNote({ ok: `Claude wrote this program${r.data.attempts > 1 ? ` (on try ${r.data.attempts})` : ""}. Check its plan below, then Run it.`, before });
    } else setNote({ error: (r.data && r.data.error) || String(r.data) });
  };
  return html`
    <div class="panel describe">
      <label for="describe">Describe a task, and Claude writes the program</label>
      <div class="row" style=${{ marginTop: "6px" }}>
        <input id="describe" type="text" value=${text} onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter" && text.trim() && !busy) write(); }}
          placeholder="Read the three shipment sources and tell me if the shipment will be late" style=${{ flex: 1 }} />
        <button class="primary" disabled=${busy || !text.trim()} onClick=${write}>${busy ? "Writing…" : "Write the program"}</button>
      </div>
      ${note && note.ok && html`<p class="muted" style=${{ margin: "8px 0 0" }}>${note.ok}
        ${note.before && html` <button class="link" onClick=${() => { onProgram(note.before); setNote(null); }}>Put back the program it replaced</button>`}</p>`}
      ${note && note.error && html`<p class="error" role="alert">${note.error}</p>`}
    </div>`;
}

function NewRun({ info, history: ref }) {
  const [program, setProgram] = useState(() => {
    try { return localStorage.getItem("drawdown.program") || ""; } catch { return ""; }
  });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const area = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("drawdown.program", program); } catch {}
    if (!program.trim()) { setResult(null); return; }
    const t = setTimeout(async () => setResult(await api("/api/compile", { program })), 250);
    return () => clearTimeout(t);
  }, [program]);

  const run = async () => {
    setBusy(true); setSubmitError("");
    const r = await api("/api/runs", { program, ref });
    setBusy(false);
    if (r.ok) go("run", r.data.workflowId, r.data.runId);
    else setSubmitError(r.data.error || String(r.data));
  };
  const insert = (text) => {
    const el = area.current;
    const at = el ? el.selectionStart : program.length;
    setProgram(program.slice(0, at) + text + program.slice(at));
  };

  const err = result && result.data && result.data.error ? result.data : null;
  const plan = result && result.ok && result.data.plan ? result.data.plan : null;
  const kinds = plan ? [...new Set((plan.nodes || []).map((n) => kindOf(n.activity)))] : [];
  return html`
    <${Describe} program=${program} onProgram=${setProgram} />
    <div class="panel">
      <textarea ref=${area} aria-label="program" spellcheck="false" value=${program}
        placeholder='(pipe (par (echo "a") (echo "b")) echo)'
        onInput=${(e) => setProgram(e.target.value)}></textarea>
      <div class="row">
        <button class="primary" disabled=${!plan || busy} onClick=${run}>${busy ? "Starting…" : "Run"}</button>
        ${Object.entries(info.examples || {}).map(([name, src]) => html`
          <button key=${name} onClick=${() => setProgram(src)}>Example: ${name}</button>`)}
      </div>
      <div class="row">
        <span class="muted">Insert a command:</span>
        ${(info.commands || []).map((c) => {
          const kind = KIND_OF_COMMAND[c] || "other";
          return html`<${Tip} tag="button" key=${c} class=${"pill k-" + kind} color=${kindColor(kind)}
            content=${html`<${Card} title=${html`<${KindPill} kind=${kind}>${c}<//>`}><${Field} k="Inserts"><span class="mono">${TEMPLATES[c] || `(${c})`}</span><//><//>`}
            onClick=${() => insert(TEMPLATES[c] || `(${c})`)}>${c}<//>`;
        })}
      </div>
      ${err && html`<p class="error" role="alert">${err.line ? `line ${err.line}, column ${err.col}: ` : ""}${err.error}</p>`}
      ${submitError && html`<p class="error" role="alert">${submitError}</p>`}
      ${plan && html`
        <div class="row">
          <${Pill} cls="s-Completed">compiles<//>
          <${Pill} cls="k-other" plain>${plan.nodes.length} step${plan.nodes.length === 1 ? "" : "s"}<//>
          ${kinds.map((k) => html`<${KindPill} key=${k} kind=${k} />`)}
        </div>
        <${PlanGraph} plan=${plan} />`}
    </div>`;
}

// === Runs list =============================================================

const q = (ref) => `?ref=${encodeURIComponent(ref)}`;

// useRuns polls a history's runs, only after each reply arrives, so slow
// replies never pile up.
function useRuns(ref) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true, timer;
    setData(null);
    const load = async () => {
      try { const r = await api("/api/runs" + q(ref)); if (live) setData(r.data); } catch {}
      if (live) timer = setTimeout(load, 2000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [ref]);
  return data;
}

function Runs({ data }) {
  if (!data) return html`<p class="muted">Loading…</p>`;
  const runs = data.runs || [];
  const longest = Math.max(1, ...runs.map((r) => ms(r.start, r.close) || 0));
  return html`
    ${data.temporalError && html`<p class="error">Temporal: ${data.temporalError}</p>`}
    ${runs.length === 0 ? html`<p class="muted">No runs yet.</p>` : html`
    <div class="panel" style=${{ padding: "4px 4px" }}>
    <table class="list">
      <thead><tr><th>Status</th><th>Program</th><th>Started</th><th>Took</th><th>Record</th></tr></thead>
      <tbody>${runs.map((r) => {
        const status = r.merged ? "Merged" : r.status;
        const open = () => (r.merged ? go("diff", r.parent, r.commit) : go("run", r.workflowId, r.runId));
        const d = ms(r.start, r.close);
        return html`
        <tr key=${r.runId || r.commit} class="click" tabIndex="0" onClick=${open} onKeyDown=${(e) => e.key === "Enter" && open()}>
          <td><${StatusPill} status=${r.status} /></td>
          <td>${r.merged
            ? html`<span>merged <span class="mono">${short(r.merged)}</span>${r.resolved ? `, ${r.resolved} conflict${r.resolved > 1 ? "s" : ""} resolved` : ""}</span>`
            : html`<${Program} text=${(r.program || r.workflowId).trim()} max=${180} />`}
            ${d != null && html`<div class=${"durbar s-" + status} style=${{ width: Math.max(1, (100 * d) / longest) + "%" }}></div>`}</td>
          <td><${Tip} content=${html`<${Card} title="Started"><${Field} k="At">${when(r.start)}<//><${Field} k="Closed">${when(r.close)}<//><//>`}>${ago(r.start)}<//></td>
          <td>${took(r.start, r.close)}</td>
          <td>${r.commit && html`<${Tip} focusable=${false} content=${html`<${Card} title="Record">
              <${Field} k="Commit"><span class="mono">${r.commit}</span><//>
              <${Field} k="Workflow"><span class="mono">${r.workflowId}</span><//>
              <${Field} k="Run"><span class="mono">${r.runId}</span><//>
              <${Field} k="History"><span class="mono">${r.ref || ""}</span><//><//>`} color=${css("--record")}><${Pill} cls="k-record" mono>${short(r.commit)}<//><//>`}</td>
        </tr>`;
      })}
      </tbody>
    </table></div>`}`;
}

// === Beliefs ===============================================================

function Beliefs({ history: ref }) {
  const data = usePoll("/api/beliefs" + q(ref), 4000, [ref]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.beliefs || data.beliefs.length === 0) return html`<p class="muted">No questions asked on this history yet.</p>`;
  return html`
    <div class="outputs">${data.beliefs.map((b) => html`
      <div class="out k-record" key=${b.question}>
        <div class="head">
          <${Tip} content=${html`<${Card} title="Question"><${Field} k="ID"><span class="mono">${b.question}</span><//><${Field} k="Answered by run"><span class="mono">${b.runId}</span><//><${Field} k="In record"><span class="mono">${b.commit}</span><//><//>`}
            color=${css("--record")}><${Pill} cls="k-record" mono>${b.question.slice(0, 12)}<//><//>
          <${Program} text=${b.program.trim()} max=${200} />
        </div>
        <div class="body">${(b.leaves || []).map((id) => html`<${Output} key=${id} text=${b.outputs[id] || ""} />`)}</div>
      </div>`)}
    </div>`;
}

// === Run detail ============================================================

function Timeline({ steps, plan, outputs, running, wf, run }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  if (!steps || steps.length === 0) return null;
  const nodeOf = new Map(((plan && plan.nodes) || []).map((n) => [n.id, n]));
  const t = (x) => (real(x) ? new Date(x).getTime() : null);
  const { t0, t1 } = DD.span(steps, now, running);
  const span = t1 - t0;
  const pct = (x) => (100 * (x - t0)) / span + "%";
  const width = (a, b) => Math.max(0.4, (100 * (b - a)) / span) + "%";
  return html`
    <div class="timeline">
      ${steps.map((s, i) => {
        const n = nodeOf.get(s.node) || { id: s.node, activity: s.activity, args: [], requires: [] };
        const kind = kindOf(s.activity);
        const card = nodeCard(n, s, outputs ? outputs[s.node] : null);
        const sched = t(s.scheduled) ?? t0, start = t(s.started), end = t(s.closed) ?? (running && s.status === "Running" ? now : start);
        return html`
          <div class="lane-label" key=${"l" + i}>${s.node === "record" ? html`<span class="mono">${s.node}</span>` : html`<a class="mono" href=${"#/step/" + [wf, run, s.node].map(encodeURIComponent).join("/")}>${s.node}</a>`}<${KindPill} kind=${kind} /></div>
          <${Tip} key=${"b" + i} class=${"lane k-" + kind} content=${card} color=${kindColor(kind)}
              aria-label=${`${s.node} ${s.activity}: ${s.status}, ran ${took(s.started, s.closed)}`}>
            ${start != null && start > sched && html`<span class="bar wait" style=${{ left: pct(sched), width: width(sched, start) }}></span>`}
            ${start != null && html`<span class=${"bar " + s.status} style=${{ left: pct(start), width: width(start, end) }}>
              ${s.attempts > 1 && html`<span class="retry">×${s.attempts}</span>`}</span>`}
          <//>`;
      })}
      <span></span>
      <div class="axis"><span>0</span><span>${dur(Math.round(span / 2))}</span><span>${dur(span)}</span></div>
    </div>
    <div class="legend"><span class="muted">Hatched: waiting for a worker. Solid: running. A badge counts attempts when Temporal retried.</span></div>`;
}

// Writes are a run's queued writes: from its record once it's done, or
// asked of the run while it runs, so a person can approve or decline the
// ones that wait. Deciding signals the run; the page never runs a write.
function Writes({ workflow, recorded, running }) {
  const [live, setLive] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!running) { setLive(null); return; }
    let on = true;
    const load = () => api(`/api/writes/${encodeURIComponent(workflow)}`).then((r) => { if (on && r.ok) setLive(r.data.writes); });
    load();
    const t = setInterval(load, 3000);
    return () => { on = false; clearInterval(t); };
  }, [workflow, running]);
  const ws = DD.asWrites(recorded || live || []);
  if (ws.length === 0) return null;
  const decide = async (w, approve) => {
    setBusy(w.node + "/" + w.id); setError("");
    const r = await api(`/api/writes/${encodeURIComponent(workflow)}`, { node: w.node, id: w.id, approve });
    setBusy("");
    if (r.ok) setLive(r.data.writes); else setError((r.data && r.data.error) || String(r.data));
  };
  return html`
    <h2>Writes</h2>
    <p class="lede">What the run's agents asked to change outside it. Each runs once, after the steps, and only once approved if it needs to be.</p>
    <div class="panel"><ol class="commands">${ws.map((w) => html`
      <li key=${w.node + w.id}>
        <div class="cmd-line"><${Pill} cls=${w.status === "done" ? "s-Completed" : ["failed", "refused", "declined", "expired"].includes(w.status) ? "s-Failed" : "s-Scheduled"}>${w.status}<//>
          <code>${w.connector}/${w.tool}</code><span class="muted mono">${w.node}/${w.id}</span>
          ${w.status === "waiting" && html`<span style=${{ marginLeft: "auto" }} class="pills">
            <button class="primary" disabled=${!!busy} onClick=${() => decide(w, true)}>Approve</button>
            <button class="reject" disabled=${!!busy} onClick=${() => decide(w, false)}>Decline</button></span>`}</div>
        <pre class="cmd-out">${DD.visible(w.inputText)}${w.output ? "\n→ " + DD.visible(w.output) : ""}${w.error ? "\n" + DD.visible(w.error) : ""}</pre>
      </li>`)}</ol>
      ${error && html`<p class="error">${error}</p>`}</div>`;
}

// Provenance is where a run's record sits in Git, in plain sight: the
// chain it extends (the same program's previous run, the record before
// it, then its own commit), each a click from its diff, and the Temporal
// workflow and run that produced it.
function Provenance({ rec, workflow, run, history, temporalLink }) {
  const link = (from, label) => from
    ? html`<button class="chain-link" onClick=${() => go("diff", from, rec.commit)} title=${`What changed from ${from} to ${rec.commit}`}>
        <${Pill} cls="k-other" mono>${short(from)}<//><span class="muted">${label}</span></button>`
    : html`<span class="chain-link none"><${Pill} cls="k-other" plain>none<//><span class="muted">${label}</span></span>`;
  return html`
    <h2>Provenance</h2>
    <p class="lede">Every run is a Git commit. Click an earlier record to see exactly what changed since.</p>
    <div class="panel">
      <div class="chain">
        ${link(rec.previous, "same program, last time")}
        <span class="chain-arrow" aria-hidden="true">→</span>
        ${link(rec.parent, "the record before it")}
        <span class="chain-arrow" aria-hidden="true">→</span>
        <span class="chain-link"><${Pill} cls="k-record" mono>${short(rec.commit)}<//><span class="muted">this run</span></span>
      </div>
      <div class="meta" style=${{ marginTop: "14px" }}>
        <span class="muted">Commit</span><span class="mono">${rec.commit}</span>
        <span class="muted">History</span><span class="mono">${history}</span>
        <span class="muted">Temporal</span><span><span class="mono">${workflow} / ${run}</span> · <a href=${temporalLink} target="_blank" rel="noopener">its event history ↗</a></span>
      </div>
    </div>`;
}

function RunDetail({ workflow, run, history: ref }) {
  const [data, setData] = useState(null);
  const [steps, setSteps] = useState(null);
  useEffect(() => {
    let live = true, timer, tick = 0;
    const load = async () => {
      // Steps read Temporal's whole history, so they're fetched every third
      // poll; the run's own status every poll.
      const fetchSteps = tick++ % 3 === 0;
      const [r, s] = await Promise.all([
        api(`/api/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}` + q(ref)),
        fetchSteps ? api(`/api/steps/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}`).catch(() => null) : null,
      ]);
      if (!live) return;
      setData(r);
      if (s) setSteps(s.data);
      // Keep polling only while the run is in progress, or finished but
      // not yet recorded. Failed, canceled and timed-out runs have no record.
      const st = r.ok && r.data.execution && r.data.execution.status;
      if (st === "Running" || (st === "Completed" && !r.data.record)) timer = setTimeout(load, 1000);
      else if (!fetchSteps) { tick = 0; timer = setTimeout(load, 0); } // the final steps, once
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [workflow, run, ref]);

  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const { execution: ex, record: rec, temporalUI, namespace } = data.data;
  const status = ex ? ex.status : "Recorded";
  const temporalLink = `${temporalUI}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/history`;
  const stepList = steps && steps.steps ? steps.steps : [];
  const stepOf = new Map(stepList.map((s) => [s.node, s]));
  const plan = rec ? rec.plan : null;
  const retried = stepList.filter((s) => s.attempts > 1).length;
  return html`
    <p><a href="#/">← all runs</a></p>
    <div class="panel">
      <div class="pills">
        <${StatusPill} status=${status} big />
        ${ex && real(ex.start) && html`<${Pill} cls="k-other" plain>started ${ago(ex.start)}<//>`}
        ${ex && took(ex.start, ex.close) && html`<${Pill} cls="k-other" plain>took ${took(ex.start, ex.close)}<//>`}
        ${stepList.length > 0 && html`<${Pill} cls="k-other" plain>${stepList.length} steps<//>`}
        ${retried > 0 && html`<${Pill} cls="s-Failed">${retried} retried<//>`}
        ${rec && html`<${Tip} content=${html`<${Card} title="Git record"><${Field} k="Commit"><span class="mono">${rec.commit}</span><//><${Field} k="Before it"><span class="mono">${rec.parent || "none"}</span><//><${Field} k="Same program before"><span class="mono">${rec.previous || "none"}</span><//><//>`}
          color=${css("--record")}><${Pill} cls="k-record" mono>${short(rec.commit)}<//><//>`}
        <a href=${temporalLink} target="_blank" rel="noopener" style=${{ marginLeft: "auto" }}>Open in Temporal Web UI ↗</a>
      </div>
      ${rec && html`<div style=${{ marginTop: "12px" }}><${Program} text=${rec.program} /></div>`}
      <div class="meta" style=${{ marginTop: "12px" }}>
        <span class="muted">Workflow</span><span class="mono">${workflow}</span>
        <span class="muted">Run</span><span class="mono">${run}</span>
        ${ex && html`<span class="muted">Started</span><span>${when(ex.start)}</span>`}
      </div>
    </div>
    ${rec && html`<${Provenance} rec=${rec} workflow=${workflow} run=${run} history=${(ex && ex.ref) || ref} temporalLink=${temporalLink} />`}
    ${data.data.temporalError && html`<p class="error">Temporal: ${data.data.temporalError}</p>`}
    ${status === "Running" && html`<${LiveView} workflow=${workflow} />`}
    <${Writes} workflow=${workflow} recorded=${rec && rec.writes} running=${status === "Running"} />
    <h2>Timeline</h2>
    <p class="lede">Each step as Temporal ran it. Hover a bar for its timings, attempts and output.</p>
    <div class="panel">
      ${stepList.length > 0 ? html`<${Timeline} steps=${stepList} plan=${plan} outputs=${rec && rec.outputs} running=${status === "Running"} wf=${workflow} run=${run} />`
        : html`<p class="muted">${steps && steps.temporalError ? `Temporal: ${steps.temporalError}` : "No steps yet."}</p>`}
    </div>
    ${!rec && html`<p class="muted">${status === "Running" ? "Running… the record appears when the run finishes."
      : status === "Completed" ? "Recording…" : "No record: only completed runs are recorded."}</p>`}
    ${rec && html`
      <h2>Plan</h2>
      <p class="lede">Arrows point from a step to the steps that wait for it. Click a step to open it; expand to explore.</p>
      <div class="panel"><${PlanGraph} plan=${rec.plan}
        describe=${(n) => nodeCard(n, stepOf.get(n.id), rec.outputs[n.id])}
        onNode=${(n) => go("step", workflow, run, n.id)} /></div>
      <h2>Outputs</h2>
      <div class="outputs">${Object.keys(rec.outputs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
        const n = (rec.plan.nodes || []).find((x) => x.id === k) || { id: k, activity: "", args: [] };
        const kind = kindOf(n.activity);
        const s = stepOf.get(k);
        return html`
          <div class=${"out k-" + kind} key=${k}>
            <div class="head">
              <a class="mono" href=${"#/step/" + [workflow, run, k].map(encodeURIComponent).join("/")}><strong>${k}</strong></a>
              <${KindPill} kind=${kind}>${n.activity}<//>
              ${DD.skillOf(n) ? html`<${SkillBadge} skill=${DD.skillOf(n)} /><span class="mono muted">${DD.skillOf(n).args.map((a) => JSON.stringify(a)).join(" ").slice(0, 120)}</span>`
                : (n.args || []).length > 0 && html`<span class="mono muted">${n.args.map((a) => JSON.stringify(a)).join(" ").slice(0, 120)}</span>`}
              <span style=${{ marginLeft: "auto" }} class="pills">
                ${s && took(s.started, s.closed) && html`<${Pill} cls="k-other" plain>${took(s.started, s.closed)}<//>`}
                ${s && s.attempts > 1 && html`<${Pill} cls="s-Failed">${s.attempts} attempts<//>`}
                <${Pill} cls="k-other" plain>${bytes(rec.outputs[k])}<//>
              </span>
            </div>
            <div class="body"><${Output} text=${rec.outputs[k]} /></div>
          </div>`;
      })}</div>
      <h2>Compare</h2>
      <div class="row">
        <button disabled=${!rec.previous} onClick=${() => go("diff", rec.previous, rec.commit)}>
          vs. previous run of this program</button>
        <button disabled=${!rec.parent} onClick=${() => go("diff", rec.parent, rec.commit)}>
          vs. the record before it</button>
      </div>`}`;
}

// === Step inspector ========================================================
// What one step was given, what it was cut off from, where it ran and what
// it decided. These are the guarantees of each kind of step, not guesses:
// bobbin, reed and pirn enforce them and test them.

const SANDBOX = {
  echo: { where: "Inside the loom worker's process; no container", fs: "None: it reads and writes no files", net: "None", gets: "Its arguments and its inputs: with both, the arguments, then \" | \", then the inputs joined with spaces", leaves: "Its text, as this step's output" },
  source: { where: "Inside the loom worker's process; no container", fs: "Reads one file, <name>.txt, from the worker's sources folder. Nothing else", net: "None", gets: "Its argument: the source's name", leaves: "The file's verdict line and text" },
  assess: { where: "Inside the loom worker's process; no container", fs: "None", net: "None", gets: "Its claim, and every input's verdict", leaves: "SUPPORTED or NOT SUPPORTED, naming the sources for and against" },
  container: { where: "A fresh Podman container from a content-pinned image, removed when the step ends", fs: "A brand-new, empty writable layer over the image. Deleted with the container: no other step ever sees it, and nothing is mounted from the machine", net: "None (--network=none)", gets: "Its inputs as JSON on standard input; its arguments; HEEDLE_NODE and HEEDLE_ATTEMPT in its environment, nothing else from the machine", leaves: "Standard output, bounded, as this step's output" },
  skill: { where: "A Claude agent step following a skill: a fresh Podman container (a bobbin session) for this step alone, from the worker's content-pinned agent image, removed when the step ends", fs: "A brand-new, empty writable layer over the image, holding the skill's folder at the version the plan pins in /work/skill and its inputs in /work/in. Deleted with the container: no other step ever sees it, and nothing is mounted from the machine", net: "None for its commands (--network=none). Only the worker talks to the Claude API", gets: "The skill's SKILL.md, its arguments, and its inputs as files in /work/in; no environment variables from the machine or the worker", leaves: "Claude's reply, every command it ran with its output, the files it left in /work/out, and the list of changed paths" },
  image: { where: "podman build on the worker, from base images pinned to content and already on it: nothing is pulled", fs: "A fresh build context holding only the Containerfile and in/<node>.txt for each input, removed afterwards. The built image stays in the worker's Podman storage", net: "None for RUN steps (--network=none). With \"push\", the worker pushes the image with its own login", gets: "Its Containerfile, and its inputs as files in in/", leaves: "The image ID, and where it was pushed if asked" },
  browse: { where: "A fresh Podman container running a fresh Chromium profile, removed when the step ends", fs: "A brand-new browser profile, deleted with the container. Nothing is mounted from the machine", net: "Chromium is set to reach only the hosts the program names, refusing and recording every other request. The container itself is on Podman's network, so this rests on Chromium's own settings", gets: "Its URL and allowed hosts, from the program", leaves: "What the browser saw: URL, title, text, screenshot, blocked requests" },
  agent: { where: "A fresh Podman container (a bobbin session) for this step alone, from the worker's content-pinned agent image, removed when the step ends; Claude, through Anthropic's SDK, decides each command", fs: "A brand-new, empty writable layer over the image, where its inputs are written to /work/in. Deleted with the container: no other step ever sees it, and nothing is mounted from the machine", net: "None for its commands (--network=none). Only the worker talks to the Claude API, and to the MCP servers the step is granted: remote ones through Anthropic's MCP connector, local ones each in its own container with no network", gets: "Its instruction, its inputs as files in /work/in, and the connector tools its arguments grant (as far as the worker allows); no environment variables from the machine or the worker", leaves: "Claude's reply, every command it ran with its output, every connector call it made and every write it queued (run once after the run's steps, never in the step), the files it left in /work/out, and the list of changed paths" },
  ask: { where: "One request to Claude through Anthropic's SDK; no container", fs: "None", net: "Only the Claude API, signed with the worker's key (never recorded)", gets: "Its instruction, and its inputs as cited sources", leaves: "Claude's answer, with the model, stop reason and token counts" },
  record: { where: "loom's worker, writing to the Git store outside every container", fs: "The warp store only", net: "None", gets: "Every step's output", leaves: "One commit" },
  other: { where: "The loom worker", fs: "Whatever this command's implementation allows", net: "Whatever this command's implementation allows", gets: "Its arguments and inputs", leaves: "Its output" },
};

const decisions = (kind, out) => DD.decisions(kind, out);

const ancestors = (plan, id) => DD.ancestors(plan, id);

function StepPage({ workflow, run, node, history: ref }) {
  const [data, setData] = useState(null);
  const [steps, setSteps] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api(`/api/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}` + q(ref)),
      api(`/api/steps/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}`).catch(() => null),
    ]).then(([r, st]) => { if (live) { setData(r); setSteps(st && st.data); } });
    return () => { live = false; };
  }, [workflow, run, node, ref]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const rec = data.data.record;
  if (!rec) return html`<p class="muted">This run has no record yet, so its steps' inputs and outputs aren't known. <a href=${"#/run/" + encodeURIComponent(workflow) + "/" + encodeURIComponent(run)}>Open the run</a></p>`;
  const plan = rec.plan, nodes = plan.nodes || [];
  const n = nodes.find((x) => x.id === node);
  if (!n) return html`<p class="error">No step ${node} in this run.</p>`;
  const kind = kindOf(n.activity), box = SANDBOX[kind] || SANDBOX.other;
  const step = ((steps && steps.steps) || []).find((x) => x.node === node);
  const inputs = n.requires || [];
  const upstream = ancestors(plan, node);
  const hidden = nodes.filter((x) => x.id !== node && !inputs.includes(x.id));
  const out = rec.outputs[node];
  const link = (id) => "#/step/" + [workflow, run, id].map(encodeURIComponent).join("/");
  const dec = decisions(kind, out);
  const agentOut = DD.parse(out).agent;
  return html`
    <p><a href=${"#/run/" + encodeURIComponent(workflow) + "/" + encodeURIComponent(run)}>← the whole run</a></p>
    <div class="panel step-hero" style=${{ "--c": kindColor(kind) }}>
      <div class="pills">
        <span class="mono step-id">${node}</span>
        <${KindPill} kind=${kind}>${n.activity}<//>
        ${step && html`<${StatusPill} status=${step.status} />`}
        ${step && step.attempts > 1 && html`<${Pill} cls="s-Failed">${step.attempts} attempts<//>`}
        ${step && took(step.started, step.closed) && html`<${Pill} cls="k-other" plain>ran ${took(step.started, step.closed)}<//>`}
        <${Pill} cls="k-record" mono>outputs/${node} in ${short(rec.commit)}<//>
      </div>
      ${DD.skillOf(n) ? html`<div class="pills" style=${{ marginTop: "10px" }}><span class="muted">follows</span><${SkillBadge} skill=${DD.skillOf(n)} />
          <span class="mono">${DD.skillOf(n).args.map((a) => JSON.stringify(a)).join(" ")}</span></div>`
        : (n.args || []).length > 0 && html`<div class="mono" style=${{ marginTop: "10px" }}>${n.args.map((a) => JSON.stringify(a)).join(" ")}</div>`}
    </div>

    <div class="flow">
      <section>
        <h3>Given</h3>
        <p class="lede">Shared with this step: only its parents' outputs, as text.</p>
        ${inputs.length === 0 ? html`<div class="panel muted">No inputs. It starts from its arguments alone.</div>`
          : inputs.map((id) => {
            const p = nodes.find((x) => x.id === id) || { activity: "" };
            const k = kindOf(p.activity);
            return html`<a class="flow-card" key=${id} href=${link(id)} style=${{ "--c": kindColor(k) }}>
              <div class="pills"><span class="mono"><strong>${id}</strong></span><${KindPill} kind=${k}>${p.activity}<//><${Pill} cls="k-other" plain>${bytes(rec.outputs[id])}<//></div>
              <pre>${preview(rec.outputs[id]).slice(0, 260)}</pre></a>`;
          })}
      </section>
      <section>
        <h3>Ran in</h3>
        <p class="lede">Where this step ran, and what it could touch.</p>
        <div class="panel sandbox" style=${{ "--c": kindColor(kind) }}>
          <dl>
            <dt>Where</dt><dd>${box.where}</dd>
            <dt>Files</dt><dd>${box.fs}</dd>
            <dt>Network</dt><dd>${box.net}</dd>
            <dt>Gets</dt><dd>${box.gets}</dd>
            <dt>Leaves</dt><dd>${box.leaves}</dd>
          </dl>
        </div>
        ${dec.length > 0 && html`
          <h3>Decided</h3>
          <div class="panel"><dl class="meta">${dec.map(([k, v]) => html`<dt key=${k} class="muted">${k}</dt><dd key=${k + "v"}>${v}</dd>`)}</dl></div>`}
        ${step && step.failure && html`
          <h3>Went wrong first</h3>
          <div class="panel"><pre class="error">${step.failure}</pre>
            <p class="muted" style=${{ margin: "8px 0 0" }}>${step.status === "Completed" ? `Temporal retried it; attempt ${step.attempts} succeeded.` : "This is the last attempt's failure."}</p></div>`}
      </section>
      <section>
        <h3>Produced</h3>
        <p class="lede">Recorded in Git, and passed on to the steps that wait for it.</p>
        <div class="out" style=${{ "--c": kindColor(kind) }}><div class="body">${out == null ? html`<span class="muted">No output recorded.</span>`
          : agentOut ? html`<${AgentWork} agent=${agentOut} part="summary" />` : html`<${Output} text=${out} />`}</div></div>
        <div class="pills" style=${{ marginTop: "10px" }}>
          <span class="muted">Passed to</span>
          ${nodes.filter((x) => (x.requires || []).includes(node)).map((x) => html`<a key=${x.id} href=${link(x.id)}><${KindPill} kind=${kindOf(x.activity)}>${x.id} ${x.activity}<//></a>`)}
          ${nodes.every((x) => !(x.requires || []).includes(node)) && html`<${Pill} cls="k-record">the run's result<//>`}
        </div>
      </section>
    </div>

    ${agentOut && html`
      <h3>Work</h3>
      <p class="lede">Every command Claude ran in the container, in order, then the files it kept and everything that changed.</p>
      <div class="panel"><${AgentWork} agent=${agentOut} part="work" /></div>`}

    ${DD.asFiles((rec.files || {})[node]).length > 0 && html`<${StepFiles} files=${DD.asFiles(rec.files[node])} node=${node}
      previous=${rec.previous} commit=${rec.commit} more=${rec.moreFiles} agent=${agentOut} />`}

    <h3>Not shared with this step</h3>
    <p class="lede">These steps' outputs were never given to it. What its parents passed on may still include parts of them${upstream.size > inputs.length ? ", from the steps marked as reaching it through its parents" : ""}. No step sees another's files.</p>
    <div class="pills">
      ${hidden.length === 0 ? html`<span class="muted">None: this run has no other steps.</span>` : hidden.map((x) => html`
        <a key=${x.id} href=${link(x.id)} class="hidden-step"><${Pill} cls=${"k-" + kindOf(x.activity)}>${x.id} ${x.activity}${upstream.has(x.id) ? " (only through its parents)" : ancestors(plan, x.id).has(node) ? " (runs after it)" : " (runs alongside)"}<//></a>`)}
    </div>`;
}

// RegistryFile is a file too big for the record, kept in an OCI registry:
// where it is, and the command that gets it back.
function RegistryFile({ f }) {
  return html`<div class="registry-file"><p class="muted">Too big for the record (${DD.size(f.size)}), so it's kept in the registry <code>${f.oci}</code>,
    under its SHA-256. The record holds a pointer. To get it back:</p>
    <pre>${DD.fetchCommand(f.oci, f.sha256, f.path.split("/").pop())}</pre></div>`;
}

// StepFiles lists the files a step left, as its record holds them
// (files/<node>/), compared with the previous run of the same program.
// A changed file opens to its diff (warp's DiffBlobs); an added text file
// opens to its contents, from the step's own output.
function StepFiles({ files, node, previous, commit, more, agent }) {
  const kept = new Map(((agent && agent.files) || []).map((f) => [f.path, f]));
  return html`
    <h3>Files</h3>
    <p class="lede">What this step left in its record, under <code>files/${node}/</code>, compared with ${previous
      ? html`the <a href=${"#/diff/" + encodeURIComponent(previous) + "/" + encodeURIComponent(commit)}>previous run of this program</a>` : "nothing: this is the program's first run"}.
      ${" " + DD.fileSummary(files)}${more ? ". Only the first files are listed." : "."}</p>
    <div class="panel files">${files.map((f) => html`<${FileRow} key=${f.path} f=${f} kept=${f.status === "deleted" ? null : kept.get(f.path)} />`)}</div>`;
}

function FileRow({ f, kept }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const [state, setState] = useState("");
  const oci = kept && kept.oci ? kept : null;
  const text = kept && kept.text != null ? kept.text : null;
  const canOpen = oci != null || f.status === "changed" || (f.status === "added" && text != null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = "";
    if (!open || f.status !== "changed" || oci) return;
    let live = true;
    setState("loading");
    api(`/api/blobdiff/${encodeURIComponent(f.before)}/${encodeURIComponent(f.blob)}`).then((r) => {
      if (!live) return;
      if (!r.ok) { setState(r.data.error || "error"); return; }
      ref.current.innerHTML = Diff2Html.html(r.data, { drawFileList: false, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });
      setState("ok");
    });
    return () => { live = false; };
  }, [open, f.status, f.before, f.blob, oci]);
  return html`
    <div class="file-row">
      <button class="file-head" disabled=${!canOpen} aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <${Pill} cls=${"f-" + f.status}>${f.status}<//>
        ${oci && html`<${Pill} cls="k-record">in the registry<//>`}
        <code>${f.path}</code>
        <span class="muted">${DD.size(oci ? oci.size : f.size)}${f.status === "deleted" ? " before" : ""}</span>
      </button>
      ${open && oci && html`<div class="file-body"><${RegistryFile} f=${oci} /></div>`}
      ${open && !oci && f.status === "added" && html`<pre class="file-body">${text}</pre>`}
      ${open && !oci && f.status === "changed" && html`<div class="file-body">
        ${state === "loading" && html`<p class="muted">Loading…</p>`}
        ${!["", "loading", "ok"].includes(state) && html`<p class="error">${state}</p>`}
        <div ref=${ref}></div></div>`}
    </div>`;
}

// === Diff ==================================================================

function Diff({ from, to }) {
  const ref = useRef(null);
  const [state, setState] = useState("loading");
  useEffect(() => {
    let live = true;
    api(`/api/diff/${encodeURIComponent(from)}/${encodeURIComponent(to)}`).then((r) => {
      if (!live) return;
      if (!r.ok) { setState(r.data.error || "error"); return; }
      if (!r.data.trim()) { setState("same"); return; }
      ref.current.innerHTML = Diff2Html.html(r.data, { drawFileList: true, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });
      setState("ok");
    });
    return () => { live = false; };
  }, [from, to]);
  return html`
    <p><a href="#/" onClick=${(e) => { e.preventDefault(); history.back(); }}>← back</a></p>
    <div class="pills"><span>Changes from</span><${Pill} cls="k-record" mono>${short(from)}<//><span>to</span><${Pill} cls="k-record" mono>${short(to)}<//></div>
    ${state === "loading" && html`<p class="muted">Loading…</p>`}
    ${state === "same" && html`<p class="muted">No differences: both runs recorded the same content.</p>`}
    ${!["loading", "same", "ok"].includes(state) && html`<p class="error">${state}</p>`}
    <div class="panel" style=${{ marginTop: "12px", display: state === "ok" ? "block" : "none" }}><div ref=${ref}></div></div>`;
}

// === App ===================================================================

// ErrorBoundary keeps one broken view from blanking the page: it says what
// failed and offers the way home.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.route !== this.props.route && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return html`<div class="panel" role="alert">
      <p><strong>This view couldn't be shown.</strong> ${String(this.state.error.message || this.state.error)}</p>
      <p><a href="#/">Back to all runs</a></p></div>`;
  }
}

function Home({ info, refs, heads, current }) {
  const runs = useRuns(current);
  const [day, setDay] = useState("");
  const shown = runs && day ? { ...runs, runs: DD.onDay(runs.runs, day) } : runs;
  const dayName = day && new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return html`
    <h2>Drawdown</h2>
    <p class="lede">Recent runs, woven: one column per run, one cell per step, coloured by the kind of step. Hover for details; click to open. Pick a day on the calendar to see only its runs.</p>
    ${day && html`<p class="filter-note">Showing runs started on ${dayName}. <button class="link" onClick=${() => setDay("")}>Show every day</button></p>`}
    <div class="panel"><${Weave} runs=${shown} all=${runs} day=${day} onDay=${setDay} /></div>
    <div class="cols">
      <div>
        <h2>Agents</h2>
        <p class="lede">Each opens in its own tab.</p>
        <div class="panel" style=${{ padding: "8px" }}><${AgentTree} refs=${refs.length ? refs : [info.ref]} heads=${heads} current=${current} /></div>
      </div>
      <div>
        <h2>New run</h2>
        <p class="lede">Write a program; it compiles as you type.</p>
        <${NewRun} info=${info} history=${current} />
      </div>
    </div>
    <h2>Beliefs</h2>
    <p class="lede">The latest answer to every question asked on this history.</p>
    <${Beliefs} history=${current} />
    <h2>Runs</h2>
    <${Runs} data=${shown} />`;
}

function App() {
  const route = useRoute();
  const [info, setInfo] = useState(null);
  const [refs, setRefs] = useState([]);
  const [heads, setHeads] = useState({});
  const [tip, setTip] = useState(null);
  const tipApi = useRef({
    show: (el, content, color) => setTip({ rect: el.getBoundingClientRect(), content, color }),
    hide: () => setTip(null),
  }).current;
  const [ref, setRefState] = useState(() => {
    try { return localStorage.getItem("drawdown.ref") || ""; } catch { return ""; }
  });
  const setRef = (r) => { setRefState(r); try { localStorage.setItem("drawdown.ref", r); } catch {} };
  useEffect(() => { api("/api/info").then((r) => setInfo(r.data)); }, []);
  useEffect(() => {
    let live = true, timer;
    const load = async () => {
      try { const r = await api("/api/refs"); if (live && r.ok) { setRefs(r.data.refs); setHeads(r.data.heads || {}); } } catch {}
      if (live) timer = setTimeout(load, 5000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  useEffect(() => { if (route[0] !== "agent") setTab("drawdown · agents", "#3b5bdb"); }, [route[0]]);
  useEffect(() => { setTip(null); }, [route.join("/")]);
  if (!info) return html`<main><p class="muted">Loading…</p></main>`;
  // A remembered ref that no longer exists falls back to the default.
  const current = refs.includes(ref) ? ref : info.ref;

  let body;
  if (route[0] === "agent" && route.length === 2) body = html`<${AgentPage} agent=${route[1]} refs=${refs} heads=${heads} info=${info} />`;
  else if (route[0] === "run" && route.length === 3) body = html`<${RunDetail} workflow=${route[1]} run=${route[2]} history=${current} />`;
  else if (route[0] === "step" && route.length === 4) body = html`<${StepPage} key=${route.join("/")} workflow=${route[1]} run=${route[2]} node=${route[3]} history=${current} />`;
  else if (route[0] === "diff" && route.length === 3) body = html`<${Diff} from=${route[1]} to=${route[2]} />`;
  else if (route[0] === "skills" && route.length === 1) body = html`<${SkillsPage} />`;
  else if (route[0] === "review" && route.length === 2) body = html`<${ReviewPage} key=${route[1]} name=${route[1]} />`;
  else if (route[0] === "skill" && (route.length === 2 || route.length === 3)) body = html`<${SkillPage} key=${route.join("/")} name=${route[1]} version=${route[2]} />`;
  else body = html`<${Home} info=${info} refs=${refs} heads=${heads} current=${current} />`;

  const dyes = ["source", "assess", "browse", "ask", "record", "container", "echo", "source"];
  return html`
    <${TipContext.Provider} value=${tipApi}>
    <header>
      <a class="brand" href="#/" aria-label="drawdown, home">
        <span class="swatch" aria-hidden="true">${dyes.map((k, i) => html`<i key=${i} style=${{ background: `var(--${k})` }}></i>`)}</span>
        <b>drawdown</b>
      </a>
      ${route[0] === "agent"
        ? html`<${Pill} cls="k-other" plain>agent <span class="mono">${agentName(route[1])}</span><//> <a href="#/">all agents</a>`
        : html`<label class="pills"><span class="muted">history</span>
            <select aria-label="history" value=${current} onChange=${(e) => setRef(e.target.value)}>
              ${(refs.length ? refs : [info.ref]).map((r) => html`<option key=${r} value=${r}>${agentName(r)}</option>`)}
            </select></label>`}
      <span class="spacer"></span>
      <a href="#/skills">skills</a>
      <${Pill} cls="k-other" plain>${(info.commands || []).length} commands<//>
      <a href=${info.temporalUI} target="_blank" rel="noopener">Temporal Web UI ↗</a>
    </header>
    <main><${ErrorBoundary} route=${route.join("/")}>${body}<//></main>
    <${TipLayer} tip=${tip} />
    <//>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
