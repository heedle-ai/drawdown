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

async function page({ program, ask, info, width = 1280, scheme = "light", hash = "#/" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: process.env.DRAWDOWN_SHOTS ? 2 : 1 });
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
  await p.goto(BASE + "/" + hash);
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

// Roadmap 10.1: memory you can see. A suggestion is remembered only on
// Remember; the memory page shows it word for word (never as HTML), edits
// and forgets it, never over a hand edit made while it was open.
test("Remember saves only on Remember, the memory page shows it as written, and Forget takes it out", async () => {
  const evil = '<img src=x onerror="window.pwned=1">Vegetarian, no fish';
  const memory = async () => (await (await fetch(BASE + "/api/memory")).json());
  const file = (await memory()).file;
  const plan = { nodes: [{ id: "n0", activity: "Echo", args: ["porto"] }] };
  const { p, ctx, errors } = await page({ ask: { summary: "A weekend in Porto, with vegetarian places.", program: '(echo "porto")', plan,
    remember: [evil, "Home airport: IAD."], memory: ["m0123456789ab"], ready: { needs: [], ready: true }, attempts: 1 } });
  await p.locator(".front-row input").fill("Plan a weekend in Porto, I'm vegetarian and don't eat fish");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  await p.locator(".remember li").first().waitFor();
  assert.equal(await p.locator(".used-memory a").textContent(), "Used 1 thing heedle remembers");
  assert.equal(await p.locator(".used-memory a").getAttribute("href"), "#/memory");
  assert.equal((await memory()).memories.length, 0, "nothing is remembered before Remember");
  // Not now: gone from the card, not remembered; the proposal still runs.
  await p.locator(".remember li", { hasText: "IAD" }).getByRole("button", { name: "Not now" }).click();
  assert.equal(await p.locator(".remember li", { hasText: "IAD" }).count(), 0);
  assert.equal(await p.getByRole("button", { name: "Run it now" }).isDisabled(), false);
  // Not now holds after a reload (review 47).
  await p.reload();
  await p.locator(".remember li").first().waitFor();
  assert.equal(await p.locator(".remember li", { hasText: "IAD" }).count(), 0);
  await p.locator(".remember li").getByRole("button", { name: "Remember" }).click();
  await p.locator(".remember [role=status]").waitFor();
  let m = await memory();
  assert.deepEqual(m.memories.map((x) => x.text), [evil]);
  // As written, everywhere: no image, no script.
  assert.equal(await p.locator(".proposal img").count(), 0);
  await p.evaluate(() => { location.hash = "#/memory"; });
  await p.locator(".memory-text").first().waitFor();
  assert.equal(await p.locator(".memory-text").first().textContent(), evil);
  assert.equal(await p.locator("main img").count(), 0);
  assert.equal(await p.evaluate(() => window.pwned), undefined);
  assert.equal(await p.locator('header a[aria-current="page"]').textContent(), "Memory");
  // Edit in place: new words are a new memory, so the tab's turns made
  // with the old ones go too (review 47).
  const before = (await memory()).memories[0].id;
  await p.evaluate((id) => sessionStorage.setItem("drawdown.ask", JSON.stringify([
    { request: "Plan Porto", proposal: { summary: "Porto, vegetarian.", program: '(echo "x")', plan: { nodes: [] }, memory: [id] } }])), before);
  await p.getByRole("button", { name: "Edit" }).click();
  await p.getByLabel("Change what heedle remembers").fill("Vegan.");
  await p.getByRole("button", { name: "Save" }).click();
  await p.locator(".memory-text", { hasText: "Vegan." }).waitFor();
  assert.notEqual((await memory()).memories[0].id, before);
  assert.deepEqual(await p.evaluate(() => JSON.parse(sessionStorage.getItem("drawdown.ask"))), []);
  // Edited by hand while the page is open: Forget is refused, the page
  // shows what the file holds now, and the hand edit stays.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Vegan.", "Vegan, but eats eggs."));
  await p.getByRole("button", { name: "Forget", exact: true }).click();
  await p.locator("main .error[role=alert]").waitFor();
  await p.locator(".memory-text", { hasText: "Vegan, but eats eggs." }).waitFor();
  assert.match(fs.readFileSync(file, "utf8"), /eats eggs/);
  // Now Forget: the turn made with it leaves the tab's conversation too
  // (review 47), and a hand edit into a secret says why it isn't sent.
  const id = (await memory()).memories[0].id;
  await p.evaluate((id) => sessionStorage.setItem("drawdown.ask", JSON.stringify([
    { request: "Plan Lisbon", proposal: { summary: "Lisbon, eggs but no meat.", program: '(echo "x")', plan: { nodes: [] }, memory: [id] } },
    { request: "hi", proposal: { summary: "Hello.", program: '(echo "hi")', plan: { nodes: [] } } }])), id);
  await p.getByRole("button", { name: "Forget", exact: true }).click();
  await p.getByText("heedle remembers nothing about you yet.").waitFor();
  assert.deepEqual(await p.evaluate(() => JSON.parse(sessionStorage.getItem("drawdown.ask")).map((t) => t.request)), ["hi"]);
  await p.getByLabel("Something for heedle to remember").fill("Window seat.");
  await p.locator(".memory-add").getByRole("button", { name: "Remember" }).click();
  await p.locator(".memory-text", { hasText: "Window seat." }).waitFor();
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Window seat.", "pw: hunter2"));
  await p.reload();
  await p.getByText(/Not sent to Claude: that looks like a password/).waitFor();
  await p.getByRole("button", { name: "Forget", exact: true }).click();
  await p.getByText("heedle remembers nothing about you yet.").waitFor();
  assert.ok(!fs.readFileSync(file, "utf8").includes("eggs"));
  for (const t of ["Home airport: IAD.", "Prefers trains to planes."]) {
    await p.getByLabel("Something for heedle to remember").fill(t);
    await p.locator(".memory-add").getByRole("button", { name: "Remember" }).click();
    await p.locator(".memory-text", { hasText: t }).waitFor();
  }
  if (process.env.DRAWDOWN_SHOTS) await p.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "memory-light.png"), fullPage: true });
  await p.getByRole("button", { name: "Forget everything" }).click();
  await p.getByRole("button", { name: "Forget everything" }).click();
  await p.getByText("heedle remembers nothing about you yet.").waitFor();
  assert.equal(fs.readFileSync(file, "utf8").trim(), "[]");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the memory page and a card's suggestions read well in dark mode, and at phone width", async () => {
  await fetch(BASE + "/api/memory/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Home airport: IAD." }) });
  await fetch(BASE + "/api/memory/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Vegetarian, and no fish either." }) });
  for (const [width, scheme] of [[1280, "dark"], [375, "light"], [375, "dark"]]) {
    const plan = { nodes: [{ id: "n0", activity: "Echo", args: ["lisbon"] }] };
    const { p, ctx, errors } = await page({ width, scheme, ask: { summary: "Three days in Lisbon, with vegetarian places, as you like.", program: '(echo "lisbon")', plan,
      remember: ["Likes azulejo tiles."], memory: ["m0123456789ab", "m0123456789ac"], ready: { needs: [], ready: true }, attempts: 1 } });
    await p.evaluate(() => { location.hash = "#/memory"; });
    await p.locator(".memory-text").first().waitFor();
    const sideways = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(sideways, 0, `${width}px ${scheme}: the memory page scrolls sideways`);
    if (process.env.DRAWDOWN_SHOTS) await p.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, `memory-${width}-${scheme}.png`), fullPage: true });
    await p.evaluate(() => { location.hash = "#/"; });
    await p.locator(".front-row input").fill("Plan three days in Lisbon");
    await p.getByRole("button", { name: "Ask", exact: true }).click();
    await p.locator(".remember li").waitFor();
    assert.equal(await p.locator(".used-memory a").textContent(), "Used 2 things heedle remembers");
    if (process.env.DRAWDOWN_SHOTS) await p.locator(".proposal").first().screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, `memory-card-${width}-${scheme}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const m = await (await fetch(BASE + "/api/memory")).json();
  await fetch(BASE + "/api/memory/forget-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: m.version }) });
});

// === Costs (roadmap 10.4) ===================================================

const post = async (url, body) => (await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
async function recorded(sub) {
  const url = `/api/runs/${encodeURIComponent(sub.workflowId)}/${encodeURIComponent(sub.runId)}`;
  for (let i = 0; ; i++) {
    const d = await (await fetch(BASE + url)).json();
    if (d.record) return d;
    if (i > 100) throw new Error("the run wasn't recorded");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const LISBON = '(pipe (ask "Plan three days in Lisbon from 12 December; I like food and tiles.") (agent "Find the tile museums and their opening hours."))';

// Roadmap 10.4: a run of the Lisbon trip shows its tokens per step and an
// estimated total, with the price table's date.
test("a run's page shows each Claude step's tokens and an estimated total", async () => {
  const sub = await post("/api/runs", { program: LISBON });
  const d = await recorded(sub);
  const hash = `#/run/${encodeURIComponent(sub.workflowId)}/${encodeURIComponent(sub.runId)}`;
  for (const scheme of ["light", "dark"]) {
    const { p, ctx, errors } = await page({ scheme, hash });
    const panel = p.locator(".panel.costs");
    await panel.waitFor();
    const rows = await panel.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim())));
    const steps = d.usage.steps;
    assert.deepEqual(rows, steps.map((s) => [`${s.node} ${s.kind}`, s.model, DDcount(s.tokens.input), DDcount(s.tokens.output), String(s.requests)]));
    assert.equal(await panel.locator(".cost-total").textContent(), `$${d.usage.cost.usd.toFixed(2)} est.`);
    assert.match(await p.locator("h2:has-text('Claude usage') + .lede").textContent(), /prices as of 2026-11-05/);
    assert.deepEqual(errors, []);
    if (process.env.DRAWDOWN_SHOTS) {
      await p.locator("h2", { hasText: "Claude usage" }).scrollIntoViewIfNeeded();
      const box = await p.locator("h2", { hasText: "Claude usage" }).boundingBox(), end = await panel.boundingBox();
      await p.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, `run-costs-${scheme}.png`), fullPage: true, clip: { x: 0, y: box.y - 16, width: 1280, height: end.y + end.height - box.y + 32 } });
    }
    await ctx.close();
  }
});
const DDcount = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Roadmap 10.4: the Costs page shows the month by model, with the price
// table's date; it fits a phone.
test("the Costs page shows this month by model, with the price table's date", async () => {
  await recorded(await post("/api/runs", { program: '(ask "What should I pack for Lisbon in December?")' }));
  for (const [width, scheme] of [[1280, "light"], [1280, "dark"], [375, "light"], [375, "dark"]]) {
    const { p, ctx, errors } = await page({ width, scheme, hash: "#/costs" });
    await p.locator("h2", { hasText: "Costs" }).waitFor();
    const month = new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
    const h3 = await p.locator(".panel.costs h3").first().textContent();
    assert.match(h3, new RegExp(`^${month}: \\$\\d+\\.\\d\\d est\\.$`), h3);
    const models = await p.locator(".panel.costs").first().locator("tbody td:first-child").allTextContents();
    assert.deepEqual(models, ["claude-sonnet-5-5"]);
    assert.match(await p.locator("h2 + .lede").textContent(), /prices as of 2026-11-05/);
    assert.equal(await p.locator("a[aria-current=page]").first().textContent(), "Costs");
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(over, 0, `${width}px scrolls sideways`);
    assert.deepEqual(errors, []);
    if (process.env.DRAWDOWN_SHOTS) await p.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, `costs-${width}-${scheme}.png`), fullPage: true });
    await ctx.close();
  }
});

// Roadmap 10.4: a budget set on the Schedules page pauses the schedule
// before its second run, and the page and the top bar say so.
test("a schedule's budget is set on its page, and pauses it before its second run", async () => {
  const made = await post("/api/schedules", { name: "lisbon-news", program: '(ask "What is new in Lisbon this week? Food, tiles and trams, please.")', every: "24h" });
  assert.equal(made.name, "lisbon-news");
  const { p, ctx, errors } = await page({ hash: "#/schedules" });
  const card = p.locator(".panel.connector", { hasText: "lisbon-news" });
  await card.getByLabel("Monthly budget, $").fill("0.01");
  await card.getByRole("button", { name: "Save" }).click();
  await card.locator("text=budget $0.01 a month").waitFor();
  for (let i = 0; i < 2; i++) {
    await card.getByRole("button", { name: "Run now" }).click();
    await p.waitForTimeout(400);
  }
  await card.locator("p.muted", { hasText: "paused: monthly budget $0.01 reached (est.)" }).waitFor({ timeout: 10000 });
  await p.waitForFunction(() => /^1/.test(document.querySelector('header a[href="#/schedules"] .need')?.textContent || ""), null, { timeout: 10000 });
  // The run it stopped says why, and isn't waited on.
  const s = (await (await fetch(BASE + "/api/schedules")).json()).schedules.find((x) => x.name === "lisbon-news");
  const last = s.recent[s.recent.length - 1];
  await p.goto(`${BASE}/#/run/${encodeURIComponent(last.workflowId)}/${encodeURIComponent(last.runId)}`);
  await p.locator("text=Not run: paused: monthly budget $0.01 reached (est.)").waitFor();
  assert.deepEqual(errors, []);
  if (process.env.DRAWDOWN_SHOTS) {
    await p.goto(BASE + "/#/schedules");
    await card.locator("p.muted", { hasText: "paused: monthly budget" }).waitFor();
    await card.screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, "schedule-budget-light.png") });
  }
  await ctx.close();
});

// === Share a skill (roadmap 10.6) ===========================================

const b64 = (s) => Buffer.from(s).toString("base64");
const postJSON = async (url, body) => (await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

// Roadmap 10.6: a skill's page has Share, which shows the command that
// publishes it, filled in, and, given your repository's link, the link a
// friend imports it with; the page runs nothing.
test("a skill's Share shows the publish command and the import link", async () => {
  const add = await postJSON("/api/skills/add", { files: { "SKILL.md": b64("---\nname: trip-planner\ndescription: Plans a trip day by day.\n---\nPlan it.\n") } });
  assert.ok(add.skill || add.name || add.version, JSON.stringify(add));
  const info = await (await fetch(BASE + "/api/skills/trip-planner")).json();
  for (const scheme of ["light", "dark"]) {
    const { p, ctx, errors } = await page({ scheme, hash: "#/skill/trip-planner" });
    const posts = [];
    p.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
    await p.getByRole("button", { name: "Share…" }).click();
    const cmd = p.locator("code.share-cmd");
    assert.equal(await cmd.textContent(), `heedle skills publish trip-planner -repo ~/src/my-skills -store ${info.store}`);
    await p.getByLabel("Your clone").fill("~/src/friends skills");
    assert.equal(await cmd.textContent(), `heedle skills publish trip-planner -repo ~/'src/friends skills' -store ${info.store}`);
    await p.getByLabel("Your repository's link").fill("https://github.com/ada/my-skills");
    assert.equal(await p.locator("code.share-link").textContent(), "https://github.com/ada/my-skills/tree/main/skills/trip-planner");
    await p.getByLabel("Your repository's link").fill("https://evil.example/x");
    assert.equal(await p.locator("code.share-link").count(), 0);
    await p.getByLabel("Your repository's link").fill("https://github.com/ada/my-skills");
    assert.deepEqual(posts, [], "Share sent nothing");
    assert.deepEqual(errors, []);
    if (process.env.DRAWDOWN_SHOTS) await p.locator(".panel.share").screenshot({ path: path.join(process.env.DRAWDOWN_SHOTS, `share-${scheme}.png`) });
    await ctx.close();
  }
});

// Roadmap 10.6: browsing a friend's repository, you pick several of its
// skills and each is imported pinned to the commit the catalog was read at.
test("picking several skills from a repository's catalog imports each at the commit listed", async () => {
  const commit = "a".repeat(40);
  const entry = (name) => ({ source: { repo: "https://github.com/ada/my-skills", path: "skills/" + name, commit }, name, description: "Does " + name + "." });
  const { p, ctx, errors } = await page({ hash: "#/skills" });
  const asked = [];
  await ctx.route("**/api/skills/catalog", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ entries: [entry("trip-planner"), entry("tile-hunt"), entry("tram-times")], omitted: 0 }) }));
  await ctx.route("**/api/skills/import", (r) => {
    const body = JSON.parse(r.request().postData());
    asked.push(body);
    const name = body.path.split("/").pop();
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ skill: { name, description: "Does " + name + ".", version: "b".repeat(40), commit: "c".repeat(40), pending: true,
      source: { repo: body.link, path: body.path, commit: body.commit } } }) });
  });
  await p.getByRole("tab", { name: "Browse a repository" }).click();
  await p.getByLabel("A GitHub link or https:// repository of skills").fill("https://github.com/ada/my-skills");
  await p.getByRole("button", { name: "List its skills" }).click();
  await p.locator(".catalog-list li").first().waitFor();
  await p.locator(".catalog-list li", { hasText: "trip-planner" }).getByRole("checkbox").check();
  await p.locator(".catalog-list li", { hasText: "tram-times" }).getByRole("checkbox").check();
  await p.getByRole("button", { name: "Import 2 skills" }).click();
  await p.locator(".catalog-list li", { hasText: "tram-times" }).locator(".catalog-state").filter({ hasText: /review/i }).waitFor();
  assert.deepEqual(asked.map((b) => [b.path, b.commit]), [["skills/trip-planner", commit], ["skills/tram-times", commit]]);
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
  await ctx.route("**/api/live/*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ frames: [decided ? { ...frame, pending: undefined } : frame] }) }));
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
  assert.deepEqual(errors, []);
  await ctx.close();
});
