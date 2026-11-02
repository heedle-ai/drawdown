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
    { path: "x", size: 1, status: "added", blob: "../../api" }, { path: 1, size: 1, status: "added", blob: b("a") }, null, "x"]) {
    assert.deepEqual(DD.asFiles([bad]), [], JSON.stringify(bad));
  }
  for (const v of [undefined, null, {}, "x"]) assert.deepEqual(DD.asFiles(v), []);
  assert.equal(DD.fileSummary([]), "");
});
