// drawdown: React (UMD) with htm for JSX-style markup, mermaid for plan
// graphs, diff2html for diffs. No build step.
const { useState, useEffect, useRef, useCallback } = React;
const html = htm.bind(React.createElement);

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
});

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const ct = res.headers.get("Content-Type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

// === Routing: #/, #/run/<workflow>/<run>, #/diff/<from>/<to> ==============

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.slice(2).split("/").map(decodeURIComponent);
}

const go = (...parts) => { location.hash = "#/" + parts.map(encodeURIComponent).join("/"); };
const short = (id) => (id ? id.slice(0, 7) : "");
const when = (t) => (t && !t.startsWith("0001") ? new Date(t).toLocaleString() : "");
const took = (a, b) => {
  if (!a || !b || a.startsWith("0001") || b.startsWith("0001")) return "";
  const ms = new Date(b) - new Date(a);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

// === Plan graph ============================================================

function mermaidText(plan) {
  // Graph IDs are positions (g0, g1, …), never node IDs from the plan, so
  // nothing from the plan is parsed as mermaid syntax except quoted labels.
  const nodes = plan.nodes || [];
  const gid = new Map(nodes.map((n, i) => [n.id, `g${i}`]));
  const label = (n) => [n.id, n.activity, ...(n.args || []).map((a) => JSON.stringify(a))].join(" ");
  const safe = (s) => s.replace(/[\\"<>&#;`{}[\]()|]/g, (c) => `#${c.charCodeAt(0)};`);
  const lines = ["graph LR"];
  for (const n of nodes) {
    lines.push(`  ${gid.get(n.id)}["${safe(label(n))}"]`);
    for (const r of n.requires || []) if (gid.has(r)) lines.push(`  ${gid.get(r)} --> ${gid.get(n.id)}`);
  }
  return lines.join("\n");
}

let graphSeq = 0;
function PlanGraph({ plan }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!plan || !ref.current) return;
    let live = true;
    mermaid.render(`plan-${++graphSeq}`, mermaidText(plan)).then(({ svg }) => {
      if (live && ref.current) ref.current.innerHTML = svg;
    }).catch((e) => { if (live && ref.current) ref.current.textContent = String(e); });
    return () => { live = false; };
  }, [JSON.stringify(plan)]);
  return html`<div class="graph" ref=${ref}></div>`;
}

// === New run ===============================================================

function NewRun({ info, history: ref }) {
  const [program, setProgram] = useState(() => {
    try { return localStorage.getItem("drawdown.program") || ""; } catch { return ""; }
  });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");

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

  const err = result && result.data && result.data.error ? result.data : null;
  const plan = result && result.ok && result.data.plan ? result.data.plan : null;
  return html`
    <div class="card">
      <textarea aria-label="program" spellcheck="false" value=${program}
        placeholder='(pipe (par (echo "a") (echo "b")) echo)'
        onInput=${(e) => setProgram(e.target.value)}></textarea>
      <div class="row">
        <button class="primary" disabled=${!plan || busy} onClick=${run}>${busy ? "Submitting…" : "Run"}</button>
        ${Object.entries(info.examples || {}).map(([name, src]) => html`
          <button key=${name} onClick=${() => setProgram(src)}>Example: ${name}</button>`)}
        <span class="muted">Commands: ${(info.commands || []).join(", ")}</span>
      </div>
      ${err && html`<p class="error" role="alert">${err.line ? `line ${err.line}, column ${err.col}: ` : ""}${err.error}</p>`}
      ${submitError && html`<p class="error" role="alert">${submitError}</p>`}
      ${plan && html`<${PlanGraph} plan=${plan} />`}
    </div>`;
}

// === Runs list =============================================================

const q = (ref) => `?ref=${encodeURIComponent(ref)}`;

function Runs({ history: ref }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    // Poll only after each reply arrives, so slow replies never pile up.
    let live = true, timer;
    setData(null);
    const load = async () => {
      try { const r = await api("/api/runs" + q(ref)); if (live) setData(r.data); } catch {}
      if (live) timer = setTimeout(load, 2000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [ref]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  return html`
    ${data.temporalError && html`<p class="error">Temporal: ${data.temporalError}</p>`}
    ${data.runs.length === 0 ? html`<p class="muted">No runs yet.</p>` : html`
    <table class="list">
      <thead><tr><th>Status</th><th>Program</th><th>Started</th><th>Took</th><th>Record</th></tr></thead>
      <tbody>${(data.runs || []).map((r) => html`
        <tr key=${r.runId} class="click" onClick=${() => r.merged ? go("diff", r.parent, r.commit) : go("run", r.workflowId, r.runId)}>
          <td><span class=${"status " + r.status}>${r.status}</span></td>
          <td>${r.merged
            ? html`<span>merged <span class="mono">${short(r.merged)}</span>${r.resolved ? ` · ${r.resolved} conflict${r.resolved > 1 ? "s" : ""} resolved` : ""}</span>`
            : html`<pre>${(r.program || r.workflowId).trim().slice(0, 160)}</pre>`}</td>
          <td>${when(r.start)}</td>
          <td>${took(r.start, r.close)}</td>
          <td class="mono">${short(r.commit)}</td>
        </tr>`)}
      </tbody>
    </table>`}`;
}

// === Beliefs ===============================================================

function Beliefs({ history: ref }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true, timer;
    setData(null);
    const load = async () => {
      try { const r = await api("/api/beliefs" + q(ref)); if (live) setData(r.data); } catch {}
      if (live) timer = setTimeout(load, 4000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [ref]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.beliefs || data.beliefs.length === 0) return html`<p class="muted">No questions asked on this history yet.</p>`;
  return html`
    <table class="list">
      <thead><tr><th>Question</th><th>Latest answer</th></tr></thead>
      <tbody>${data.beliefs.map((b) => html`
        <tr key=${b.question}>
          <td><pre>${b.program.trim().slice(0, 200)}</pre></td>
          <td><pre>${(b.leaves || []).map((id) => b.outputs[id] || "").join("\n").trim()}</pre></td>
        </tr>`)}
      </tbody>
    </table>`;
}

// === Run detail ============================================================

function RunDetail({ workflow, run, history: ref }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true, timer;
    const load = async () => {
      const r = await api(`/api/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}` + q(ref));
      if (!live) return;
      setData(r);
      // Keep polling only while the run is in progress, or finished but
      // not yet recorded. Failed, canceled and timed-out runs have no record.
      const s = r.ok && r.data.execution && r.data.execution.status;
      if (s === "Running" || (s === "Completed" && !r.data.record)) timer = setTimeout(load, 1000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [workflow, run, ref]);

  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const { execution: ex, record: rec, temporalUI, namespace } = data.data;
  const status = ex ? ex.status : "Recorded";
  const temporalLink = `${temporalUI}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflow)}/${encodeURIComponent(run)}/history`;
  return html`
    <p><a href="#/">← all runs</a></p>
    <div class="card grid">
      <span class="muted">Status</span><span class=${"status " + status}>${status}</span>
      <span class="muted">Workflow</span><span class="mono">${workflow}</span>
      <span class="muted">Run</span><span class="mono">${run}</span>
      ${ex && html`<span class="muted">Started</span><span>${when(ex.start)} ${took(ex.start, ex.close) && `(took ${took(ex.start, ex.close)})`}</span>`}
      <span class="muted">Temporal</span><a href=${temporalLink} target="_blank" rel="noopener">Open in Temporal Web UI ↗</a>
      ${rec && html`<span class="muted">Record</span><span class="mono">${rec.commit}</span>`}
    </div>
    ${data.data.temporalError && html`<p class="error">Temporal: ${data.data.temporalError}</p>`}
    ${!rec && html`<p class="muted">${status === "Running" ? "Running… the record appears when the run finishes."
      : status === "Completed" ? "Recording…" : "No record: only completed runs are recorded."}</p>`}
    ${rec && html`
      <h2>Program</h2>
      <div class="card"><pre>${rec.program}</pre></div>
      <h2>Plan</h2>
      <div class="card"><${PlanGraph} plan=${rec.plan} /></div>
      <h2>Outputs</h2>
      <table class="list">
        <thead><tr><th>Node</th><th>Output</th></tr></thead>
        <tbody>${Object.keys(rec.outputs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => html`
          <tr key=${k}><td class="mono">${k}</td><td><pre>${rec.outputs[k]}</pre></td></tr>`)}
        </tbody>
      </table>
      <h2>Compare</h2>
      <div class="row">
        <button disabled=${!rec.previous} onClick=${() => go("diff", rec.previous, rec.commit)}>
          vs. previous run of this program</button>
        <button disabled=${!rec.parent} onClick=${() => go("diff", rec.parent, rec.commit)}>
          vs. the record before it</button>
      </div>`}`;
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
      ref.current.innerHTML = Diff2Html.html(r.data, { drawFileList: true, matching: "lines", outputFormat: "line-by-line" });
      setState("ok");
    });
    return () => { live = false; };
  }, [from, to]);
  return html`
    <p><a href="#/" onClick=${(e) => { e.preventDefault(); history.back(); }}>← back</a></p>
    <p class="muted">Changes from <span class="mono">${short(from)}</span> to <span class="mono">${short(to)}</span></p>
    ${state === "loading" && html`<p class="muted">Loading…</p>`}
    ${state === "same" && html`<p class="muted">No differences: both runs recorded the same content.</p>`}
    ${!["loading", "same", "ok"].includes(state) && html`<p class="error">${state}</p>`}
    <div ref=${ref}></div>`;
}

// === App ===================================================================

function App() {
  const route = useRoute();
  const [info, setInfo] = useState(null);
  const [refs, setRefs] = useState([]);
  const [ref, setRefState] = useState(() => {
    try { return localStorage.getItem("drawdown.ref") || ""; } catch { return ""; }
  });
  const setRef = (r) => { setRefState(r); try { localStorage.setItem("drawdown.ref", r); } catch {} };
  useEffect(() => { api("/api/info").then((r) => setInfo(r.data)); }, []);
  useEffect(() => {
    let live = true, timer;
    const load = async () => {
      try { const r = await api("/api/refs"); if (live && r.ok) setRefs(r.data.refs); } catch {}
      if (live) timer = setTimeout(load, 5000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  if (!info) return html`<main><p class="muted">Loading…</p></main>`;
  // A remembered ref that no longer exists falls back to the default.
  const current = refs.includes(ref) ? ref : info.ref;

  let body;
  if (route[0] === "run" && route.length === 3) body = html`<${RunDetail} workflow=${route[1]} run=${route[2]} history=${current} />`;
  else if (route[0] === "diff" && route.length === 3) body = html`<${Diff} from=${route[1]} to=${route[2]} />`;
  else body = html`<h2>New run</h2><${NewRun} info=${info} history=${current} />
    <h2>Beliefs</h2><${Beliefs} history=${current} />
    <h2>Runs</h2><${Runs} history=${current} />`;

  return html`
    <header>
      <h1><a href="#/">drawdown</a></h1>
      <span class="meta">heedle-ai · history${" "}
        <select aria-label="history" value=${current} onChange=${(e) => setRef(e.target.value)}>
          ${(refs.length ? refs : [info.ref]).map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
        </select> ·${" "}
        <a href=${info.temporalUI} target="_blank" rel="noopener">Temporal Web UI ↗</a></span>
    </header>
    <main>${body}</main>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
