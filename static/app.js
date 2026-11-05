// drawdown: React (UMD) with htm for JSX-style markup, diff2html for
// diffs. No build step.
const { useState, useEffect, useRef, useLayoutEffect, useContext, createContext, useMemo } = React;
const html = htm.bind(React.createElement);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const api = (path, body) => DD.request(fetch, path, body);

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

const KIND_OF_ACTIVITY = { Echo: "echo", Source: "source", Assess: "assess", Browse: "browse", Ask: "ask", Agent: "agent", Container: "container", Image: "image", Skill: "skill", LoomRecord: "record", Act: "act" };
const KIND_OF_COMMAND = { echo: "echo", source: "source", assess: "assess", browse: "browse", ask: "ask", agent: "agent", container: "container", image: "image", act: "act" };
const KIND_LABEL = { echo: "echo", source: "source", assess: "assess", browse: "browse", ask: "ask Claude", agent: "Claude agent", container: "container", image: "image build", act: "Claude fills a form", skill: "skill", record: "Git record", other: "step" };
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

// === Programs, highlighted (roadmap 9.4) ===================================
// A program reads as draft reads it (DD.program): each bracket in its
// depth's colour, pipe and par as structure, commands in their step's dye,
// skills in the skill dye and linked to their pages, comments muted. The
// viewer and the editor colour from the same tokens.

// CommandsContext is what the page knows of the worker's commands: which
// are skills (with their descriptions) and what each built-in does.
const CommandsContext = createContext({ skills: new Map(), about: {} });

// BROWSE_GRANT explains an agent step granted "browse": a connector of that
// name, not the browse command.
const BROWSE_GRANT = "Grants the connector named browse: the agent works a browser through that connector's tools. It is not the browse command, which opens pages itself; without a connector of that name, the step can't run.";

// tokenClass is the classes a token is coloured by (DD.tokenClass).
const tokenClass = (t, cmds) => DD.tokenClass(t, KIND_OF_COMMAND, cmds.skills, cmds.about);

// hotRange is the brackets a hot bracket pairs (lo, hi) and the depth
// colour to tint the form between them with.
function hotRange(toks, hot) {
  if (hot < 0 || !toks[hot] || toks[hot].kind !== "paren") return null;
  const t = toks[hot], o = t.partner < 0 ? hot : t.partner;
  const lo = Math.min(hot, o), hi = Math.max(hot, o);
  return { lo, hi, color: `var(--d${toks[lo].depth % 4})` };
}

// ownAbout is what a built-in command does, if the worker said (never an
// Object member such as toString: review 38).
const ownAbout = (cmds, name) => (Object.prototype.hasOwnProperty.call(cmds.about, name) ? cmds.about[name] : "");

// ProgramLine is one line of a shown program. It re-renders only when
// what it shows changes: its pieces, the folds, or the hot form's ends as
// far as they touch it (lo and hi are -1 for a line the form misses), so
// pointing at a bracket redraws only the lines of its form (review 38).
const ProgramLine = React.memo(function ProgramLine({ line, toks, cmds, open, toggle, lo, hi }) {
  const word = (t, p, k, cls) => {
    // A skill's name is a link wherever it is, inside the form a bracket
    // points at too ("sk in"; found making the video: it lost its link).
    if (cls.split(" ")[0] === "sk") {
      const about = cmds.skills.get(t.text);
      return html`<${Tip} tag="a" key=${k} class="sk" href=${"#/skill/" + encodeURIComponent(t.text)}
        content=${html`<${Card} title=${html`<${KindPill} kind="skill">${t.text}<//>`}><${Field} k="Skill">${about || "A skill you added."}<//><//>`}>${p.text}<//>`;
    }
    const about = cls.startsWith("cmd") ? ownAbout(cmds, t.text) : "";
    if (about) {
      const kind = cls.slice("cmd k-".length);
      return html`<${Tip} key=${k} class=${cls} focusable=${false} color=${kindColor(kind)}
        content=${html`<${Card} title=${html`<${KindPill} kind=${kind}>${t.text}<//>`}><${Field} k="Does">${about}<//><//>`}>${p.text}<//>`;
    }
    return html`<span key=${k} class=${cls}>${p.text}</span>`;
  };
  const str = (t, p, k, cls) => {
    const g = DD.grantOf(t);
    if (g && g.connector === "browse" && !g.tool) {
      return html`<${Tip} key=${k} class=${cls + " why"} content=${html`<${Card} title="A grant"><${Field} k="browse">${BROWSE_GRANT}<//><//>`}>${p.text}<//>`;
    }
    if (g) {
      const what = g.tool ? `Grants the tool ${g.tool} of the connector ${g.connector}.` : `Grants the connector ${g.connector}, all its tools.`;
      return html`<${Tip} tag="a" key=${k} class=${cls + " grant"} href="#/connectors"
        content=${html`<${Card} title="A grant"><${Field} k=${g.connector}>${what} See your connectors.<//><//>`}>${p.text}<//>`;
    }
    // Links: only a URL wholly in this piece, placed by where the piece
    // starts in its string (p.off, from DD.lines).
    let at = 0;
    const full = DD.links(t.text).map((x) => { const y = { ...x, start: at }; at += x.text.length; return y; });
    const from = p.off, to = p.off + p.text.length;
    const out = [];
    let pos = from;
    for (const x of full) {
      if (!x.url || x.start < from || x.start + x.text.length > to) continue;
      if (x.start > pos) out.push(p.text.slice(pos - from, x.start - from));
      out.push(html`<a key=${x.start} class="url" href=${x.url} target="_blank" rel="noopener noreferrer">${x.text}</a>`);
      pos = x.start + x.text.length;
    }
    out.push(p.text.slice(pos - from));
    return html`<span key=${k} class=${cls}>${out}</span>`;
  };
  const piece = (p, k) => {
    if (p.i < 0) return html`<span key=${k} class="muted">${p.text}</span>`;
    const t = toks[p.i];
    if (p.toggle) {
      const on = open.has(p.i);
      return html`<span key=${k}>${p.text}<button class="more" aria-expanded=${on} onClick=${() => toggle(p.i)}>${on ? "less" : "more"}</button></span>`;
    }
    let cls = tokenClass(t, cmds);
    if (p.i === lo || p.i === hi) cls += " hot";
    else if (lo >= 0 && p.i > lo && p.i < hi) cls += " in";
    cls = cls.trim();
    if (t.kind === "paren") return html`<span key=${k} class=${cls} data-i=${p.i} title=${t.partner < 0 ? "This bracket has no partner" : undefined}>${p.text}</span>`;
    if (t.kind === "word") return word(t, p, k, cls);
    if (t.kind === "str") return str(t, p, k, cls);
    if (t.kind === "bad") return html`<span key=${k} class=${cls} title=${BAD_STRING}>${p.text}</span>`;
    return html`<span key=${k} class=${cls || undefined}>${p.text}</span>`;
  };
  return html`<span class="ln" style=${{ "--hang": line.indent + 2 + "ch" }}>${line.pieces.map(piece)}</span>`;
});

// BAD_STRING says why a string is marked: draft can't read it.
const BAD_STRING = 'draft can\'t read this string: it isn\'t closed, or has an escape other than \\n \\t \\r \\" \\\\';

function Program({ text, max }) {
  const cmds = useContext(CommandsContext);
  const toks = useMemo(() => DD.program(text), [text]);
  const [hot, setHot] = useState(-1);
  const [open, setOpen] = useState(() => new Set());
  const [copied, setCopied] = useState("");
  const parens = useMemo(() => toks.map((t, i) => (t.kind === "paren" ? i : -1)).filter((i) => i >= 0), [toks]);
  const toggle = useRef((i) => setOpen((o) => { const n = new Set(o); n.has(i) ? n.delete(i) : n.add(i); return n; })).current;
  const range = hotRange(toks, hot);

  // What shows: each token, a long string folded to its start unless
  // opened, all of it cut at max characters for a list's preview; then
  // its lines, each with the first and last token it shows.
  const lns = useMemo(() => {
    const pieces = [];
    let budget = max || Infinity;
    for (let i = 0; i < toks.length && budget > 0; i++) {
      const t = toks[i];
      const long = (t.kind === "str" || t.kind === "bad") && t.text.length > DD.FOLD_AT && !max;
      let shown = long && !open.has(i) ? t.text.slice(0, DD.FOLD_SHOW) + "…" : t.text;
      if (shown.length > budget) shown = shown.slice(0, budget);
      budget -= shown.length;
      pieces.push({ text: shown, i, off: 0 });
      if (long) pieces.push({ text: "⁠", i, toggle: true });
    }
    if (budget <= 0 && pieces.reduce((n, p) => n + (p.toggle ? 0 : p.text.length), 0) < text.length) pieces.push({ text: " …", i: -1 });
    return DD.lines(pieces).map((l) => {
      const is = l.pieces.map((p) => p.i).filter((i) => i >= 0);
      return { ...l, first: is.length ? Math.min(...is) : -1, last: is.length ? Math.max(...is) : -1 };
    });
  }, [toks, open, max, text]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied("Copied"); }
    catch { setCopied("Couldn't copy"); }
    setTimeout(() => setCopied(""), 1600);
  };
  const keys = (e) => {
    if (!parens.length) return;
    const at = parens.indexOf(hot);
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: parens.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setHot(parens[Math.max(0, Math.min(parens.length - 1, to))]);
  };
  const over = (e) => {
    const el = e.target.closest && e.target.closest("[data-i]");
    if (el && +el.dataset.i !== hot) setHot(+el.dataset.i);
  };
  const lines = lns.map((l, n) => {
    const touched = range && l.first >= 0 && range.lo <= l.last && range.hi >= l.first;
    return html`<${ProgramLine} key=${n} line=${l} toks=${toks} cmds=${cmds} open=${open} toggle=${toggle}
      lo=${touched ? range.lo : -1} hi=${touched ? range.hi : -1} />`;
  });
  return html`<div class="prog-box">${!max && html`<button class="prog-copy" onClick=${copy}>${copied || "Copy"}</button>`}<pre class="prog"
    style=${range ? { "--hc": range.color } : undefined}
    tabIndex=${parens.length && !max ? 0 : undefined} aria-label=${parens.length && !max ? "Program: the arrow keys move from bracket to bracket" : undefined}
    onKeyDown=${keys} onFocus=${(e) => { if (e.target === e.currentTarget && hot < 0 && parens.length) setHot(parens[0]); }}
    onBlur=${(e) => { if (e.target === e.currentTarget) setHot(-1); }}
    onMouseOver=${over} onMouseLeave=${() => setHot(-1)}>${lines}</pre></div>`;
}

// ProgramEditor is the program's editor: CodeMirror 5, coloured from
// DD.program as the viewer is, with the bracket at the cursor and its
// partner lit. It keeps the text exactly as typed (its line separator is
// "\n" alone, so a "\r" stays). Tab indents; Esc, then Tab, leaves it.
// handle gets insert(text) and the editor's element. Without CodeMirror
// (it didn't load), it is a plain text field.
function ProgramEditor({ value, onChange, handle, placeholder }) {
  const cmds = useContext(CommandsContext);
  const box = useRef(null);
  const area = useRef(null);
  const ed = useRef(null);
  const repaint = useRef(null);
  // The values the editor has sent up and not yet seen come back down:
  // a value that is one of them is its own edit, maybe stale, never one
  // to put in (review 38: putting a stale one in lost the newer edits).
  const sent = useRef([]);
  const latest = useRef({ onChange, cmds });
  latest.current = { onChange, cmds };
  const [plain] = useState(() => typeof window.CodeMirror !== "function");

  useEffect(() => {
    if (plain || !box.current) return;
    const marks = [], lit = [];
    let escaped = false, frame = 0, toks = [], tokensOf = -1;
    const cm = window.CodeMirror(box.current, {
      value, lineSeparator: "\n", lineWrapping: true, inputStyle: "contenteditable", screenReaderLabel: "program",
      indentUnit: 2, tabSize: 2, smartIndent: false, electricChars: false, spellcheck: false, autocorrect: false, autocapitalize: false,
      extraKeys: {
        Tab: (c) => (c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection("  ", "end")),
        "Shift-Tab": (c) => c.indentSelection("subtract"),
        Esc: () => { escaped = true; },
        // A line break, nothing more: the text stays exactly as typed.
        Enter: (c) => c.replaceSelection("\n", "end"),
      },
    });
    // The cursor starts at the end, as a text field's does, so a command
    // inserted before you click goes after the program (review 38).
    cm.setCursor(cm.lastLine(), cm.getLine(cm.lastLine()).length);
    // A paste goes in as it is. CodeMirror's own paste splits lines at
    // "\r\n" and "\r" whatever the line separator, so a "\r" would be
    // lost; replaceSelection splits at the separator alone.
    cm.on("paste", (c, e) => {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      c.replaceSelection(text, "end", "paste");
    });
    // A wrapped line hangs under its own indent, 2ch in, as in the viewer.
    cm.on("renderLine", (c, line, elt) => {
      const cols = window.CodeMirror.countColumn(line.text, null, c.getOption("tabSize"));
      const lead = (line.text.match(/^[ \t]*/) || [""])[0].length;
      const hang = `calc(${Math.min(cols, 40)}ch + 2ch)`;
      if (lead < line.text.length) { elt.style.textIndent = `calc(-1 * ${hang})`; elt.style.paddingLeft = `calc(10px + ${hang})`; }
    });
    const input = cm.getInputField();
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true");
    const at = (i) => cm.posFromIndex(i);
    // first is the first token that ends after offset i (binary search).
    const first = (i) => {
      let a = 0, b = toks.length;
      while (a < b) { const m = (a + b) >> 1; if (toks[m].start + toks[m].text.length <= i) a = m + 1; else b = m; }
      return a;
    };
    const light = () => {
      lit.splice(0).forEach((m) => m.clear());
      const i = cm.indexFromPos(cm.getCursor());
      let hot = -1;
      for (const j of [first(i - 1), first(i)]) if (toks[j] && toks[j].kind === "paren" && (toks[j].start === i - 1 || toks[j].start === i)) { hot = j; break; }
      const r = hotRange(toks, hot);
      cm.getWrapperElement().style.setProperty("--hc", r ? r.color : "transparent");
      if (!r) return;
      for (const k of new Set([r.lo, r.hi])) lit.push(cm.markText(at(toks[k].start), at(toks[k].start + 1), { className: "hot" }));
      if (r.hi - r.lo > 1) lit.push(cm.markText(at(toks[r.lo].start + 1), at(toks[r.hi].start), { className: "in" }));
    };
    // paint colours the lines in view (and CodeMirror's margin around
    // them), from the whole program's tokens: a program of thousands of
    // lines costs one tokenizing per change, not thousands of marks.
    const paint = () => {
      frame = 0;
      cm.operation(() => {
        const gen = cm.changeGeneration();
        if (gen !== tokensOf) { toks = DD.program(cm.getValue()); tokensOf = gen; }
        marks.splice(0).forEach((m) => m.clear());
        const vp = cm.getViewport();
        const from = cm.indexFromPos({ line: vp.from, ch: 0 });
        const to = cm.indexFromPos({ line: vp.to, ch: 0 });
        for (let k = first(from); k < toks.length && toks[k].start <= to; k++) {
          const t = toks[k], cls = tokenClass(t, latest.current.cmds);
          if (cls) marks.push(cm.markText(at(t.start), at(t.start + t.text.length), { className: cls }));
        }
        light();
      });
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(paint); };
    cm.on("change", () => {
      const v = cm.getValue();
      sent.current.push(v);
      if (sent.current.length > 200) sent.current.shift();
      latest.current.onChange(v);
      later();
    });
    cm.on("viewportChange", later);
    cm.on("cursorActivity", () => { if (!frame) cm.operation(light); });
    // After Esc, Tab is the browser's: it moves focus on. (CodeMirror.Pass
    // would hand it to CodeMirror's default keymap, which indents.)
    cm.on("keydown", (_, e) => {
      if (e.key === "Tab" && escaped) e.codemirrorIgnore = true;
      else if (e.key !== "Escape" && e.key !== "Shift") escaped = false;
    });
    cm.on("focus", () => { escaped = false; });
    ed.current = cm;
    repaint.current = later;
    paint();
    return () => { cancelAnimationFrame(frame); ed.current = null; repaint.current = null; const w = cm.getWrapperElement(); w.parentNode && w.parentNode.removeChild(w); };
  }, []);

  // A program put in from outside (an example, Ask heedle's, one put
  // back): never one the editor sent itself.
  useEffect(() => {
    const cm = ed.current;
    if (!cm) return;
    const k = sent.current.lastIndexOf(value);
    if (k >= 0) { sent.current.splice(0, k + 1); return; }
    if (cm.getValue() === value) return;
    sent.current = [];
    cm.setValue(value);
    cm.setCursor(cm.lastLine(), cm.getLine(cm.lastLine()).length);
  }, [value]);
  // Recolour once the worker's skills are known.
  useEffect(() => { if (repaint.current) repaint.current(); }, [cmds]);

  if (handle) handle.current = {
    el: () => box.current || area.current,
    insert: (text) => {
      const cm = ed.current;
      if (cm) { cm.replaceSelection(text); cm.focus(); return; }
      const el = area.current, i = el ? el.selectionStart : value.length;
      onChange(value.slice(0, i) + text + value.slice(i));
    },
  };
  if (plain) {
    return html`<textarea ref=${area} aria-label="program" spellcheck="false" value=${value} placeholder=${placeholder}
      onInput=${(e) => onChange(e.target.value)}></textarea>`;
  }
  return html`<div class="ed">
    <div ref=${box}></div>
    ${value === "" && html`<div class="ed-empty" aria-hidden="true">${placeholder}</div>`}
    <p class="muted ed-keys">Tab indents. To leave the editor by keyboard, press Esc, then Tab.</p>
  </div>`;
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

// ActWork shows what an act step did (roadmap 9.5): Claude's reply, how
// it ended, the hosts it could reach and what was blocked, then every
// action in order, each with the page it left and a screenshot of it.
function ActWork({ act: a, part = "all" }) {
  const failed = a.calls.filter((c) => c.isError).length;
  const summary = part !== "work", work = part !== "summary";
  const finished = a.ended === "finished";
  return html`
    <div class="answer act-work">
      ${summary && html`<pre class="answer-text">${a.text}</pre>`}
      ${summary && html`
      <div class="pills muted">
        <${Pill} cls="k-act">${a.model}<//>
        <${Pill} cls=${finished ? "s-Completed" : "s-Failed"}>${DD.actEnding(a.ended)}<//>
        <${Pill} cls="k-other" plain>${a.calls.length} action${a.calls.length === 1 ? "" : "s"}${failed ? `, ${failed} refused or failed` : ""}<//>
        <${Pill} cls="k-other" plain>${a.turns} turn${a.turns === 1 ? "" : "s"}<//>
        ${a.allowed.map((h) => html`<${Pill} key=${h} cls="s-Completed" mono>${h}<//>`)}
        <${Pill} cls=${a.blockedTotal || a.blockedUnknown ? "s-Failed" : "k-other"}>${a.blockedUnknown ? "blocked requests unknown" : `${a.blockedTotal} blocked`}<//>
        <${Pill} cls="k-container" mono>image ${a.image.replace(/^sha256:/, "").slice(0, 12)}<//>
      </div>
      <div class="mono muted">ended on ${a.url || "no page"}</div>`}
      ${work && html`<ol class="act-steps" aria-label="Actions">${a.calls.map((c, i) => html`
        <li key=${i} class=${c.isError ? "bad" : ""}>
          <div class="act-head"><span class="act-n">${i + 1}</span>
            <code>${c.tool.replace(/^browser_/, "")}</code>
            ${c.url && html`<span class="mono muted act-url">${c.url}</span>`}</div>
          <pre class="cmd-out">${DD.visible(c.input)}</pre>
          ${c.output && html`<details><summary>${c.isError ? "What went wrong" : "What it saw"}</summary><pre class="cmd-out">${DD.visible(c.output)}${c.truncated ? "\n[cut]" : ""}</pre></details>`}
          ${c.screenshot && html`<img class="act-shot" src=${c.screenshot} alt=${`After action ${i + 1}, ${c.tool.replace(/^browser_/, "")}${c.url ? ", on " + c.url : ""}`} loading="lazy" />`}
        </li>`)}</ol>`}
      ${work && a.blocked.length > 0 && html`<details><summary>Blocked requests (${a.blockedTotal})</summary><pre>${a.blocked.join("\n")}</pre></details>`}
    </div>`;
}

function Output({ text }) {
  const { agent, act, answer, page } = DD.parse(text);
  if (agent) return html`<${AgentWork} agent=${agent} />`;
  if (act) return html`<${ActWork} act=${act} />`;
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
      <div class="pills"><${StatusPill} status="Running" /> <${KindPill} kind=${f.kind === "act" ? "act" : "browse"}>${f.kind === "act" ? "Claude in a browser" : "live browser"}<//>
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
  const [record, sunk, ink, surface] = ["--record", "--sunk", "--ink", "--surface"].map(css);
  const hex = [record, sunk, ink, surface].every((h) => /^#[0-9a-f]{6}$/i.test(h));
  return html`
    <div class="cal" role="group" aria-label="Runs by day, from the latest records">
      <div class="cal-head">
        <button class="cal-nav" onClick=${() => move(-1)} aria-label="Previous month"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <strong>${title}</strong>
        <button class="cal-nav" onClick=${() => move(1)} aria-label="Next month"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="cal-grid">
        ${["M", "T", "W", "T", "F", "S", "S"].map((d, i) => html`<span key=${"h" + i} class="cal-dow" aria-hidden="true">${d}</span>`)}
        ${DD.monthGrid(shown.y, shown.m).flat().map((d) => {
          const c = counts[d.key];
          const name = new Date(d.key + "T12:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
          const label = `${name}: ${c ? `${c.runs} run${c.runs === 1 ? "" : "s"}${c.failed ? `, ${c.failed} failed` : ""}` : "no runs"}`;
          const cls = ["cal-day", d.inMonth ? "" : "cal-out", c ? "cal-has" : "", c && c.failed ? "cal-failed" : "", d.key === day ? "cal-on" : "", d.key === today ? "cal-today" : ""].join(" ");
          // The tint, and whichever text reads best on it (review 23).
          const look = c && hex ? DD.tint(c.runs / most, record, sunk, ink, surface) : null;
          return html`<button key=${d.key} class=${cls} disabled=${!c && d.key !== day} aria-pressed=${d.key === day} aria-label=${label} title=${label}
            style=${look ? { background: look.bg, color: look.text } : null}
            onClick=${() => onDay(d.key === day ? "" : d.key)}>${d.day}</button>`;
        })}
      </div>
    </div>`;
}

const statusVar = (s) => ({ Completed: "ok", Running: "run", Recorded: "rec", Merged: "merge" }[s] || "bad");

// === Composition graph =====================================================
// A program drawn as it was written: steps one after another (`;`, a pipe)
// left to right, side by side (`⊗`, a par) stacked. Every group folds,
// every step opens in place to show all the record knows about it, and
// every link the page has for a step is one click away.

const OPS = { pipe: { sym: ";", name: "one after another" }, par: { sym: "⊗", name: "side by side" } };

const Icon = ({ d, label }) => html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><title>${label}</title>
  <path d=${d} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICONS = {
  open: "M9 2h5v5M14 2 7.5 8.5M12 9.5V14H2V4h4.5",
  skill: "M3 2.5h7.5L13 5v8.5H3zM10.5 2.5V5H13M5.5 8h5M5.5 10.5h3.5",
  diff: "M4 2v8M1 6h6M9.5 11h5.5M4 13.5h0M12 2v5",
  temporal: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
  record: "M2 8h3.5M10.5 8H14M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
  more: "M4 6l4 4 4-4",
  fold: "M3 8h10",
  unfold: "M3 8h10M8 3v10",
  full: "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4",
};

function IconLink({ href, icon, label, external }) {
  return html`<a class="cg-icon" href=${href} aria-label=${label} title=${label}
    target=${external ? "_blank" : undefined} rel=${external ? "noopener" : undefined}><${Icon} d=${ICONS[icon]} label=${label} /></a>`;
}

// useComposition holds what the graph shows open and folded, so the page
// and its full-screen view stay in step.
// Both belong to one drawing: when the program changes shape (an edit in
// the editor), steps and groups are named afresh, so both start empty.
function useComposition(plan, shape) {
  const { shape: sh, exact } = DD.composition(shape, plan);
  const sig = JSON.stringify([sh, exact]);
  const [openAt, setOpen] = useState({ sig, set: new Set() });
  const [foldedAt, setFolded] = useState({ sig, set: new Set() });
  const now = (at) => (at.sig === sig ? at.set : new Set());
  const put = (setter, set) => setter({ sig, set });
  const flip = (at, setter) => (k) => { const t = new Set(now(at)); t.has(k) ? t.delete(k) : t.add(k); put(setter, t); };
  return {
    sh, exact, open: now(openAt), folded: now(foldedAt),
    toggle: flip(openAt, setOpen), fold: flip(foldedAt, setFolded),
    expandAll: () => { put(setOpen, new Set(sh ? DD.stepsOf(sh) : [])); put(setFolded, new Set()); },
    collapseAll: () => { put(setOpen, new Set()); put(setFolded, new Set()); },
    foldAll: () => put(setFolded, new Set(DD.groupKeys(sh).filter((k) => k !== "0"))),
  };
}

// CompositionGraph draws a plan's composition. rec, steps, wf, run and
// temporalLink are optional: the editor's preview has none of them.
function CompositionGraph({ plan, shape, rec, steps, wf, run, temporalLink }) {
  const state = useComposition(plan, shape);
  const [full, setFull] = useState(false);
  const fullRef = useRef(null);
  if (!state.sh) return html`<p class="muted">No steps.</p>`;
  const ctx = makeCtx(plan, rec, steps, wf, run, temporalLink, state);
  const n = DD.stepsOf(state.sh).length;
  const bar = (inViewer) => html`
    <div class="cg-bar">
      <span class="muted">${n} step${n === 1 ? "" : "s"}${state.exact ? ", drawn as the program composes them" : ", drawn from what each step waits for"}</span>
      <span class="spacer"></span>
      <button type="button" onClick=${state.expandAll}>Show every detail</button>
      <button type="button" onClick=${state.collapseAll}>Collapse all</button>
      ${DD.groupKeys(state.sh).length > 1 && html`<button type="button" onClick=${state.foldAll}>Fold groups</button>`}
      ${!inViewer && html`<button type="button" class="cg-full" ref=${fullRef} onClick=${() => setFull(true)} aria-label="Open the graph full screen" title="Full screen"><${Icon} d=${ICONS.full} label="Full screen" /></button>`}
    </div>`;
  return html`
    <div class="cg">
      ${bar(false)}
      <div class="cg-scroll"><${ShapeView} sh=${state.sh} path="0" ctx=${ctx} top /></div>
      ${full && html`<${Viewer} title="Composition" info=${`${n} steps. Drag to pan, scroll or + and − to zoom, Fit to see it whole, Escape to close.`}
        onClose=${() => { setFull(false); setTimeout(() => fullRef.current && fullRef.current.focus(), 0); }}>
        ${bar(true)}<${ShapeView} sh=${state.sh} path="0" ctx=${ctx} top /><//>`}
    </div>`;
}

function makeCtx(plan, rec, steps, wf, run, temporalLink, state) {
  const nodes = (plan && plan.nodes) || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stepOf = new Map((steps || []).map((s) => [s.node, s]));
  const feeds = new Map();
  for (const n of nodes) for (const r of n.requires || []) feeds.set(r, [...(feeds.get(r) || []), n.id]);
  const writes = rec ? DD.asWrites(rec.writes) : [];
  const stepHref = wf && run ? (id) => "#/step/" + [wf, run, id].map(encodeURIComponent).join("/") : null;
  return { plan, byId, stepOf, feeds, writes, rec, stepHref, temporalLink, ...state };
}

function ShapeView({ sh, path, ctx, top }) {
  if (sh.kind === "step") return html`<${StepCard} id=${sh.node} ctx=${ctx} />`;
  const op = OPS[sh.kind];
  const ids = DD.stepsOf(sh);
  const folded = ctx.folded.has(path);
  const parts = [];
  if (!folded) sh.parts.forEach((p, i) => {
    if (sh.kind === "pipe" && i > 0) {
      const before = sh.parts.slice(0, i).flatMap(DD.stepsOf);
      parts.push(html`<${Flow} key=${"f" + i} flows=${DD.flowsInto(ctx.plan, ctx.exact ? DD.stepsOf(sh.parts[i - 1]) : before, DD.stepsOf(p))} ctx=${ctx} />`);
    }
    parts.push(html`<${ShapeView} key=${i} sh=${p} path=${path + "." + i} ctx=${ctx} />`);
  });
  const t = folded ? DD.tally(ids, (id) => ctx.stepOf.get(id) && ctx.stepOf.get(id).status) : {};
  // The fold button is the same element folded or not, so it keeps focus.
  return html`
    <div class=${"cg-group cg-" + sh.kind + (top ? " cg-top" : "") + (folded ? " cg-is-folded" : "")} role="group" aria-label=${`${ids.length} steps ${op.name}`}>
      ${!top && html`<div class="cg-op">
        <button type="button" class="cg-fold" aria-expanded=${!folded} onClick=${() => ctx.fold(path)}
          aria-label=${`${folded ? "Unfold" : "Fold"} these ${ids.length} steps, ${op.name}`} title=${folded ? "Unfold" : "Fold"}>
          <${Icon} d=${folded ? ICONS.unfold : ICONS.fold} label=${folded ? "Unfold" : "Fold"} /></button>
        <span class="cg-sym">${op.sym}</span><span class="muted">${folded ? `${ids.length} steps ${op.name}` : op.name}</span></div>`}
      ${folded ? html`<div class="cg-summary">
          <span class="cg-ids mono">${ids.slice(0, 6).join(" ")}${ids.length > 6 ? ` and ${ids.length - 6} more` : ""}</span>
          ${Object.entries(t).filter(([s]) => s !== "none").map(([s, c]) => html`<${Pill} key=${s} cls=${"s-" + s}>${c} ${s.toLowerCase()}<//>`)}
        </div>`
        : html`<div class="cg-parts">${parts}</div>`}
    </div>`;
}

// Flow is the arrow between two stages of a pipe: hover or focus it for
// exactly what is handed over, and how much.
function Flow({ flows, ctx }) {
  const out = ctx.rec ? ctx.rec.outputs : null;
  const froms = [...new Set(flows.map((f) => f.from))];
  const total = out ? froms.reduce((a, id) => a + new Blob([out[id] || ""]).size, 0) : null;
  const card = html`<${Card} title="Handed over">
    ${flows.length === 0 ? html`<${Field} k="Nothing">these steps wait for nothing before them<//>` : flows.map((f) => html`
      <${Field} key=${f.from + f.to} k=${html`<span class="mono">${f.from} → ${f.to}</span>`}>
        ${out ? html`${bytes(out[f.from])}<pre>${preview(out[f.from]).slice(0, 200)}</pre>` : `${f.to} is given ${f.from}'s output, as text`}<//>`)}<//>`;
  return html`<${Tip} class="cg-flow" content=${card} color=${css("--muted")} aria-label=${`${flows.length} hand-overs`}>
    <span class="cg-line"></span>
    ${total != null && html`<span class="cg-bytes mono">${DD.size(total)}</span>`}
    <span class="cg-head-arrow" aria-hidden="true">▶</span>
  <//>`;
}

function StepCard({ id, ctx }) {
  const n = ctx.byId.get(id) || { id, activity: "" };
  const kind = kindOf(n.activity);
  const sk = DD.skillOf(n);
  const args = sk ? sk.args : n.args || [];
  const step = ctx.stepOf.get(id);
  const out = ctx.rec ? ctx.rec.outputs[id] : undefined;
  const files = ctx.rec ? DD.asFiles((ctx.rec.files || {})[id]) : [];
  const writes = ctx.writes.filter((w) => w.node === id);
  const agent = out != null ? DD.parse(out).agent : null;
  const open = ctx.open.has(id);
  const argText = args.map((a) => JSON.stringify(a)).join(" ");
  const idEl = ctx.stepHref ? html`<a class="mono cg-id" href=${ctx.stepHref(id)}>${id}</a>` : html`<span class="mono cg-id">${id}</span>`;
  const link = (x) => (ctx.stepHref ? html`<a class="mono" href=${ctx.stepHref(x)}>${x}</a>` : html`<span class="mono">${x}</span>`);
  const list = (xs) => xs.map((x, i) => html`${i ? ", " : ""}${link(x)}`);
  return html`
    <article class=${"cg-card k-" + kind + (step && step.status === "Failed" ? " cg-bad" : "") + (open ? " cg-open" : "")}
      style=${{ "--c": kindColor(kind) }} aria-label=${`Step ${id}, ${sk ? sk.name : n.activity}`}>
      <div class="cg-head">
        <span class="cg-title">${idEl}
          <${KindPill} kind=${kind}>${sk ? sk.name : n.activity}<//>
          ${step && html`<${StatusPill} status=${step.status} />`}</span>
        <button type="button" class="cg-more" aria-expanded=${open} onClick=${() => ctx.toggle(id)}
          aria-label=${(open ? "Hide" : "Show") + ` everything about ${id}`} title=${open ? "Hide details" : "Show every detail"}>
          <${Icon} d=${ICONS.more} label="Details" /></button>
      </div>
      ${argText && html`<div class="cg-args mono" title=${argText}>${argText}</div>`}
      ${!ctx.exact && !open && html`<div class="cg-waits">${(n.requires || []).length ? html`waits for ${list(n.requires)}` : "waits for nothing"}</div>`}
      <div class="cg-chips">
        ${step && step.attempts > 1 && html`<${Pill} cls="s-Failed">${step.attempts} attempts<//>`}
        ${step && took(step.started, step.closed) && html`<${Pill} cls="k-other" plain>ran ${took(step.started, step.closed)}<//>`}
        ${out != null && html`<${Pill} cls="k-record" plain>${bytes(out)}<//>`}
        ${files.length > 0 && html`<${Pill} cls="k-other" plain>${files.length} file${files.length === 1 ? "" : "s"}<//>`}
        ${writes.length > 0 && html`<${Pill} cls="s-Running">${writes.length} write${writes.length === 1 ? "" : "s"}<//>`}
        ${agent && html`<${Pill} cls="k-agent" plain>${agent.turns} turns<//>`}
      </div>
      ${out != null && !open && html`<div class="cg-peek">${preview(out).slice(0, 140)}</div>`}
      ${open && html`<dl class="cg-detail">
        <dt>Runs</dt><dd>${sk ? html`<${SkillBadge} skill=${sk} />` : html`<span class="mono">${n.activity}</span>`}</dd>
        <dt>Arguments</dt><dd>${argText ? html`<span class="mono cg-wrap">${argText}</span>` : "none"}</dd>
        <dt>Waits for</dt><dd>${(n.requires || []).length ? list(n.requires) : "nothing: starts at once"}</dd>
        <dt>Feeds</dt><dd>${(ctx.feeds.get(id) || []).length ? list(ctx.feeds.get(id)) : "no later step"}</dd>
        ${step && html`
          <dt>Status</dt><dd>${step.status}${step.attempts > 1 ? `, after ${step.attempts} attempts (Temporal retried it)` : ""}</dd>
          ${took(step.scheduled, step.started) && html`<dt>Queued</dt><dd>${took(step.scheduled, step.started)}</dd>`}
          ${took(step.started, step.closed) && html`<dt>Ran</dt><dd>${took(step.started, step.closed)}</dd>`}
          ${when(step.started) && html`<dt>Started</dt><dd>${when(step.started)}</dd>`}
          ${when(step.closed) && html`<dt>Finished</dt><dd>${when(step.closed)}</dd>`}
          ${step.failure && html`<dt>Failure</dt><dd class="mono cg-wrap">${step.failure}<${ConnectPrompt} failure=${step.failure} /></dd>`}`}
        ${files.length > 0 && html`<dt>Files</dt><dd>${DD.fileSummary(files)}</dd>`}
        ${writes.map((w) => html`<dt key=${w.id}>Write</dt><dd key=${w.id + "v"}><span class="mono">${w.connector} ${w.tool}</span> <${Pill} cls=${w.status === "done" ? "s-Completed" : w.status === "waiting" ? "s-Running" : "s-Failed"}>${w.status}<//></dd>`)}
        ${agent && html`<dt>Agent</dt><dd>${agent.model}, ${agent.turns} turns, ${agent.commands.length} commands, ${agent.files.length} files</dd>`}
        ${out != null && html`<dt>Output</dt><dd>${bytes(out)}, in <span class="mono">outputs/${id}</span> of ${short(ctx.rec.commit)}</dd>`}
      </dl>
      ${out != null && html`<pre class="cg-out">${preview(out).slice(0, 2000)}</pre>`}`}
      ${(ctx.stepHref || sk || ctx.temporalLink) && html`<nav class="cg-links" aria-label=${`Links for ${id}`}>
        ${ctx.stepHref && html`<${IconLink} href=${ctx.stepHref(id)} icon="open" label=${`Inspect ${id}: inputs, sandbox, files`} />`}
        ${sk && html`<${IconLink} href=${"#/skill/" + encodeURIComponent(sk.name) + "/" + encodeURIComponent(sk.version)} icon="skill" label=${`The skill ${sk.name} at @${sk.version.slice(0, 7)}`} />`}
        ${ctx.rec && ctx.rec.previous && html`<${IconLink} href=${"#/diff/" + encodeURIComponent(ctx.rec.previous) + "/" + encodeURIComponent(ctx.rec.commit)} icon="diff" label="What changed since this program's previous run" />`}
        ${ctx.rec && ctx.rec.parent && html`<${IconLink} href=${"#/diff/" + encodeURIComponent(ctx.rec.parent) + "/" + encodeURIComponent(ctx.rec.commit)} icon="record" label=${`The record ${short(ctx.rec.commit)} in Git`} />`}
        ${ctx.temporalLink && html`<${IconLink} href=${ctx.temporalLink} icon="temporal" label="The run's event history in Temporal" external />`}
      </nav>`}
    </article>`;
}

// Viewer shows its children over the page: drag to pan, scroll or the
// buttons to zoom, Escape to close.
function Viewer({ title, info, onClose, children }) {
  const tip = useContext(TipContext);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);
  const closeRef = useRef(null);
  const stage = useRef(null);
  const dialog = useRef(null);
  const zoom = (f, cx, cy) => setView((v) => {
    const k = Math.min(4, Math.max(0.25, v.k * f));
    const r = stage.current.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top;
    return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
  });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const canvas = useRef(null);
  // fit shows the whole drawing, never larger than its own size.
  const fit = () => {
    const r = stage.current.getBoundingClientRect(), c = canvas.current;
    const k = Math.max(0.25, Math.min(1, r.width / c.offsetWidth, r.height / c.offsetHeight));
    setView({ k, x: Math.max(0, (r.width - c.offsetWidth * k) / 2), y: 0 });
  };
  useLayoutEffect(fit, []);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Tab") {
        // A modal keeps focus inside it.
        const all = [...dialog.current.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])")];
        const first = all[0], last = all[all.length - 1];
        if (!dialog.current.contains(document.activeElement)) { e.preventDefault(); first && first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      } else if ((e.key === "+" || e.key === "=") && !e.target.closest("input, textarea, [contenteditable]")) zoomRef.current(1.2);
      else if (e.key === "-" && !e.target.closest("input, textarea, [contenteditable]")) zoomRef.current(1 / 1.2);
    };
    addEventListener("keydown", key);
    // React's wheel listener is passive, so preventDefault there is ignored
    // and a trackpad pinch would zoom the whole page instead.
    const wheel = (e) => { e.preventDefault(); zoomRef.current(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY); };
    const box = stage.current;
    box.addEventListener("wheel", wheel, { passive: false });
    closeRef.current && closeRef.current.focus();
    return () => { removeEventListener("keydown", key); box.removeEventListener("wheel", wheel); tip.hide(); };
  }, []);
  return html`
    <div class="viewer" role="dialog" aria-modal="true" aria-label=${title} ref=${dialog}>
      <div class="viewer-bar">
        <strong>${title}</strong>
        <span class="muted">${info}</span>
        <span class="spacer"></span>
        <button type="button" onClick=${() => zoom(1.25)} aria-label="Zoom in">+</button>
        <button type="button" onClick=${() => zoom(0.8)} aria-label="Zoom out">−</button>
        <button type="button" onClick=${fit}>Fit</button>
        <button type="button" onClick=${() => setView({ x: 0, y: 0, k: 1 })}>100%</button>
        <button type="button" ref=${closeRef} onClick=${onClose}>Close</button>
      </div>
      <div class="viewer-stage" ref=${stage}
        onPointerDown=${(e) => {
          // Links, buttons and text stay clickable and selectable.
          if (e.target.closest("a, button, [tabindex], pre, .cg-detail")) return;
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove=${(e) => { if (drag.current) setView((v) => ({ ...v, x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })); }}
        onPointerUp=${() => { drag.current = null; }}
        onPointerCancel=${() => { drag.current = null; }}
        onLostPointerCapture=${() => { drag.current = null; }}>
        <div class="viewer-canvas" ref=${canvas} style=${{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>${children}</div>
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


// === Schedules =============================================================
// Programs Temporal runs on a timer (loom's schedules). Each run is a
// run like any other: on the runs list, recorded in Git.

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
const EVERY = [["1h", "every hour"], ["6h", "every 6 hours"], ["24h", "every day"], ["168h", "every week"]];

function ScheduleForm({ program, history, actHosts, onDone }) {
  const [name, setName] = useState("");
  const [how, setHow] = useState("every");
  const [every, setEvery] = useState("24h");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [zone, setZone] = useState(localZone());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [made, setMade] = useState("");
  const make = async () => {
    setBusy(true); setErr("");
    const body = { name, program, ref: history, actHosts, ...(how === "every" ? { every } : { cron, timeZone: zone }) };
    const r = await api("/api/schedules", body);
    setBusy(false);
    if (!r.ok) { setErr((r.data && r.data.error) || String(r.data)); return; }
    setMade(name);
  };
  if (made) return html`<p role="status">Scheduled <a href="#/schedules" class="mono">${made}</a>. Its runs appear with the others. <button class="link-btn" onClick=${onDone}>Close</button></p>`;
  return html`
    <div class="add-form schedule-form">
      <div class="row">
        <label>Name<input type="text" value=${name} placeholder="weekly-digest" onInput=${(e) => setName(e.target.value)} /></label>
        <label>When<select value=${how} onChange=${(e) => setHow(e.target.value)}>
          <option value="every">every so often</option><option value="cron">at set times (cron)</option></select></label>
        ${how === "every" ? html`<label>How often<select value=${every} onChange=${(e) => setEvery(e.target.value)}>
            ${EVERY.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select></label>`
          : html`<label>Cron (minute hour day month weekday)<input type="text" value=${cron} onInput=${(e) => setCron(e.target.value)} /></label>
            <label>Time zone<input type="text" value=${zone} onInput=${(e) => setZone(e.target.value)} /></label>`}
      </div>
      <div class="row">
        <button class="primary" type="button" disabled=${busy || !name} onClick=${make}>${busy ? "Scheduling…" : "Schedule it"}</button>
        <button type="button" onClick=${onDone}>Cancel</button>
        <span class="muted">Temporal runs it as written now; a run still going when the next is due skips that one.</span>
      </div>
      ${err && html`<p class="error" role="alert">${err}</p>`}
    </div>`;
}

function SchedulesPage() {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState("");
  const [sure, setSure] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { api("/api/schedules").then((r) => { setData(r); tellBar("schedules", r); }); }, [tick]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const ss = DD.asSchedules(data.data);
  const act = async (name, action) => {
    setErr(""); setSure(""); setNote("");
    const r = await api(`/api/schedules/${encodeURIComponent(name)}/${action}`, {});
    if (!r.ok) setErr((r.data && r.data.error) || String(r.data));
    else if (action === "run") setNote(`Started ${name}, or, if a run of it is still going, it starts when that one ends.`);
    // Temporal's list catches up in a moment: look now, and again soon.
    setTick((t) => t + 1);
    setTimeout(() => setTick((t) => t + 1), 1500);
  };
  return html`
    <h2>Schedules</h2>
    <p class="lede">Programs Temporal runs on a timer. Each run is a run like any other: on the runs list, recorded in Git, its writes waiting for your approval. Make one with <strong>Schedule…</strong> beside <strong>Run</strong>.</p>
    ${err && html`<p class="error" role="alert">${err}</p>`}
    ${note && html`<p role="status">${note}</p>`}
    ${ss.length === 0 && html`<div class="panel muted">No schedules yet. Write a program on the home page, then <strong>Schedule…</strong>.</div>`}
    ${ss.map((s) => html`
      <div class="panel connector" key=${s.name}>
        <div class="pills">
          <strong class="mono">${s.name}</strong>
          <${Pill} cls=${s.paused ? "s-Scheduled" : "s-Completed"}>${s.paused ? "paused" : DD.when(s.spec)}<//>
          <${Pill} cls="k-record" plain mono>${s.ref.replace(/^refs\/loom\//, "")}<//>
          ${!s.paused && (s.next || []).length > 0 && html`<${Pill} cls="k-other" plain>next ${when(s.next[0])}<//>`}
          <span style=${{ marginLeft: "auto" }} class="pills">
            <button type="button" onClick=${() => act(s.name, "run")}>Run now</button>
            <button type="button" onClick=${() => act(s.name, s.paused ? "resume" : "pause")}>${s.paused ? "Resume" : "Pause"}</button>
            ${sure === s.name ? html`<span>Delete ${s.name}? Its runs stay.</span><button type="button" onClick=${() => act(s.name, "delete")}>Delete</button><button type="button" onClick=${() => setSure("")}>Keep</button>`
              : html`<button type="button" class="link-btn" onClick=${() => setSure(s.name)}>Delete</button>`}
          </span>
        </div>
        ${s.paused && s.note && html`<p class="muted">${s.note}</p>`}
        <${Program} text=${s.program} max=${400} />
        ${(s.recent || []).length > 0 && html`<p class="muted">Recent runs: ${s.recent.slice(-8).reverse().map((r, i) => html`${i ? ", " : ""}<a key=${r.runId} href=${"#/run/" + encodeURIComponent(r.workflowId) + "/" + encodeURIComponent(r.runId)}>${when(r.at)}</a>`)}</p>`}
      </div>`)}`;
}

// === Connectors ============================================================
// The MCP servers agent steps may be granted, as the worker's connectors
// file has them now, and where each key is found. A key typed here goes
// straight to this machine's keychain: never to Temporal, Git or a log,
// and the page never gets one back.

const FROM_LABEL = { environment: "in the environment", keychain: "in your keychain", missing: "not set" };
const FROM_CLASS = { environment: "s-Completed", keychain: "s-Completed", missing: "s-Failed" };

function KeyRow({ k, onDone, note }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async (path, body) => {
    setBusy(true); setErr("");
    const r = await api(path, body);
    setBusy(false);
    if (!r.ok) { setErr((r.data && r.data.error) || String(r.data)); return; }
    setValue("");
    onDone();
  };
  const id = "key-" + k.name;
  return html`
    <div class="key-row">
      <div class="pills"><span class="mono">${k.name}</span><${Pill} cls=${k.error ? "s-Failed" : FROM_CLASS[k.from]}>${k.error ? "can't read the keychain" : FROM_LABEL[k.from]}<//></div>
      ${k.error && html`<p class="error mono">${k.error}</p>`}
      ${k.from === "environment" ? html`<p class="muted">Set where heedle runs; it's used before your keychain.</p>` : html`
        <form class="row" onSubmit=${(e) => { e.preventDefault(); if (value) send("/api/secrets", { name: k.name, value }); }}>
          <label class="sr" for=${id}>${k.name}</label>
          <input id=${id} type="password" autocomplete="off" spellcheck="false" placeholder=${k.from === "keychain" ? "Paste a new key to replace it" : "Paste the key"}
            value=${value} onInput=${(e) => setValue(e.target.value)} />
          <button class="primary" type="submit" disabled=${busy || !value}>${busy ? "Saving…" : k.from === "keychain" ? "Replace" : "Save"}</button>
          ${k.from === "keychain" && html`<button type="button" disabled=${busy} onClick=${() => send("/api/secrets/delete", { name: k.name })}>Remove</button>`}
        </form>`}
      ${note && html`<p class="muted">${note}</p>`}
      ${err && html`<p class="error" role="alert">${err}</p>`}
    </div>`;
}

// AddConnector searches the MCP Registry and adds a remote server: its
// name (a connector name grants use), and a token, which goes to the
// keychain, never the connectors file.
function AddConnector({ onDone, taken }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [done, setDone] = useState("");
  const [waiting, setWaiting] = useState("");
  // While a sign-in is open in another tab, look for the connector it adds.
  useEffect(() => {
    if (!waiting) return;
    let live = true, timer = null;
    const until = Date.now() + 10 * 60 * 1000;
    const look = async () => {
      const r = await api("/api/connectors");
      if (!live) return;
      const v = r.ok && DD.asConnectors(r.data);
      if (v && v.connectors.some((c) => c.name === waiting)) { setDone(waiting); setWaiting(""); setPick(null); onDone(); return; }
      if (Date.now() < until) timer = setTimeout(look, 2000); else { setWaiting(""); setErr("The sign-in didn't finish in 10 minutes. Try again."); }
    };
    timer = setTimeout(look, 2000);
    return () => { live = false; clearTimeout(timer); };
  }, [waiting]);
  const find = async (cursor) => {
    setBusy(true); setErr(""); setDone("");
    const r = await api("/api/connectors/catalog", { search, cursor: cursor || "" });
    setBusy(false);
    if (!r.ok) { setErr((r.data && r.data.error) || String(r.data)); return; }
    const p = DD.asRegistryPage(r.data);
    if (!p) { setErr("The registry's answer wasn't understood."); return; }
    setPage((old) => (cursor && old ? { servers: [...old.servers, ...p.servers], next: p.next } : p));
  };
  const choose = (e) => { setPick(e); setName(DD.freeName(e.suggest, taken)); setToken(""); setErr(""); };
  const signIn = async () => {
    setBusy(true); setErr("");
    const r = await api("/api/connectors/connect", { name, url: pick.url });
    setBusy(false);
    if (!r.ok) { setErr((r.data && r.data.error) || String(r.data)); return; }
    if (r.data.signIn === false) { add(); return; } // it needs no sign-in
    const u = DD.signInURL(r.data.authorize);
    if (!u) { setErr("The sign-in page's address wasn't https://."); return; }
    setConfirm({ url: u, at: String(r.data.at || "") }); // say where before going there (review 29)
  };
  const [confirm, setConfirm] = useState(null);
  const go = () => { window.open(confirm.url, "_blank", "noopener,noreferrer"); setConfirm(null); setWaiting(name); };
  const add = async () => {
    setBusy(true); setErr("");
    const r = await api("/api/connectors/add", { name, url: pick.url, token });
    setBusy(false);
    if (!r.ok) { setErr((r.data && r.data.error) || String(r.data)); return; }
    setDone(name); setPick(null); setToken("");
    onDone();
  };
  return html`
    <div class="panel add-connector">
      <h3 style=${{ marginTop: 0 }}>Add from the MCP Registry</h3>
      <form class="row" onSubmit=${(e) => { e.preventDefault(); find(); }}>
        <label class="sr" for="registry-search">Search the MCP Registry</label>
        <input id="registry-search" type="text" placeholder="maps, search, calendar…" value=${search} onInput=${(e) => setSearch(e.target.value)} />
        <button class="primary" type="submit" disabled=${busy}>${busy && !pick ? "Searching…" : "Search"}</button>
      </form>
      ${done && html`<p role="status">Added <span class="mono">${done}</span>. A step can use it from now on, as its arguments grant: <span class="mono">(agent "…" "${done}")</span>.</p>`}
      ${err && html`<p class="error" role="alert">${err}</p>`}
      ${pick && html`
        <div class="add-form">
          <p><strong>${pick.title || pick.name}</strong> <span class="mono muted">${pick.url}</span></p>
          <div class="row">
            <label>Connector name<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
            <label>Or paste an access token from its settings<input type="password" autocomplete="off" value=${token} onInput=${(e) => setToken(e.target.value)} /></label>
          </div>
          ${confirm ? html`<div class="row"><span>${pick.title || pick.name} signs you in at <strong class="mono">${confirm.at}</strong>. Sign in there only if that's who you expect.</span>
              <button class="primary" type="button" onClick=${go}>Open the sign-in at ${confirm.at}</button>
              <button type="button" onClick=${() => setConfirm(null)}>Cancel</button></div>`
          : waiting ? html`<p role="status">Finish signing in to <strong>${pick.title || pick.name}</strong> in the new tab; this page picks it up when you're done.</p>` : html`
          <div class="row">
            <button class="primary" type="button" disabled=${busy || !name || !!token} onClick=${signIn}>${busy ? "Working…" : "Sign in and add " + name}</button>
            <button type="button" disabled=${busy || !name || (pick.token && !token)} onClick=${add}>${token ? "Add with this token" : "Add without signing in"}</button>
            <button type="button" onClick=${() => setPick(null)}>Cancel</button>
          </div>`}
          <div class="row">
            <span class="muted">The address goes to your connectors file${token ? html`; the token to your keychain as <span class="mono">${DD.tokenName(name)}</span>` : ""}. Add it only if you trust its publisher: steps granted it send it what they're given.</span>
          </div>
        </div>`}
      ${page && page.servers.length === 0 && html`<p class="muted">Nothing found.</p>`}
      ${page && page.servers.length > 0 && html`<ul class="registry">${page.servers.map((e) => html`
        <li key=${e.name + e.url} class=${e.fit === "ready" ? "" : "cant"}>
          <div><strong>${e.title || e.name}</strong> <span class="mono muted">${e.name}</span>
            ${e.link && html` <a href=${e.link} target="_blank" rel="noopener noreferrer">about</a>`}</div>
          <div class="muted">${e.description}</div>
          ${e.fit === "ready" ? html`<div><button type="button" onClick=${() => choose(e)}>Add</button>
              ${e.token && html` <${Pill} cls="k-other" plain>needs a token<//>`}</div>`
            : html`<div class="muted">${e.why}</div>`}
        </li>`)}</ul>`}
      ${page && page.hidden > 0 && html`<p class="muted">${page.hidden} more couldn't be shown safely.</p>`}
      ${page && page.next && html`<button type="button" disabled=${busy} onClick=${() => find(page.next)}>More</button>`}
    </div>`;
}

function RemoveConnector({ name, onDone }) {
  const [sure, setSure] = useState(false);
  const [err, setErr] = useState("");
  if (!sure) return html`<button type="button" class="link-btn" style=${{ marginLeft: "auto" }} onClick=${() => setSure(true)}>Remove</button>`;
  return html`<span style=${{ marginLeft: "auto" }} class="pills">
    <span>Remove ${name} and its keys?</span>
    <button type="button" onClick=${async () => { const r = await api("/api/connectors/remove", { name }); if (r.ok) onDone(); else setErr((r.data && r.data.error) || "failed"); }}>Remove</button>
    <button type="button" onClick=${() => setSure(false)}>Keep</button>
    ${err && html`<span class="error">${err}</span>`}</span>`;
}

// SkillConnectors shows the connectors a skill asks for, each marked as
// this worker can use it or not, with a link to connect the ones it can't.
function SkillConnectors({ grant }) {
  const [view, setView] = useState(null);
  useEffect(() => { api("/api/connectors").then((r) => setView((r.ok && DD.asConnectors(r.data)) || null)); }, [grant]);
  const cs = DD.skillConnectors(grant, view);
  const label = { connected: ", connected", key: ", key not set", absent: ", not connected", unknown: "" };
  const cls = { connected: "s-Completed", key: "s-Failed", absent: "s-Failed", unknown: "k-other" };
  const todo = cs.filter((c) => c.state === "key" || c.state === "absent").map((c) => c.name);
  return html`<div class="pills" style=${{ marginTop: "8px" }}><span class="muted">Its steps use</span>
    ${cs.map((c) => html`<${Pill} key=${c.name} cls=${cls[c.state]} mono>${c.name}${label[c.state]}<//>`)}
    ${todo.length > 0 && html`<a href="#/connectors">Connect ${todo.join(" and ")}</a>`}</div>`;
}

// ConnectPrompt turns a step's failure for want of a connector or a key
// into what to do about it, with a link to the Connectors page where
// that's where it's done.
function ConnectPrompt({ failure }) {
  const p = DD.connectorProblem(failure);
  if (!p) return null;
  const list = (ns) => ns.map((n, i) => html`${i ? " and " : ""}<span class="mono">${n}</span>`);
  const msg = p.missing ? html`This step needs the connector${p.missing.length > 1 ? "s" : ""} ${list(p.missing)}, which this worker doesn't have. Add ${p.missing.length > 1 ? "them" : "it"} with that name.`
    : p.tools ? html`This step asks for tools of ${list(p.tools)} that this worker's connector doesn't allow. Add them to its tools in the connectors file.`
    : p.again ? html`The key <span class="mono">${p.key}</span> for <span class="mono">${p.connector}</span> in the keychain isn't one heedle can use. Set it again.`
    : p.key ? html`This step needs the key <span class="mono">${p.key}</span>${p.connector ? html` for <span class="mono">${p.connector}</span>` : ""}, which isn't set.`
    : html`The keychain holding this step's keys was locked, or waiting for you to allow access, when it ran. Unlock it (log in to your desktop, or answer the keychain's window), then run it again.`;
  return html`<div class="note connect-prompt" role="note"><span>${msg}</span> ${!p.locked && html`<a class="btn" href="#/connectors">${p.missing ? "Connect" : p.tools ? "See it" : "Set it up"} on the connectors page</a>`}</div>`;
}

function ConnectorsPage() {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api("/api/connectors").then((r) => { setData(r); tellBar("connectors", r); }); }, [tick]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const v = DD.asConnectors(data.data);
  if (!v) return html`<p class="error">The server's answer wasn't understood.</p>`;
  const refresh = () => setTick((t) => t + 1);
  const missing = DD.keysMissing(v);
  return html`
    <h2>Connectors</h2>
    <p class="lede">Services agent steps can use, each through its MCP server, only as a step's arguments grant. Add one from the MCP Registry, or list it in your connectors file. Keys you save here go straight to this machine's keychain, are used from the next step with no restart, and are never shown again.</p>
    ${missing > 0 && html`<p class="note">${missing} key${missing === 1 ? " isn't" : "s aren't"} set yet.</p>`}
    <${AddConnector} onDone=${refresh} taken=${v.connectors.map((c) => c.name)} />
    <div class="panel connector">
      <div class="pills"><strong>Claude</strong><${Pill} cls="k-agent" plain>ask and agent steps<//></div>
      <${KeyRow} k=${v.anthropic} onDone=${refresh} />
    </div>
    ${v.error && html`<p class="error mono" role="alert">${v.file}: ${v.error}. No connector is used until it's fixed.</p>`}
    ${v.unreadable > 0 && html`<p class="error" role="alert">${v.unreadable} connector${v.unreadable === 1 ? "" : "s"} couldn't be shown.</p>`}
    ${v.connectors.length === 0 && !v.error && html`<div class="panel muted" style=${{ marginTop: "12px" }}>
      No connectors yet. They're listed in <span class="mono">${v.file || "the worker's -connectors file"}</span>, which the worker reads before every step:
      <pre>${'{"connectors": [\n  {"name": "maps", "url": "<the MCP server\'s address>", "tokenEnv": "MAPS_KEY"}\n]}'}</pre></div>`}
    ${v.connectors.map((c) => html`
      <div class="panel connector" key=${c.name}>
        <div class="pills">
          <strong class="mono">${c.name}</strong>
          <${Pill} cls="k-other" plain>${c.url ? "remote" : "local container"}<//>
          ${c.signedIn && html`<${Pill} cls="s-Completed">signed in; heedle refreshes its token<//>`}
          ${(c.writes || []).length > 0 && html`<${Pill} cls=${c.approve ? "s-Running" : "k-other"} plain>${c.writes.length} write${c.writes.length === 1 ? "" : "s"}${c.approve ? ", each waits for your approval" : ""}<//>`}
          <${RemoveConnector} name=${c.name} onDone=${refresh} />
        </div>
        <p class="mono muted cg-wrap">${c.url || [c.image, ...(c.command || [])].join(" ")}</p>
        ${(c.tools || []).length > 0 && html`<p class="muted">Tools: <span class="mono">${c.tools.join(", ")}</span></p>`}
        ${c.secrets.length === 0 ? html`<p class="muted">Needs no key.</p>` : c.secrets.map((k) => html`<${KeyRow} key=${k.name} k=${k} onDone=${refresh} />`)}
      </div>`)}`;
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
function AddSkill({ onDone, library }) {
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
      <div class="tabs" role="tablist">${tab("import", "Import a link")}${tab("browse", "Browse a repository")}${tab("paste", "Paste a SKILL.md")}${tab("upload", "Upload a folder")}${tab("create", "Describe a skill")}</div>
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
      ${mode === "browse" && html`<${BrowseRepo} onDone=${onDone} library=${library} />`}
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

// BrowseRepo lists a repository's skills (on a worker) and imports the
// ones chosen, one by one, each through the ordinary import: from a
// repository that isn't trusted, each waits for review.
function BrowseRepo({ onDone, library }) {
  const [link, setLink] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState("");
  const [cat, setCat] = useState(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(() => new Set());
  const [done, setDone] = useState({});
  const keyOf = (e) => e.source.repo + "#" + (e.source.path || "");
  const list = async () => {
    setBusy("list"); setError(""); setCat(null); setChosen(new Set()); setDone({});
    const r = await api("/api/skills/catalog", { link, branch });
    setBusy("");
    const c = r.ok ? DD.asCatalog(r.data) : null;
    if (c) setCat(c); else setError((r.data && r.data.error) || String(r.data));
  };
  // Of several skills with one name, at most one is chosen.
  const toggle = (e) => setChosen((s) => {
    const n = new Set(s), k = keyOf(e);
    if (n.has(k)) n.delete(k);
    else { cat.entries.forEach((o) => o.name === e.name && n.delete(keyOf(o))); n.add(k); }
    return n;
  });
  const importChosen = async () => {
    setBusy("import");
    for (const e of cat.entries.filter((e) => chosen.has(keyOf(e)))) {
      const r = await api("/api/skills/import", { link: e.source.repo, path: e.source.path || "", branch: e.source.ref || "" });
      const sk = r.ok ? DD.asSkill(r.data.skill) : null;
      // The import fetches the branch as it is now: say if that isn't
      // what was listed (review 24).
      const moved = sk && sk.source && e.source.commit && sk.source.commit && sk.source.commit !== e.source.commit;
      setDone((d) => ({ ...d, [keyOf(e)]: sk ? { skill: sk, moved } : { error: (r.data && r.data.error) || String(r.data) } }));
    }
    setBusy(""); setChosen(new Set()); onDone();
  };
  const notes = cat ? DD.catalogNotes(cat.entries, library) : {};
  // "Choose all" takes the first of each name.
  const usable = cat ? cat.entries.filter((e, i, all) => !e.problem && all.findIndex((o) => !o.problem && o.name === e.name) === i) : [];
  return html`
    <div class="row">
      <label>A GitHub link or https:// repository of skills<input type="text" value=${link} onInput=${(e) => setLink(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter" && link.trim() && !busy) list(); }}
        placeholder="github.com/anthropics/skills" /></label>
      <label style=${{ flex: "0 1 140px" }}>Branch or tag<input type="text" value=${branch} onInput=${(e) => setBranch(e.target.value)} /></label>
    </div>
    <div class="row"><button class="primary" disabled=${!!busy || !link.trim()} onClick=${list}>${busy === "list" ? "Listing its skills…" : "List its skills"}</button>
      <span class="muted">A worker fetches only the SKILL.md files. Nothing is imported until you choose.</span></div>
    ${error && html`<p class="error">${error}</p>`}
    ${cat && html`
      <div class="catalog">
        <div class="catalog-head">
          <strong>${cat.entries.length} skill${cat.entries.length === 1 ? "" : "s"}</strong>${cat.omitted ? html` <span class="muted">(and ${cat.omitted} more not listed)</span>` : ""}
          <button class="link" onClick=${() => setChosen(chosen.size ? new Set() : new Set(usable.map(keyOf)))}>${chosen.size ? "Choose none" : "Choose all"}</button>
          <button class="primary" style=${{ marginLeft: "auto" }} disabled=${!!busy || chosen.size === 0} onClick=${importChosen}>
            ${busy === "import" ? "Importing…" : `Import ${chosen.size || ""} skill${chosen.size === 1 ? "" : "s"}`}</button>
        </div>
        <ul class="catalog-list">${cat.entries.map((e) => {
          const k = keyOf(e), d = done[k];
          return html`<li key=${k} class=${e.problem ? "catalog-bad" : ""}>
            <label><input type="checkbox" disabled=${!!e.problem || !!busy} checked=${chosen.has(k)} onChange=${() => toggle(e)} />
              <span class="mono catalog-name">${e.name || e.source.path}</span></label>
            <span class="catalog-desc"><span class="catalog-text">${e.problem ? html`<span class="error">${e.problem}</span>` : e.description}</span>
              ${notes[k] && html`<span class="catalog-note">${notes[k].text}</span>`}</span>
            <span class="catalog-state">${d && d.moved ? html`<span class="catalog-note">changed since it was listed </span>` : ""}${d && d.skill ? (d.skill.pending
              ? html`<a href=${"#/review/" + encodeURIComponent(d.skill.name)}><${Pill} cls="s-Running">waiting for review<//></a>`
              : html`<a href=${"#/skill/" + encodeURIComponent(d.skill.name)}><${Pill} cls="s-Completed">added<//></a>`)
              : d && d.error ? html`<span class="error">${d.error}</span>` : html`<span class="muted mono">${e.source.path || "/"}</span>`}</span>
          </li>`;
        })}</ul>
      </div>`}`;
}

function SkillsPage() {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api("/api/skills").then((r) => { setData(r); tellBar("skills", r); }); }, [tick]);
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<p class="error">${data.data.error}</p>`;
  const skills = (data.data.skills || []).map(DD.asSkill).filter(Boolean);
  const pending = (data.data.pending || []).map(DD.asSkill).filter((s) => s && s.pending === true);
  const problems = (data.data.problems || []).filter((p) => typeof p === "string");
  return html`
    <h2>Skills</h2>
    <p class="lede">What steps can do by name: each skill is a folder whose SKILL.md tells Claude how. A program that uses one pins its exact version.</p>
    <${AddSkill} onDone=${() => setTick((t) => t + 1)} library=${skills} />
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
      ${cur && cur.connectors && html`<${SkillConnectors} grant=${cur.connectors} />`}
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
      <p class="muted cg-wrap">Or at the terminal: <code>loom skills -store DIR -approve ${at}${replaces ? " -replacing " + replaces : ""}</code> or <code>-reject ${at}</code></p>
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

// === Memory (roadmap 10.1) ==================================================
// What heedle remembers about you, word for word: it goes to Claude with
// every request to Ask heedle, as facts about you, never as instructions.
// Nothing is remembered until you say so (Remember here or on a card), and
// Forget takes it out of the file. Every change says what it was based on,
// so a hand edit made while this page was open is never overwritten.

function MemoryPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(null); // {id, text}
  const [sure, setSure] = useState(false);
  const load = async () => {
    const r = await api("/api/memory");
    const v = r.ok ? DD.asMemory(r.data) : null;
    setData(v ? { ok: true, v } : { ok: false, error: (r.data && r.data.error) || "The answer wasn't understood.", unreadable: !!(r.data && r.data.unreadable) });
    return v;
  };
  useEffect(() => { load(); }, []);
  // What was forgotten leaves the conversation kept for this tab too: what
  // a turn made with it proposed may repeat it (review 47).
  const forgotten = (ids) => {
    try { sessionStorage.setItem("drawdown.ask", JSON.stringify(DD.forgetInConversation(sessionStorage.getItem("drawdown.ask"), ids))); } catch {}
  };
  if (!data) return html`<p class="muted">Loading…</p>`;
  if (!data.ok) return html`<h2>Memory</h2><p class="error" role="alert">${data.error}</p>
    ${data.unreadable && html`<p>heedle can't read its memory file, so it sends nothing to Claude until it's fixed by hand, or emptied.
      ${sure ? html` <button type="button" onClick=${async () => { setSure(false); const r = await api("/api/memory/forget-all", {}); if (r.ok) { try { sessionStorage.removeItem("drawdown.ask"); } catch {} } else setErr((r.data && r.data.error) || String(r.data)); await load(); }}>Empty it</button> <button type="button" onClick=${() => setSure(false)}>Keep it</button>`
        : html` <button type="button" class="link-btn" onClick=${() => setSure(true)}>Empty the memory file</button>`}</p>`}
    ${err && html`<p class="error" role="alert">${err}</p>`}`;
  const { memories, version, file } = data.v;
  const change = async (op, body) => {
    setErr("");
    const r = await api("/api/memory/" + op, { ...body, version });
    if (r.ok) {
      if (op === "forget") forgotten([body.id]);
      if (op === "forget-all") forgotten(memories.map((m) => m.id));
      const v = DD.asMemory(r.data);
      if (v) setData({ ok: true, v }); else await load();
      return true;
    }
    // Changed elsewhere (by hand?): show what the file holds now.
    if (r.status === 409) await load();
    setErr((r.data && r.data.error) || String(r.data));
    return false;
  };
  const add = async (e) => {
    e.preventDefault();
    if (text.trim() && await change("add", { text })) setText("");
  };
  return html`
    <h2>Memory</h2>
    <p class="lede">What heedle remembers about you. It goes to Claude with every request to <strong>Ask heedle</strong>, word for word as below, as facts about you, never as instructions, and each proposal says how many it used. Nothing is remembered until you say so. <strong>Forget</strong> takes it out of ${file ? html`<span class="mono memory-file">${file}</span>` : "heedle's memory file"}, the only place heedle keeps it, and later requests send nothing of it. What you asked before, and what heedle proposed with it, stay in Temporal's history, and runs you started stay in their records.</p>
    <p class="muted">Claude sees everything here, so details for forms, such as your address or a card, don't belong in it: they'll belong in your profile, which Claude never sees, once heedle has one. heedle refuses anything that looks like a key, a card number or a password.</p>
    ${data.v.problem && html`<p class="error" role="alert">heedle sends nothing to Claude until this is fixed: ${data.v.problem}.</p>`}
    ${err && html`<p class="error" role="alert">${err}</p>`}
    ${file ? html`<form class="row memory-add" onSubmit=${add}>
      <label class="sr" for="memory-new">Something for heedle to remember</label>
      <input id="memory-new" type="text" value=${text} placeholder="Vegetarian. Home airport: IAD." onInput=${(e) => setText(e.target.value)} />
      <button class="primary" type="submit" disabled=${!text.trim()}>Remember</button>
    </form>` : html`<div class="panel muted">This server keeps no memory: give it <span class="mono">-memory FILE</span>.</div>`}
    ${file && memories.length === 0 && html`<div class="panel muted">heedle remembers nothing about you yet.</div>`}
    ${memories.length > 0 && html`<ul class="memories" aria-label="What heedle remembers">
      ${memories.map((m) => html`<li class="panel memory" key=${m.id}>
        ${editing && editing.id === m.id ? html`
          <form class="row" onSubmit=${async (e) => { e.preventDefault(); if (await change("edit", { id: m.id, text: editing.text })) setEditing(null); }}>
            <label class="sr" for=${"edit-" + m.id}>Change what heedle remembers</label>
            <input id=${"edit-" + m.id} type="text" value=${editing.text} onInput=${(e) => setEditing({ id: m.id, text: e.target.value })} />
            <button class="primary" type="submit" disabled=${!editing.text.trim()}>Save</button>
            <button type="button" onClick=${() => setEditing(null)}>Cancel</button>
          </form>` : html`<p class="memory-text">${m.text}</p>`}
        ${m.problem && html`<p class="error">Not sent to Claude: ${m.problem}. Edit it, or forget it.</p>`}
        <div class="pills">
          <span class="muted">added ${when(m.added)}; ${m.used ? `last used ${when(m.used)}` : "not used yet"}</span>
          <span style=${{ marginLeft: "auto" }} class="pills">
            ${!(editing && editing.id === m.id) && html`<button type="button" onClick=${() => setEditing({ id: m.id, text: m.text })}>Edit</button>`}
            <button type="button" onClick=${() => change("forget", { id: m.id })}>Forget</button>
          </span>
        </div>
      </li>`)}
    </ul>
    <p>${sure ? html`<span>Forget all ${memories.length}? This can't be undone.</span> <button type="button" onClick=${async () => { setSure(false); await change("forget-all", {}); }}>Forget everything</button> <button type="button" onClick=${() => setSure(false)}>Keep them</button>`
      : html`<button type="button" class="link-btn" onClick=${() => setSure(true)}>Forget everything</button>`}</p>`}`;
}

// RememberBar is a proposal's suggestions of things to remember, each with
// Remember and Not now. Ignoring them changes nothing: the proposal runs
// the same either way.
function RememberBar({ texts }) {
  // Not now is kept for the tab, so the card doesn't ask again on return.
  const [state, setState] = useState(() => {
    try { return Object.fromEntries(DD.notNow(sessionStorage.getItem("drawdown.notnow")).filter((t) => texts.includes(t)).map((t) => [t, "no"])); } catch { return {}; }
  }); // text -> "saving" | "saved" | "no" | error
  const notNow = (t) => {
    setState((s) => ({ ...s, [t]: "no" }));
    try { sessionStorage.setItem("drawdown.notnow", JSON.stringify(DD.notNow(sessionStorage.getItem("drawdown.notnow"), t))); } catch {}
  };
  if (!texts.length) return null;
  const remember = async (t) => {
    setState((s) => ({ ...s, [t]: "saving" }));
    const r = await api("/api/memory/add", { text: t });
    setState((s) => ({ ...s, [t]: r.ok ? "saved" : { error: (r.data && r.data.error) || String(r.data) } }));
  };
  return html`<ul class="remember" aria-label="heedle could remember">
    ${texts.map((t) => {
      const st = state[t];
      if (st === "no") return null;
      return html`<li key=${t}>
        <span class="muted">Remember for next time?</span> <q>${t}</q>
        ${st === "saved" ? html`<span role="status">Remembered. <a href="#/memory">See what heedle remembers</a></span>`
          : html`<button type="button" class="primary" disabled=${st === "saving"} onClick=${() => remember(t)}>Remember</button>
            <button type="button" disabled=${st === "saving"} onClick=${() => notNow(t)}>Not now</button>`}
        ${st && st.error && html`<span class="error" role="alert">${st.error}</span>`}
      </li>`;
    })}
  </ul>`;
}

// UsedMemory says that a request went to Claude with what heedle
// remembers, linking to it.
function UsedMemory({ ids }) {
  const line = DD.usedMemory(ids);
  return line ? html`<p class="used-memory"><a href="#/memory">${line}</a></p>` : null;
}

// === The front door ========================================================
// Ask heedle in plain words. A worker's Claude proposes what heedle would
// do (a program, a schedule if you said when, or a skill to create), and
// the worker says whether it can run now. Nothing runs until Run or the
// schedule button, which are the ordinary run and schedule.

const ASK_EXAMPLES = [
  "Plan three days in Lisbon from 12 December. I like food, tiles and viewpoints.",
  "Every weekday at 8, check whether shipment 4471 will be late.",
  "Read the three shipment sources and tell me if the shipment will be late.",
];

function FrontDoor({ history }) {
  // The conversation outlives a visit to the connectors page (Connect)
  // and back, for this tab only (review 34).
  const [conv, setConv] = useState(() => {
    try { return DD.restoreConversation(sessionStorage.getItem("drawdown.ask")); } catch { return []; }
  });
  useEffect(() => { try { sessionStorage.setItem("drawdown.ask", JSON.stringify(conv.slice(-10))); } catch {} }, [conv]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const ask = async (request) => {
    request = request.trim();
    if (!request || busy) return;
    setBusy(true);
    const body = { request, earlier: DD.earlierTurns(conv), today: DD.localDay(new Date()), timeZone: localZone() };
    const r = await api("/api/ask", body);
    setBusy(false);
    const proposal = r.ok ? DD.asProposal(r.data) : null;
    // What you typed stays until it's answered (review 33).
    if (proposal) setText("");
    setConv((c) => [...c, proposal ? { request, proposal } : { request, error: (r.data && r.data.error) || "The answer wasn't understood." }]);
  };
  const last = conv.length - 1;
  return html`
    <section class="front" aria-label="Ask heedle">
      <form class="front-ask" onSubmit=${(e) => { e.preventDefault(); ask(text); }}>
        <label for="ask" class="front-label">${conv.length ? "Change something, or ask for something else" : "What should heedle do?"}</label>
        <div class="front-row">
          <input id="ask" ref=${input} type="text" autocomplete="off" value=${text} disabled=${busy} onInput=${(e) => setText(e.target.value)}
            placeholder=${conv.length ? "Make it four days, or every Monday at 8" : "Plan three days in Lisbon from 12 December…"} />
          <button class="primary" type="submit" disabled=${busy || !text.trim()}>${busy ? "Thinking…" : "Ask"}</button>
        </div>
        ${!conv.length && !busy && html`<div class="front-examples">${ASK_EXAMPLES.map((e) => html`
          <button type="button" key=${e} class="chip" onClick=${() => { setText(e); input.current && input.current.focus(); }}>${e}</button>`)}</div>`}
      </form>
      ${conv.map((t, i) => html`<div class="turn" key=${i}>
        <p class="you"><span class="muted">You asked</span> ${t.request}</p>
        ${t.error ? html`<p class="error" role="alert">${t.error}</p>`
          : html`<${ProposalCard} p=${t.proposal} history=${history} latest=${i === last} />`}
      </div>`)}
      ${busy && html`<p class="muted" role="status">heedle is working out how to do that…</p>`}
      ${conv.length > 0 && !busy && html`<p><button class="link-btn" onClick=${() => setConv([])}>Start over</button></p>`}
    </section>`;
}

// ProposalCard is one proposal: what heedle would do, what it needs and
// whether that's there, the plan drawn as the program composes it, and
// what you can do with it.
function ProposalCard({ p, history, latest }) {
  const [ready, setReady] = useState(p.ready);
  const [shape, setShape] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const [name, setName] = useState(p.name);
  const check = async () => {
    const r = await api("/api/ready", { program: p.program });
    const v = r.ok && DD.asReadiness(r.data);
    // A program that no longer compiles (a skill removed) can't run; the
    // card never keeps an old "ready" (review 33).
    setReady(v || { needs: [], error: (r.data && r.data.error) || "the check wasn't understood", ready: false });
  };
  useEffect(() => {
    if (!p.program) return;
    api("/api/compile", { program: p.program }).then((r) => { if (r.ok && r.data.plan) setShape(r.data); });
    if (!latest) return;
    // Back from the connectors page, the card mounts again: check at once
    // (review 34), and again whenever the tab comes back (review 33).
    if (p.ready) check();
    const again = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [p.program, latest]);
  useEffect(() => {
    // A schedule of that name already: offer the next free one.
    if (!latest || !p.schedule) return;
    api("/api/schedules").then((r) => {
      const taken = r.ok ? DD.asSchedules(r.data).map((x) => x.name) : [];
      let n = p.name, i = 2;
      while (taken.includes(n)) n = `${p.name.slice(0, 36)}-${i++}`;
      setName(n);
    });
  }, [p.name, latest]);
  const run = async () => {
    setBusy("run"); setNote(null);
    const r = await api("/api/runs", { program: p.program, ref: history, actHosts: p.actHosts });
    setBusy("");
    if (r.ok) go("run", r.data.workflowId, r.data.runId);
    else setNote({ error: (r.data && r.data.error) || String(r.data) });
  };
  const schedule = async () => {
    setBusy("schedule"); setNote(null);
    const sp = p.schedule;
    const body = { name, program: p.program, ref: history, actHosts: p.actHosts, ...(sp.every ? { every: DD.goDuration(sp.every) } : { cron: sp.cron, timeZone: sp.timeZone || "" }) };
    const r = await api("/api/schedules", body);
    setBusy("");
    setNote(r.ok ? { ok: html`Scheduled <a href="#/schedules" class="mono">${name}</a>, ${DD.when(sp)}. Each run is recorded like any other.` }
      : { error: (r.data && r.data.error) || String(r.data) });
  };
  const teach = async () => {
    setBusy("teach"); setNote(null);
    const r = await api("/api/skills/create", { description: p.skill });
    setBusy("");
    const sk = r.ok ? DD.asSkill(r.data.skill) : null;
    setNote(sk ? { ok: html`Claude wrote the skill <a class="mono" href=${"#/review/" + encodeURIComponent(sk.name)}>${sk.name}</a>, with its test. Review it before anything can use it.` }
      : { error: (r.data && r.data.error) || String(r.data) });
  };
  const edit = () => { window.dispatchEvent(new CustomEvent("dd-program", { detail: p.program })); };
  const lines = DD.readyLines(ready);
  // Run only what the worker said can run now (review 33).
  const canRun = !!p.program && !!ready && ready.ready;
  // An earlier proposal is its summary, with the rest a click away.
  if (!latest) return html`
    <div class="panel proposal">
      <p class="summary">${p.summary}</p>
      <${UsedMemory} ids=${p.memory} />
      ${p.program && html`<details class="program"><summary>The program</summary><${Program} text=${p.program} /></details>`}
      ${p.skill && html`<p class="muted">${p.skill}</p>`}
    </div>`;
  return html`
    <div class=${"panel proposal" + (latest ? " latest" : "")}>
      <p class="summary">${p.summary}</p>
      <${UsedMemory} ids=${p.memory} />
      <${RememberBar} texts=${p.remember} />
      ${!p.program && !p.skill ? null : p.skill ? html`
        <div class="teach">
          <p class="muted">A skill that could do it:</p>
          <p>${p.skill}</p>
          ${latest && html`<button class="primary" disabled=${!!busy} onClick=${teach}>${busy === "teach" ? "Claude is writing it…" : "Teach heedle this skill"}</button>`}
        </div>` : html`
        ${lines.length > 0 && html`<ul class="needs" aria-label="What it needs">
          ${lines.map((l) => html`<li key=${l.what} class=${l.ok ? "ok" : "missing"}>
            <span class="mark" aria-hidden="true">${l.ok ? "✓" : "!"}</span>
            <span class="mono">${l.what}</span>
            <span>${l.ok ? "ready" : l.fix}</span>
            ${l.writes && html`<strong class=${l.asks ? "writes" : "writes unasked"}>${l.writes}</strong>`}
            ${!l.ok && l.href && html`<a class="btn" href=${l.href}>Connect</a>`}
          </li>`)}
        </ul>`}
        ${p.actHosts.length > 0 && html`<p class="acts" role="note"><strong>Its act steps can click, type and submit forms on ${p.actHosts.map((h, i) => html`${i ? ", " : ""}<span class="mono" key=${h}>${h}</span>`)} without asking again.</strong></p>`}
        ${!ready ? html`<p><button class="link-btn" onClick=${check}>Check whether it can run</button></p>`
          : !ready.ready && html`<p><button class="link-btn" onClick=${check}>Check again</button></p>`}
        ${shape && html`<${CompositionGraph} plan=${shape.plan} shape=${shape.shape} />`}
        <details class="program" open><summary>The program</summary><${Program} text=${p.program} /></details>
        ${latest && html`<div class="row">
          <button class="primary" disabled=${!canRun || !!busy} onClick=${run}>${busy === "run" ? "Starting…" : "Run it now"}</button>
          ${p.schedule && html`<button disabled=${!canRun || !!busy || !/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name)} onClick=${schedule}>${busy === "schedule" ? "Scheduling…" : `Run it ${DD.when(p.schedule)}`}</button>
            <label class="sched-name">as <input type="text" value=${name} aria-label="schedule name" onInput=${(e) => setName(e.target.value)} /></label>`}
          <button onClick=${edit}>Edit the program</button>
          ${!canRun && html`<span class="muted">Connect what's missing first.</span>`}
        </div>`}`}
      ${note && note.ok && html`<p role="status">${note.ok}</p>`}
      ${note && note.error && html`<p class="error" role="alert">${note.error}</p>`}
    </div>`;
}

// === New run ===============================================================

const TEMPLATES = {
  act: '(act "Fill in the form with the inputs, and submit it." "https://forms.example.org/")',
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
  const [scheduling, setScheduling] = useState(false);
  const [putBack, setPutBack] = useState(null);
  const editor = useRef(null);
  // Edit the program, from a proposal of the front door: into this editor.
  useEffect(() => {
    // What it replaces can be put back (review 33).
    const take = (e) => {
      if (typeof e.detail !== "string") return;
      setProgram((old) => { setPutBack(DD.replaced(old, e.detail)); return e.detail; });
      setTimeout(() => { const el = editor.current && editor.current.el(); el && el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50);
    };
    window.addEventListener("dd-program", take);
    return () => window.removeEventListener("dd-program", take);
  }, []);

  useEffect(() => {
    try { localStorage.setItem("drawdown.program", program); } catch {}
    if (!program.trim()) { setResult(null); return; }
    const t = setTimeout(async () => setResult(await api("/api/compile", { program })), 250);
    return () => clearTimeout(t);
  }, [program]);

  const run = async () => {
    setBusy(true); setSubmitError("");
    const r = await api("/api/runs", { program, ref, actHosts });
    setBusy(false);
    if (r.ok) go("run", r.data.workflowId, r.data.runId);
    else setSubmitError(r.data.error || String(r.data));
  };
  const insert = (text) => editor.current && editor.current.insert(text);

  const err = result && result.data && result.data.error ? result.data : null;
  const plan = result && result.ok && result.data.plan ? result.data.plan : null;
  // The last program that compiled stays drawn while a typo is fixed, so
  // what was folded or opened in it isn't lost.
  const lastGood = useRef(null);
  if (plan) lastGood.current = { plan, shape: result.data.shape };
  if (!program.trim()) lastGood.current = null;
  const shown = plan ? lastGood.current : err ? lastGood.current : null;
  const kinds = plan ? [...new Set((plan.nodes || []).map((n) => kindOf(n.activity)))] : [];
  // Where its act steps may act, shown above Run and sent with it: the
  // server starts nothing it wasn't (review 39).
  const actHosts = plan && DD.strsOf(result.data.actHosts);
  return html`
    <${Describe} program=${program} onProgram=${setProgram} />
    <div class="panel">
      <${ProgramEditor} value=${program} onChange=${setProgram} handle=${editor} placeholder='(pipe (par (echo "a") (echo "b")) echo)' />
      ${actHosts && actHosts.length > 0 && html`<p class="acts" role="note"><strong>Its act steps can click, type and submit forms on ${actHosts.map((h, i) => html`${i ? ", " : ""}<span class="mono" key=${h}>${h}</span>`)} without asking again.</strong></p>`}
      <div class="row">
        <button class="primary" disabled=${!plan || busy} onClick=${run}>${busy ? "Starting…" : "Run"}</button>
        <button disabled=${!plan || busy} onClick=${() => setScheduling((x) => !x)} aria-expanded=${scheduling}>Schedule…</button>
        ${Object.entries(info.examples || {}).map(([name, src]) => html`
          <button key=${name} onClick=${() => setProgram(src)}>Example: ${name}</button>`)}
      </div>
      ${scheduling && plan && html`<${ScheduleForm} program=${program} history=${ref} actHosts=${actHosts} onDone=${() => setScheduling(false)} />`}
      <div class="row">
        <span class="muted">Insert a command:</span>
        ${(info.commands || []).map((c) => {
          const kind = KIND_OF_COMMAND[c] || "other";
          return html`<${Tip} tag="button" key=${c} class=${"pill k-" + kind} color=${kindColor(kind)}
            content=${html`<${Card} title=${html`<${KindPill} kind=${kind}>${c}<//>`}><${Field} k="Inserts"><span class="mono">${TEMPLATES[c] || `(${c})`}</span><//><//>`}
            onClick=${() => insert(TEMPLATES[c] || `(${c})`)}>${c}<//>`;
        })}
      </div>
      ${putBack && html`<p class="muted">The program from Ask heedle replaced yours. <button class="link" onClick=${() => { setProgram(putBack); setPutBack(null); }}>Put back the program it replaced</button></p>`}
      ${err && html`<p class="error" role="alert">${err.line ? `line ${err.line}, column ${err.col}: ` : ""}${err.error}</p>`}
      ${submitError && html`<p class="error" role="alert">${submitError}</p>`}
      ${plan && html`
        <div class="row">
          <${Pill} cls="s-Completed">compiles<//>
          <${Pill} cls="k-other" plain>${plan.nodes.length} step${plan.nodes.length === 1 ? "" : "s"}<//>
          ${kinds.map((k) => html`<${KindPill} key=${k} kind=${k} />`)}
        </div>`}
      ${shown && html`<div class=${plan ? "" : "cg-stale"}><${CompositionGraph} plan=${shown.plan} shape=${shown.shape} /></div>`}
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

function Runs({ data, day }) {
  if (!data) return html`<p class="muted">Loading…</p>`;
  const runs = data.runs || [];
  const longest = Math.max(1, ...runs.map((r) => ms(r.start, r.close) || 0));
  return html`
    ${data.temporalError && html`<p class="error">Temporal: ${data.temporalError}</p>`}
    ${runs.length === 0 ? html`<p class="muted">${day ? "No runs on this day among the latest records." : "No runs yet."}</p>` : html`
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
        ${stepList.length > 0 && html`<${Pill} cls="k-other" plain>${stepList.length} step${stepList.length === 1 ? "" : "s"}<//>`}
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
    ${!rec && DD.stoppedBy(stepList).length > 0 && html`
      <h2>What went wrong</h2>
      <p class="lede">A run that fails leaves no record, so here is what Temporal says stopped it.</p>
      ${DD.stoppedBy(stepList).map((s) => html`<div class="panel went-wrong" key=${s.node}>
        <div class="pills"><span class="mono">${s.node}</span><${Pill} cls="s-Failed">${s.status === "TimedOut" ? "timed out" : "failed"}${s.attempts > 1 ? `, attempt ${s.attempts}` : ""}<//></div>
        <p class="mono cg-wrap">${s.failure}</p>
        <${ConnectPrompt} failure=${s.failure} />
      </div>`)}`}
    ${!rec && html`<p class="muted">${status === "Running" ? "Running… the record appears when the run finishes."
      : status === "Completed" ? "Recording…" : "No record: only completed runs are recorded."}</p>`}
    ${rec && html`
      <h2>Composition</h2>
      <p class="lede">The program as it was written: <span class="mono">;</span> runs one after another, <span class="mono">⊗</span> side by side. Hover an arrow for what it hands over; open a step for everything the record knows about it.</p>
      <div class="panel"><${CompositionGraph} plan=${rec.plan} shape=${rec.shape} rec=${rec} steps=${stepList}
        wf=${workflow} run=${run} temporalLink=${temporalLink} /></div>
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
  act: { where: "A fresh Podman container from the worker's browser-agent image, running Playwright MCP and a fresh Chromium profile, removed when the step ends; Claude, through Anthropic's SDK, decides each action", fs: "A brand-new browser profile, deleted with the container. Nothing is mounted from the machine, and it can't upload or download files", net: "Chromium is set to reach only the hosts the program names, refusing and recording every other request. Only the worker talks to the Claude API", gets: "Its instruction, start page and allowed hosts, from the program, and its inputs as cited sources. Claude may only read pages and work forms: no scripts, uploads or shell", leaves: "Claude's reply, every action with the page it left and a screenshot, the final page, the hosts it could reach, the requests blocked, and how it ended" },
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
  const { agent: agentOut, act: actOut } = DD.parse(out);
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
          <${ConnectPrompt} failure=${step.failure} />
          <div class="panel"><pre class="error">${step.failure}</pre>
            <p class="muted" style=${{ margin: "8px 0 0" }}>${step.status === "Completed" ? `Temporal retried it; attempt ${step.attempts} succeeded.` : "This is the last attempt's failure."}</p></div>`}
      </section>
      <section>
        <h3>Produced</h3>
        <p class="lede">Recorded in Git, and passed on to the steps that wait for it.</p>
        <div class="out" style=${{ "--c": kindColor(kind) }}><div class="body">${out == null ? html`<span class="muted">No output recorded.</span>`
          : agentOut ? html`<${AgentWork} agent=${agentOut} part="summary" />` : actOut ? html`<${ActWork} act=${actOut} part="summary" />` : html`<${Output} text=${out} />`}</div></div>
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

    ${actOut && html`
      <h3>Actions</h3>
      <p class="lede">Every action Claude took in the browser, in order, each with the page it left and what that page looked like.</p>
      <div class="panel"><${ActWork} act=${actOut} part="work" /></div>`}

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
  useEffect(() => setDay(""), [current]);
  const shown = runs && day ? { ...runs, runs: DD.onDay(runs.runs, day) } : runs;
  const dayName = day && new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return html`
    <${FrontDoor} history=${current} />
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
    <${Runs} data=${shown} day=${day} />`;
}

// === Top bar ===============================================================
// The sections, the current one marked, each with a count of what there
// needs you; then Temporal's Web UI, set apart as a tool outside drawdown.

const SECTION_LINKS = [
  { section: "runs", href: "#/", label: "Runs", dye: "source" },
  { section: "skills", href: "#/skills", label: "Skills", dye: "skill", need: (n) => `${n} waiting for review` },
  { section: "schedules", href: "#/schedules", label: "Schedules", dye: "record", need: (n) => `${n} paused after a failed or timed-out run` },
  { section: "connectors", href: "#/connectors", label: "Connectors", dye: "agent", need: (n) => `${n} key${n === 1 ? "" : "s"} to set` },
  { section: "memory", href: "#/memory", label: "Memory", dye: "ask" },
];

const COUNT = { skills: DD.skillsWaiting, schedules: DD.schedulesStopped, connectors: DD.keysToSet };

// tellBar hands the top bar an answer a section's page just loaded, so its
// count agrees with the page beside it, after an approval, a saved key or
// a resumed schedule too, with no request of its own (review 37).
const tellBar = (section, res) => dispatchEvent(new CustomEvent("drawdown:needs", { detail: { section, res } }));

// useNeeds fetches what needs you once on load and again each time the
// route changes, never on a timer, and takes each answer a section's page
// loads. An answer that fails or isn't understood is no count, never an
// error; a late answer to an earlier fetch is dropped.
function useNeeds(at) {
  const [needs, setNeeds] = useState({});
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    Promise.all([api("/api/skills"), api("/api/schedules"), api("/api/connectors")]).then(([sk, sc, co]) => {
      if (mine !== seq.current) return;
      setNeeds({ skills: COUNT.skills(sk), schedules: COUNT.schedules(sc), connectors: COUNT.connectors(co) });
    });
  }, [at]);
  useEffect(() => {
    const on = (e) => {
      const { section, res } = e.detail || {};
      if (Object.prototype.hasOwnProperty.call(COUNT, section)) setNeeds((n) => ({ ...n, [section]: COUNT[section](res) }));
    };
    addEventListener("drawdown:needs", on);
    return () => removeEventListener("drawdown:needs", on);
  }, []);
  return needs;
}

function TopBar({ section, at, temporalUI }) {
  const needs = useNeeds(at);
  // Temporal is after the nav, not in it: it isn't one of drawdown's
  // sections, and on a phone it can sit on the first row by itself.
  return html`<${React.Fragment}><nav class="topbar" aria-label="drawdown">
    <ul>
      ${SECTION_LINKS.map((s) => {
        const n = needs[s.section];
        const here = s.section === section;
        return html`<li key=${s.section}>
          <a href=${s.href} class=${here ? "here" : ""} style=${{ "--c": `var(--${s.dye})` }} aria-current=${here ? "page" : undefined}>
            ${s.label}${n > 0 && html`<span class="need" title=${s.need(n)}><span aria-hidden="true">${n}</span><span class="sr">(${s.need(n)})</span></span>`}
          </a></li>`;
      })}
    </ul>
  </nav>
  <a class="temporal" href=${temporalUI} target="_blank" rel="noopener">Temporal<span aria-hidden="true"> ↗</span><span class="sr"> (opens in a new tab)</span></a><//>`;
}

function App() {
  const route = useRoute();
  // What to show, which section of the top bar it's in, and whether the
  // header is an agent's, all come from DD.page, so they can't disagree
  // (DRAW-68; review 37: #/agent alone blanked the page).
  const pg = DD.page(route);
  const [info, setInfo] = useState(null);
  const [refs, setRefs] = useState([]);
  const [heads, setHeads] = useState({});
  const [tip, setTip] = useState(null);
  const [skillList, setSkillList] = useState([]);
  const tipApi = useRef({
    show: (el, content, color) => setTip({ rect: el.getBoundingClientRect(), content, color }),
    hide: () => setTip(null),
  }).current;
  const [ref, setRefState] = useState(() => {
    try { return localStorage.getItem("drawdown.ref") || ""; } catch { return ""; }
  });
  const setRef = (r) => { setRefState(r); try { localStorage.setItem("drawdown.ref", r); } catch {} };
  useEffect(() => { api("/api/info").then((r) => setInfo(r.data)); }, []);
  // Skills' descriptions, for a program's skill names: again on each page,
  // so a skill just added reads as one.
  useEffect(() => {
    api("/api/skills").then((r) => { if (r.ok) setSkillList(((r.data && r.data.skills) || []).map(DD.asSkill).filter(Boolean)); });
  }, [route.join("/")]);
  const commands = useMemo(() => {
    const desc = new Map(skillList.map((k) => [k.name, k.description]));
    const names = (info && Array.isArray(info.skills) ? info.skills : []).filter((n) => typeof n === "string");
    const about = {};
    if (info && info.about && typeof info.about === "object") for (const [k, v] of Object.entries(info.about)) if (typeof v === "string") about[k] = v;
    return { skills: new Map(names.map((n) => [n, desc.get(n) || ""])), about };
  }, [info, skillList]);
  useEffect(() => {
    let live = true, timer;
    const load = async () => {
      try { const r = await api("/api/refs"); if (live && r.ok) { setRefs(r.data.refs); setHeads(r.data.heads || {}); } } catch {}
      if (live) timer = setTimeout(load, 5000);
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  useEffect(() => { if (pg.name !== "agent") setTab("drawdown · agents", "#3b5bdb"); }, [pg.name]);
  useEffect(() => { setTip(null); }, [route.join("/")]);
  if (!info) return html`<main><p class="muted">Loading…</p></main>`;
  // A remembered ref that no longer exists falls back to the default.
  const current = refs.includes(ref) ? ref : info.ref;

  let body;
  switch (pg.name) {
    case "agent": body = html`<${AgentPage} agent=${route[1]} refs=${refs} heads=${heads} info=${info} />`; break;
    case "run": body = html`<${RunDetail} workflow=${route[1]} run=${route[2]} history=${current} />`; break;
    case "step": body = html`<${StepPage} key=${route.join("/")} workflow=${route[1]} run=${route[2]} node=${route[3]} history=${current} />`; break;
    case "diff": body = html`<${Diff} from=${route[1]} to=${route[2]} />`; break;
    case "skills": body = html`<${SkillsPage} />`; break;
    case "connectors": body = html`<${ConnectorsPage} />`; break;
    case "schedules": body = html`<${SchedulesPage} />`; break;
    case "memory": body = html`<${MemoryPage} />`; break;
    case "review": body = html`<${ReviewPage} key=${route[1]} name=${route[1]} />`; break;
    case "skill": body = html`<${SkillPage} key=${route.join("/")} name=${route[1]} version=${route[2]} />`; break;
    default: body = html`<${Home} info=${info} refs=${refs} heads=${heads} current=${current} />`;
  }

  const dyes = ["source", "assess", "browse", "ask", "record", "container", "echo", "source"];
  return html`
    <${TipContext.Provider} value=${tipApi}><${CommandsContext.Provider} value=${commands}>
    <header>
      <a class="brand" href="#/" aria-label="drawdown, home">
        <span class="swatch" aria-hidden="true">${dyes.map((k, i) => html`<i key=${i} style=${{ background: `var(--${k})` }}></i>`)}</span>
        <b>drawdown</b>
      </a>
      ${pg.name === "agent"
        ? html`<${Pill} cls="k-other" plain>agent <span class="mono">${agentName(route[1])}</span><//> <a href="#/">all agents</a>`
        : html`<label class="pills"><span class="muted">history</span>
            <select aria-label="history" value=${current} onChange=${(e) => setRef(e.target.value)}>
              ${(refs.length ? refs : [info.ref]).map((r) => html`<option key=${r} value=${r}>${agentName(r)}</option>`)}
            </select></label>`}
      <span class="spacer"></span>
      <${TopBar} section=${pg.section} at=${route.join("/")} temporalUI=${info.temporalUI} />
    </header>
    <main><${ErrorBoundary} route=${route.join("/")}>${body}<//></main>
    <${TipLayer} tip=${tip} />
    <//><//>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
