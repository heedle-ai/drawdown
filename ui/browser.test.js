// Browser tests for the program viewer and editor (roadmap 9.4), run in CI
// with: node --test ui/browser.test.js (Playwright, with Chromium).
//
// They drive the real page against the real server (TestServeForBrowser:
// drawdown with the fake Temporal). Only /api/ask is answered here, since
// it needs a worker's Claude. The CDN files come from their npm packages,
// byte for byte what jsDelivr serves, so the page's integrity checks still
// hold and the tests need no CDN.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const ADDR = "127.0.0.1:" + (18000 + (process.pid % 1000));
const BASE = "http://" + ADDR;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "drawdown-browser-"));

// Every jsDelivr file the page loads, unpacked from npm.
const cdn = new Map();
function unpack(pkg) {
  if (!cdn.has(pkg)) {
    const dir = path.join(work, "cdn", pkg);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("npm", ["pack", "--silent", pkg], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    const tgz = fs.readdirSync(dir).find((f) => f.endsWith(".tgz"));
    execFileSync("tar", ["-xzf", tgz], { cwd: dir });
    cdn.set(pkg, path.join(dir, "package"));
  }
  return cdn.get(pkg);
}

let server, browser;
test.before(async () => {
  server = spawn("go", ["test", "-count=1", "-run", "^TestServeForBrowser$", "-timeout", "20m", "."], {
    cwd: ROOT, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DRAWDOWN_BROWSER_ADDR: ADDR, DRAWDOWN_BROWSER_DONE: path.join(work, "done"), DRAWDOWN_BROWSER_SOURCES: path.join(work, "sources") },
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE + "/api/info")).ok) break; } catch {}
    if (i > 600) throw new Error("the server didn't start");
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
});
test.after(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(work, "done"), "");
  await new Promise((r) => (server && server.exitCode === null ? server.on("exit", r) : r()));
  fs.rmSync(work, { recursive: true, force: true });
});

async function page({ program, ask, info, width = 1280 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, (r) => {
    const m = /\/npm\/((?:@[^/]+\/)?[^@/]+@[^/]+)\/(.*)$/.exec(r.request().url());
    const f = path.join(unpack(m[1]), m[2]);
    r.fulfill({ path: f, headers: { "access-control-allow-origin": "*", "content-type": f.endsWith(".css") ? "text/css" : "application/javascript" } });
  });
  if (info) await ctx.route("**/api/info", async (r) => { const res = await r.fetch(); r.fulfill({ response: res, json: { ...(await res.json()), ...info } }); });
  if (ask) await ctx.route("**/api/ask", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(ask) }));
  if (program !== undefined) await ctx.addInitScript((p) => { try { if (!sessionStorage.getItem("t")) { localStorage.setItem("drawdown.program", p); sessionStorage.setItem("t", "1"); } } catch {} }, program);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(BASE + "/#/");
  await p.locator("h2, h3").first().waitFor();
  return { p, ctx, errors };
}

const stored = (p) => p.evaluate(() => localStorage.getItem("drawdown.program"));

test("the editor keeps a program exactly as typed and pasted, IME input included", async () => {
  const { p, ctx, errors } = await page({ program: "" });
  const field = p.getByRole("textbox", { name: "program", exact: true });
  await field.click();
  // Typing: nothing auto-closed, indented or reformatted.
  const typed = '(pipe\n  (par (echo "a (b") (echo "c\\"d"))\n; note\necho)';
  await p.keyboard.type(typed);
  assert.equal(await stored(p), typed);
  // Paste: tabs, a carriage return, a line separator and other scripts arrive as they are.
  const pasted = '\n(echo "tab\there" "crlf\r\nend" "sep x" "日本語 ✓")';
  await p.evaluate((t) => navigator.clipboard.writeText(t), pasted);
  await p.keyboard.press("ControlOrMeta+V");
  assert.equal(await stored(p), typed + pasted);
  // IME: a composition becomes the committed text, once.
  const cdp = await ctx.newCDPSession(p);
  // Paced as a person composes: CodeMirror reads a finished composition
  // from the page a moment later (review 38: unpaced, it flaked).
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await p.waitForTimeout(80);
  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await p.waitForTimeout(80);
  await cdp.send("Input.insertText", { text: "日本" });
  await p.waitForFunction((want) => localStorage.getItem("drawdown.program") === want, typed + pasted + "日本", { timeout: 5000 });
  assert.equal(await stored(p), typed + pasted + "日本");
  // Undo takes back the last change, and the program follows.
  await p.keyboard.press("ControlOrMeta+Z");
  assert.notEqual(await stored(p), typed + pasted + "日本");
  // Tab indents; Esc, then Tab, leaves the editor.
  await p.keyboard.press("ControlOrMeta+Y");
  await p.keyboard.press("End");
  await p.keyboard.press("Tab");
  assert.ok((await stored(p)).endsWith("日本  "));
  await p.keyboard.press("Escape");
  await p.keyboard.press("Tab");
  assert.equal(await p.evaluate(() => !!document.activeElement.closest(".CodeMirror")), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the editor colours as the viewer does, and still compiles as you type", async () => {
  const { p, ctx, errors } = await page({ program: '(pipe (echo "a") ; c)\n echo' });
  // Unmatched: the comment swallowed the closing bracket, as draft reads it.
  await p.locator(".ed .unmatched").first().waitFor();
  assert.equal(await p.locator(".ed .cm").first().textContent(), "; c)");
  await p.locator("[role=alert]").first().waitFor(); // the compile error shows
  const field = p.getByRole("textbox", { name: "program", exact: true });
  await field.click();
  await p.keyboard.press("ControlOrMeta+End");
  await p.keyboard.type(")");
  await p.locator(".ed .unmatched").waitFor({ state: "detached" });
  await p.getByRole("button", { name: "Run", exact: true }).waitFor();
  await p.waitForFunction(() => !document.querySelector("[role=alert]"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Copy gives the exact program, whatever is folded", async () => {
  const long = "word ".repeat(80).trim();
  const program = `(pipe\n\t(agent "${long}" "browse") ; x\r\n  (ask "see https://example.org/a_(b) or javascript:alert(1)"))`;
  const plan = await (await fetch(BASE + "/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(agent "x")' }) })).json();
  const { p, ctx, errors } = await page({ ask: { summary: "A test.", program, plan: plan.plan } });
  await p.locator(".front-row input").fill("anything");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const card = p.locator(".proposal").first();
  const view = card.locator("pre.prog");
  await view.waitFor();
  assert.ok((await view.textContent()).length < program.length, "the long string is folded");
  await card.getByRole("button", { name: "Copy" }).click();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), program);
  // Only the https URL is a link, opened apart from this page.
  const links = await view.locator("a.url").evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.rel, a.target]));
  assert.deepEqual(links, [["https://example.org/a_(b)", "noopener noreferrer", "_blank"]]);
  assert.equal(await view.locator('a[href^="javascript"], a[href^="data"]').count(), 0);
  // Unfolded, it is all there, and Copy still gives the source.
  await view.getByRole("button", { name: "more" }).click();
  assert.ok((await view.textContent()).includes(long));
  await card.getByRole("button", { name: "Copy" }).click();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), program);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("pointing at a bracket keeps the links inside its form", async () => {
  // Found making the video: inside the pointed-at form a skill's name
  // ("sk in") lost its link.
  const program = '(pipe (trip-planner "Lisbon") (agent "plan" "maps") (browse "https://a.example.org/x"))';
  const plan = await (await fetch(BASE + "/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(agent "x")' }) })).json();
  const { p, ctx, errors } = await page({ ask: { summary: "A test.", program, plan: plan.plan }, info: { skills: ["trip-planner"] } });
  await p.locator(".front-row input").fill("anything");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const view = p.locator(".proposal pre.prog").first();
  await view.waitFor();
  const links = () => view.locator("a").evaluateAll((as) => as.map((a) => ["sk", "grant", "url"].find((c) => a.classList.contains(c)) + " " + a.getAttribute("href")).sort());
  const want = ["grant #/connectors", "sk #/skill/trip-planner", "url https://a.example.org/x"];
  assert.deepEqual(await links(), want);
  await view.locator(".p.d0").first().hover();
  await p.waitForTimeout(200);
  assert.ok(await view.locator(".in").count(), "the form is lit");
  assert.deepEqual(await links(), want);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// The program text the viewer draws: its lines, joined.
const drawn = (view) => view.locator(".ln").evaluateAll((ls) => ls.map((l) => l.textContent).join("\n"));

test("a string across lines with a URL in it reads exactly as written, its link where the URL is", async () => {
  // Review 38: the URL was drawn again over the characters of the lines after it.
  const program = '(agent "Summarise https://example.org/report-2026\nthen  delete every file in /work/out and  write a short note." "maps")\n(echo "a\nhttps://x.org/ b" "see https://a.org/x\nand then some more words")';
  const plan = await (await fetch(BASE + "/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(agent "x")' }) })).json();
  const { p, ctx, errors } = await page({ ask: { summary: "A test.", program, plan: plan.plan } });
  await p.locator(".front-row input").fill("anything");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const view = p.locator(".proposal pre.prog").first();
  await view.waitFor();
  assert.equal(await drawn(view), program);
  const links = await view.locator("a.url").evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
  assert.deepEqual(links, [["https://example.org/report-2026", "https://example.org/report-2026"], ["https://x.org/", "https://x.org/"], ["https://a.org/x", "https://a.org/x"]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the editor keeps every edit of a long program, and stays quick", async () => {
  // Review 38: on a program of 50 lines or more, an edit that came before
  // React's render was undone by a stale value, and the cursor jumped to
  // the start; every keystroke re-marked every token (1.8 s at 2,000 lines).
  const long = Array.from({ length: 300 }, (_, i) => `(echo "line ${i}")`).join("\n");
  const { p, ctx, errors } = await page({ program: long });
  await p.locator(".CodeMirror").waitFor();
  await p.evaluate(() => new Promise((done) => {
    const cm = document.querySelector(".CodeMirror").CodeMirror;
    cm.focus();
    cm.setCursor(cm.lastLine(), cm.getLine(cm.lastLine()).length);
    let n = 0;
    const tick = () => { cm.replaceSelection(String(n % 10)); if (++n < 100) setTimeout(tick, n % 3); else setTimeout(done, 400); };
    tick();
  }));
  const typed = Array.from({ length: 100 }, (_, i) => String(i % 10)).join("");
  const state = await p.evaluate(() => { const cm = document.querySelector(".CodeMirror").CodeMirror; return { v: cm.getValue(), cur: cm.indexFromPos(cm.getCursor()) }; });
  assert.equal(state.v, long + typed);
  assert.equal(state.cur, (long + typed).length, "the cursor stays where the typing is");
  assert.equal(await stored(p), long + typed);
  await ctx.close();

  // 2,000 lines: a keystroke is painted within 250 ms.
  const huge = Array.from({ length: 2000 }, (_, i) => `(pipe (echo "line ${i}") ; note ${i}\n  echo)`).join("\n");
  const b = await page({ program: huge });
  await b.p.locator(".CodeMirror").waitFor();
  const ms = await b.p.evaluate(async () => {
    const cm = document.querySelector(".CodeMirror").CodeMirror;
    cm.focus();
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frames();
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      cm.replaceSelection("x");
      await frames();
      worst = Math.max(worst, performance.now() - t);
    }
    return worst;
  });
  assert.ok(ms < 250, `a keystroke took ${Math.round(ms)} ms`);
  assert.deepEqual(errors.concat(b.errors), []);
  await b.ctx.close();
});

test("pointing at a bracket in a long program redraws quickly", async () => {
  // Review 38: every hover redrew all 2,000 lines (240 ms).
  const program = "(pipe\n" + Array.from({ length: 2000 }, (_, i) => `  (echo "line ${i}")`).join("\n") + ")";
  const plan = await (await fetch(BASE + "/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(agent "x")' }) })).json();
  const { p, ctx, errors } = await page({ ask: { summary: "A test.", program, plan: plan.plan } });
  await p.locator(".front-row input").fill("anything");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const view = p.locator(".proposal pre.prog").first();
  await view.waitFor();
  await p.waitForTimeout(500); // the page's first layout of 2,000 lines is not a hover
  const ms = await view.evaluate(async (pre) => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let worst = 0;
    for (const k of [11, 21, 31, 41]) {
      const el = pre.querySelectorAll("[data-i]")[k];
      const t = performance.now();
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await frames();
      if (!el.classList.contains("hot")) throw new Error("not lit");
      worst = Math.max(worst, performance.now() - t);
    }
    return worst;
  });
  assert.ok(ms < 120, `a hover took ${Math.round(ms)} ms`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("at phone width, a long URL in the editor doesn't scroll the page sideways", async () => {
  // Review 38: CodeMirror's longest unbroken run widened the page to 876 px.
  const { p, ctx, errors } = await page({ width: 375, program: '(echo "see https://www.museudoazulejo.gov.pt/averyveryverylongpathwithoutanybreaks/andmore/andmore/andmore")' });
  await p.locator(".CodeMirror").waitFor();
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a command inserted before the editor is clicked goes after the program", async () => {
  // Review 38: CodeMirror's cursor started at the beginning, so it went first.
  const { p, ctx, errors } = await page({ program: '(echo "mine")' });
  await p.locator(".CodeMirror").waitFor();
  await p.getByRole("button", { name: "echo", exact: true }).click();
  assert.equal(await stored(p), '(echo "mine")(echo "hello")');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Roadmap 9.5, 9.7: an act step's proposal says, before Run, where it may
// act and that it stops before sending and asks; one whose program lets it
// send without asking is said apart, in red.
test("a proposal with act steps discloses their hosts before Run, and sending without asking in red", async () => {
  const program = '(act "Join the volunteer list as Ada" "https://forms.example.org/volunteer" "cdn.example.org")';
  const plan = { nodes: [{ id: "n0", activity: "Act", args: ["Join the volunteer list as Ada", "https://forms.example.org/volunteer", "cdn.example.org"] }] };
  const { p, ctx, errors } = await page({ ask: { summary: "I'll put you on the volunteer list.", program, plan, actHosts: ["cdn.example.org", "forms.example.org"],
    ready: { needs: [], browserAgent: "this worker has no browser-agent image, so it can't run act steps: give heedle up -- -browser-agent-image ID", ready: false } } });
  await p.locator(".front-row input").fill("Sign me up as a volunteer");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const note = p.locator(".proposal .acts");
  await note.waitFor();
  assert.equal(await note.textContent(), "Its act steps can click and type on cdn.example.org, forms.example.org, and stop before sending and ask you.");
  const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
  const [asksColor, bad0] = await note.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue("--bad").trim()]);
  assert.notEqual(asksColor, rgb(bad0));
  {
    const free = await page({ ask: { summary: "I'll put you on the volunteer list.", program: program.replace(")", " :send-without-asking)"),
      plan: { nodes: [{ ...plan.nodes[0], args: [...plan.nodes[0].args, ":send-without-asking"] }] },
      actHosts: ["cdn.example.org", "forms.example.org"], actSendsFreely: ["cdn.example.org", "forms.example.org"], ready: { needs: [], ready: true } } });
    await free.p.locator(".front-row input").fill("Sign me up as a volunteer");
    await free.p.getByRole("button", { name: "Ask", exact: true }).click();
    const red = free.p.locator(".proposal .acts");
    await red.waitFor();
    assert.deepEqual(await red.allTextContents(), ["Its act steps can click, type and submit forms on cdn.example.org, forms.example.org without asking again."]);
    const [color, bad] = await red.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.documentElement).getPropertyValue("--bad").trim()]);
    assert.equal(color, rgb(bad));
    if (process.env.DRAWDOWN_SHOTS) await free.p.locator(".proposal").first().screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "act-card-freely.png") });
    assert.deepEqual(free.errors, []);
    await free.ctx.close();
  }
  // The disclosure comes before Run, and Run waits for the image.
  const before = await p.evaluate(() => {
    const acts = document.querySelector(".proposal .acts"), run = [...document.querySelectorAll(".proposal button")].find((b) => b.textContent === "Run it now");
    return !!run && !!(acts.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING) && run.disabled;
  });
  assert.ok(before);
  // The card checks again with the server: no browser-agent image here.
  await p.locator(".needs li.missing", { hasText: "-browser-agent-image" }).waitFor();
  assert.equal(await p.locator(".needs li.missing .mono").first().textContent(), "Act steps");
  if (process.env.DRAWDOWN_SHOTS) await p.locator(".proposal").first().screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "act-card.png") });
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Roadmap 9.5: a run's act step shows every action, in order, with the
// page it left and a screenshot of it.
test("an act step's page shows its actions in order, each with its screenshot", async () => {
  const sub = await (await fetch(BASE + "/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(echo "x")' }) })).json();
  const detailURL = `/api/runs/${encodeURIComponent(sub.workflowId)}/${encodeURIComponent(sub.runId)}`;
  for (let i = 0; ; i++) {
    const d = await (await fetch(BASE + detailURL)).json();
    if (d.record) break;
    if (i > 100) throw new Error("the run wasn't recorded");
    await new Promise((r) => setTimeout(r, 200));
  }
  const shotPage = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await shotPage.setContent('<body style="margin:0;background:#e9f0fb;font:20px sans-serif"><p style="padding:20px">Volunteer form</p></body>');
  const jpeg = "data:image/jpeg;base64," + (await shotPage.screenshot({ type: "jpeg", quality: 40 })).toString("base64");
  await shotPage.close();
  const act = {
    pirn: 1, model: "claude-sonnet-5-5", text: "You're on the volunteer list.\nResult: finished", stopReason: "end_turn", inputTokens: 900, outputTokens: 60,
    act: 1, image: "sha256:" + "b".repeat(64), turns: 4,
    calls: [
      { tool: "browser_navigate", input: '{"url":"https://forms.example.org/volunteer"}', output: "ok", url: "https://forms.example.org/volunteer", screenshot: jpeg },
      { tool: "browser_snapshot", input: "{}", output: '- textbox "Name" [ref=e2]', url: "https://forms.example.org/volunteer" },
      { tool: "browser_type", input: '{"target":"e2","text":"Ada"}', output: "ok", url: "https://forms.example.org/volunteer", screenshot: jpeg },
      { tool: "browser_click", input: '{"target":"e5"}', output: "ok", url: "https://forms.example.org/volunteer/done", screenshot: jpeg },
    ],
    url: "https://forms.example.org/volunteer/done", allowed: ["forms.example.org"], blocked: ["https://elsewhere.example.org/pixel"], blockedTotal: 1, inputs: [], ended: "finished",
  };
  const { p, ctx, errors } = await page({});
  await ctx.route("**" + detailURL + "*", async (r) => {
    const res = await r.fetch(), d = await res.json();
    d.record.plan.nodes = [{ id: "n0", activity: "Act", args: ["Join the volunteer list as Ada", "https://forms.example.org/volunteer"] }];
    d.record.outputs = { n0: JSON.stringify(act) };
    r.fulfill({ response: res, json: d });
  });
  await p.goto(BASE + "/#/step/" + [sub.workflowId, sub.runId, "n0"].map(encodeURIComponent).join("/"));
  const steps = p.getByRole("list", { name: "Actions" });
  await steps.waitFor();
  assert.deepEqual(await steps.locator(".act-head code").allTextContents(), ["navigate", "snapshot", "type", "click"]);
  assert.equal(await steps.locator("img.act-shot").count(), 3);
  await p.waitForFunction(() => [...document.querySelectorAll("img.act-shot")].every((i) => i.complete && i.naturalWidth === 320));
  await p.getByText("Claude said it finished").first().waitFor();
  // act's own dye, on the timeline and the step's pill.
  const dye = await p.evaluate(() => {
    const act = getComputedStyle(document.documentElement).getPropertyValue("--act").trim();
    const probe = document.createElement("i"); probe.style.color = act; document.body.append(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    return { act, want, line: getComputedStyle(document.querySelector(".act-steps li")).borderLeftColor, pill: getComputedStyle(document.querySelector(".pill.k-act")).getPropertyValue("--c").trim() };
  });
  assert.equal(dye.line, dye.want);
  assert.equal(dye.pill, dye.act);
  if (process.env.DRAWDOWN_SHOTS) await p.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "act-run.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Review 39: the editor's Run says where act steps may act, and sends
// those hosts; the server starts nothing it wasn't shown.
test("the editor shows where act steps may act, and Run sends those hosts", async () => {
  const program = '(act "Join the volunteer list as Ada" "https://forms.example.org/volunteer" "cdn.example.org")';
  const { p, ctx, errors } = await page({ program });
  const note = p.locator(".panel > .acts");
  await note.waitFor();
  assert.equal(await note.textContent(), "Its act steps can click and type on cdn.example.org, forms.example.org, and stop before sending and ask you.");
  let sent = null;
  await ctx.route("**/api/runs", (r) => { sent = r.request().postDataJSON(); r.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "not here" }) }); });
  await p.getByRole("button", { name: "Run", exact: true }).click();
  await p.getByText("not here").waitFor();
  assert.deepEqual(sent.actHosts, ["cdn.example.org", "forms.example.org"]);
  assert.equal(sent.actSendsFreely.length, 0);
  // Without the hosts shown, the real server refuses it.
  const res = await fetch(BASE + "/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program }) });
  assert.equal(res.status, 422);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Roadmap 9.7: a form an act step filled waits on the run page, with its
// screenshot, for Send or Cancel, which look like a write's Approve and
// Decline; deciding signals the run through /api/forms.
test("a run page shows a filled form waiting, with Send and Cancel", async () => {
  const sub = await (await fetch(BASE + "/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: '(echo "x")' }) })).json();
  const shotPage = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await shotPage.setContent('<body style="margin:0;background:#e9f0fb;font:20px sans-serif"><p style="padding:20px">Name: Ada</p></body>');
  const jpeg = "data:image/jpeg;base64," + (await shotPage.screenshot({ type: "jpeg", quality: 40 })).toString("base64");
  await shotPage.close();
  const frame = { activity: "3", kind: "act", attempt: 1, url: "https://forms.example.org/volunteer", image: jpeg,
    pending: { id: "f00d", node: "n0", summary: "Name: Ada. Sends the volunteer form.", url: "https://forms.example.org/volunteer" } };
  const { p, ctx, errors } = await page({});
  await ctx.route(new RegExp(`/api/runs/${encodeURIComponent(sub.workflowId)}/`), async (r) => {
    const res = await r.fetch(), d = await res.json();
    d.execution = { ...(d.execution || {}), status: "Running" }; delete d.record;
    r.fulfill({ response: res, json: d });
  });
  let decided = null;
  // The heartbeat lags the decision (review 41): the form still shows as
  // waiting after it's decided.
  await ctx.route("**/api/live/*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ frames: [frame] }) }));
  await ctx.route("**/api/forms/*", (r) => { decided = r.request().postDataJSON(); r.fulfill({ contentType: "application/json", body: JSON.stringify({ frames: [{ ...frame, pending: undefined }] }) }); });
  await p.goto(BASE + "/#/run/" + [sub.workflowId, sub.runId].map(encodeURIComponent).join("/"));
  const form = p.getByRole("group", { name: "A form waiting to be sent" });
  await form.waitFor();
  assert.match(await form.textContent(), /Name: Ada\. Sends the volunteer form\./);
  const send = form.getByRole("button", { name: "Send", exact: true }), cancel = form.getByRole("button", { name: "Cancel", exact: true });
  assert.equal(await send.getAttribute("class"), "primary");
  assert.equal(await cancel.getAttribute("class"), "reject");
  await p.locator(".live img").waitFor();
  if (process.env.DRAWDOWN_SHOTS) await p.locator(".live").first().screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "act-pending.png") });
  await send.click();
  await form.waitFor({ state: "detached" });
  assert.deepEqual(decided, { id: "f00d", send: true });
  await p.waitForTimeout(4500); // two more polls, still showing it waiting
  assert.equal(await form.count(), 0, "a decided form came back");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Roadmap 9.8: the card names the details act steps may use, and the
// Connectors page keeps them under You, shown only here.
test("the card names the details act steps may use, and You keeps them", async () => {
  const program = '(act "Send the contact form as me" "https://forms.example.org/contact" :uses "name email")';
  const plan = { nodes: [{ id: "n0", activity: "Act", args: ["Send the contact form as me", "https://forms.example.org/contact", ":uses", "name email"] }] };
  const { p, ctx, errors } = await page({ ask: { summary: "I'll send it as you.", program, plan, actHosts: ["forms.example.org"], actUses: ["name", "email"], ready: { needs: [], ready: true } } });
  await ctx.route("**/api/ready", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ needs: [], ready: true }) }));
  await p.locator(".front-row input").fill("Send the contact form as me");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  const note = p.locator(".proposal .acts", { hasText: "may use" });
  await note.waitFor();
  assert.equal(await note.textContent(), "They may use your name and email, from You. Claude never sees them.");
  let sent = null;
  await ctx.route("**/api/runs", (r) => { sent = r.request().postDataJSON(); r.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "not here" }) }); });
  await p.getByRole("button", { name: "Run it now" }).click();
  await p.getByText("not here").waitFor();
  assert.deepEqual(sent.actUses, ["name", "email"]);
  // You, on the Connectors page: kept here, in a keychain the test gives.
  let kept = {};
  await ctx.route(/\/api\/profile(\/delete)?$/, async (r) => {
    const req = r.request();
    if (req.method() === "POST") {
      const b = req.postDataJSON();
      if (req.url().endsWith("/delete")) delete kept[b.field]; else kept[b.field] = b.value;
    }
    const fields = ["name", "email", "phone", "address", "birthdate"].map((f) => ({ field: f, label: f, set: f in kept, value: kept[f] }));
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ fields }) });
  });
  await p.goto(BASE + "/#/connectors");
  const name = p.getByLabel("Your name");
  await name.waitFor();
  await name.fill("Ada Lovelace");
  await p.locator("#you form", { has: name }).getByRole("button", { name: "Save" }).click();
  await p.locator("#you form", { has: name }).getByRole("button", { name: "Forget" }).waitFor();
  assert.deepEqual(kept, { name: "Ada Lovelace" });
  assert.equal(await p.getByLabel("Your date of birth").inputValue(), "");
  if (process.env.DRAWDOWN_SHOTS) await p.locator("#you").screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "you.png") });
  await p.locator("#you form", { has: name }).getByRole("button", { name: "Forget" }).click();
  await p.locator("#you form", { has: name }).getByRole("button", { name: "Forget" }).waitFor({ state: "detached" });
  assert.deepEqual(kept, {});
  assert.deepEqual(errors, []);
  await ctx.close();
});
