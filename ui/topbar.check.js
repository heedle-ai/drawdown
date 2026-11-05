// The top bar, in a real browser (CI's topbar step):
//   node ui/topbar.check.js [screenshot-dir]
// It opens static/index.html in Chromium through Playwright, at 375 and
// 1280 px wide, in light and dark mode. The page's files come from
// static/, its CDN files from their npm packages (the files jsDelivr
// serves, so their integrity hashes still hold), and the API from the
// answers below: nothing else is reached. It checks that each route marks
// exactly its section, that the bar fits with no horizontal scroll, that
// the counts show only for answers that are understood, that Temporal is
// last and opens in a new tab, and that every link is reached by keyboard
// with visible focus. With a directory, it saves the screenshots there.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const STATIC = path.join(__dirname, "..", "static");
const ORIGIN = "http://drawdown.test";
const HEX = (c) => c.repeat(40);

// === Answers ===============================================================

const skill = { name: "summarise", description: "Summarise a page in three lines.", version: HEX("a"), commit: HEX("b") };
const waiting = { name: "triage-inbox", description: "Sort new mail into folders.", version: HEX("c"), commit: HEX("d"), pending: true,
  source: { repo: "https://github.com/example/skills", path: "triage-inbox", commit: HEX("e") } };
const schedule = (name, paused, note) => ({ name, program: "(echo \"hi\")", ref: "refs/loom/main", spec: { every: 3.6e12 },
  paused, note, next: paused ? [] : ["2026-11-05T09:00:00Z"], recent: [] });

const GOOD = {
  "/api/info": { ref: "refs/loom/main", temporalUI: "http://localhost:8233", namespace: "default", commands: ["echo", "source", "ask"], examples: {} },
  "/api/refs": { refs: ["refs/loom/main"], heads: {} },
  "/api/runs": { runs: [] },
  "/api/beliefs": { beliefs: [] },
  "/api/skills": { skills: [skill], pending: [waiting], problems: [] },
  "/api/memory": { memories: [], version: "", file: "/home/me/.heedle/memory.json" },
  [`/api/skills/${waiting.name}/review`]: { skill: waiting, files: [{ path: "SKILL.md", size: 120 }], diff: "", binary: [] },
  // Paused by a failed run (Temporal's two notes), by heedle, and running:
  // two need you.
  "/api/schedules": { schedules: [
    schedule("morning-brief", true, "paused due to workflow failure: sched-morning-brief-2026: activity failed"),
    schedule("weekly-report", true, "paused, workflow timedout: sched-weekly-report-2026"),
    schedule("digest", true, "paused from heedle"),
    schedule("hourly", false, ""),
  ] },
  // Claude's key is set; one connector's key and one sign-in are not.
  "/api/connectors": { file: "/home/me/.heedle/connectors.json", keychain: true, anthropic: { name: "ANTHROPIC_API_KEY", from: "keychain" },
    connectors: [
      { name: "maps", url: "https://maps.example/mcp", tools: [], writes: [], secrets: [{ name: "MAPS_KEY", from: "missing" }] },
      { name: "calendar", url: "https://cal.example/mcp", tools: [], writes: [], secrets: [{ name: "HEEDLE_CONNECTOR_CALENDAR_TOKEN", from: "missing" }] },
      { name: "files", url: "https://files.example/mcp", tools: [], writes: [], secrets: [{ name: "FILES_KEY", from: "environment" }] },
    ] },
};
const COUNTS = { Skills: "1", Schedules: "2", Connectors: "2" };

// BROKEN answers each count's request badly: an error, a malformed
// answer, and no answer at all.
const BROKEN = { ...GOOD, "/api/skills": { status: 500, body: { error: "treadle: the store is locked" } },
  "/api/schedules": { schedules: "not a list" }, "/api/connectors": "abort" };

// === The browser ===========================================================

// cdnFiles maps each jsDelivr URL in index.html to its npm package's file.
function cdnFiles() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "drawdown-cdn-"));
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
  const out = {};
  for (const [url, pkg, ver, file] of html.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/([^"']+)/g)) {
    const dir = path.join(work, `${pkg}@${ver}`.replace("/", "__"));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      const tgz = execFileSync("npm", ["pack", "--silent", `${pkg}@${ver}`], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop();
      execFileSync("tar", ["-xzf", tgz], { cwd: dir });
    }
    out[url] = path.join(dir, "package", file);
  }
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

async function open(browser, cdn, { width, scheme, answers, hash }) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (cdn[u.href]) return route.fulfill({ path: cdn[u.href], headers: { "Access-Control-Allow-Origin": "*", "Content-Type": TYPES[path.extname(u.pathname)] || "application/octet-stream" } });
    if (u.origin !== ORIGIN) return route.abort();
    if (u.pathname.startsWith("/api/")) {
      asked.push(u.pathname);
      const a = answers[u.pathname];
      if (a === "abort") return route.abort();
      if (a === undefined) return route.fulfill({ status: 404, json: { error: "not in this check" } });
      return a.status ? route.fulfill({ status: a.status, json: a.body }) : route.fulfill({ json: a });
    }
    const file = path.join(STATIC, u.pathname === "/" ? "index.html" : u.pathname);
    if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ path: file, headers: { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" } });
  });
  await page.goto(`${ORIGIN}/${hash}`);
  await page.waitForSelector("nav.topbar", { timeout: 15000 });
  return { ctx, page, errors, asked };
}

// bar reads the top bar as a person would see it.
const bar = (page) => page.evaluate(() => {
  const header = document.querySelector("header");
  const links = [...header.querySelectorAll("nav.topbar a, header > a.temporal")];
  const doc = document.documentElement;
  return {
    current: [...document.querySelectorAll("header [aria-current]")].map((a) => [a.textContent.replace(/\d.*$/, "").trim(), a.getAttribute("aria-current")]),
    items: links.map((a) => ({ text: a.childNodes[0] ? a.childNodes[0].textContent.trim() : "", href: a.getAttribute("href"), target: a.target, rel: a.rel,
      need: a.querySelector(".need") ? a.querySelector(".need").firstChild.textContent : "" })),
    last: links[links.length - 1] === header.lastElementChild,
    headerText: header.textContent,
    hrefs: [...header.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    overflow: doc.scrollWidth - doc.clientWidth,
    outside: [...document.querySelectorAll("header *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > doc.clientWidth + 0.5 || r.left < -0.5); }).map((e) => e.outerHTML.slice(0, 80)),
  };
});

const SECTION_OF = { "": "Runs", "#/": "Runs", "#/run/wf/run1": "Runs", "#/step/wf/run1/n0": "Runs", "#/diff/a/b": "Runs", "#/agent/refs%2Floom%2Fmain": "Runs",
  "#/skills": "Skills", "#/skill/summarise": "Skills", [`#/skill/summarise/${HEX("a")}`]: "Skills", [`#/review/${waiting.name}`]: "Skills",
  "#/schedules": "Schedules", "#/connectors": "Connectors", "#/memory": "Memory", "#/memory/extra": "Runs", "#/nowhere": "Runs", "#/constructor": "Runs", "#/skills/extra": "Runs",
  // Review 37: these blanked the page, or put an agent's header over the
  // home page.
  "#/agent": "Runs", "#/agent/refs%2Floom%2Fmain/extra": "Runs" };
const HOME_ROUTES = ["", "#/", "#/nowhere", "#/constructor", "#/skills/extra", "#/memory/extra", "#/agent", "#/agent/refs%2Floom%2Fmain/extra"];
const LONG_AGENT = "#/agent/refs%2Floom%2Fa-very-long-agent-branch-name-for-the-quarterly-report";

async function main() {
  // The version Contributing names, and CI's setup-node gives (review 37).
  assert.ok(+process.versions.node.split(".")[0] >= 22, `topbar: needs Node 22 or later, not ${process.versions.node}`);
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const cdn = cdnFiles();
  const browser = await chromium.launch();
  let checks = 0;
  try {
    // Each route marks exactly its own section.
    {
      const { ctx, page, errors } = await open(browser, cdn, { width: 1280, scheme: "light", answers: GOOD, hash: "" });
      for (const [hash, want] of Object.entries(SECTION_OF)) {
        await page.evaluate((h) => { location.hash = h; }, hash || "#/");
        await page.waitForFunction((w) => [...document.querySelectorAll("header [aria-current]")].some((a) => a.textContent.startsWith(w)), want);
        const b = await bar(page);
        assert.deepEqual(b.current, [[want, "page"]], `${hash}: marks ${JSON.stringify(b.current)}`);
        if (HOME_ROUTES.includes(hash)) {
          await page.waitForSelector("main h2");
          const home = await page.evaluate(() => ({ picker: !!document.querySelector("header select"), title: [...document.querySelectorAll("main h2")].some((h) => h.textContent === "Drawdown") }));
          assert.deepEqual(home, { picker: true, title: true }, `${hash}: the home page, with the history picker`);
        }
        assert.deepEqual(errors, [], `${hash}: page errors`);
        checks++;
      }
      await ctx.close();
    }
    for (const width of [1280, 375]) for (const scheme of ["light", "dark"]) for (const hash of ["#/", `#/review/${waiting.name}`, LONG_AGENT]) {
      const where = `${width}px ${scheme} ${hash}`;
      const { ctx, page, errors } = await open(browser, cdn, { width, scheme, answers: GOOD, hash });
      await page.waitForFunction(() => document.querySelectorAll("header .need").length === 3, null, { timeout: 15000 });
      if (hash.startsWith("#/review/")) await page.waitForSelector("main .step-hero");
      const b = await bar(page);
      assert.deepEqual(b.items.map((i) => i.text), ["Runs", "Skills", "Schedules", "Connectors", "Memory", "Temporal"], where);
      assert.deepEqual(b.items.slice(0, 5).map((i) => i.href), ["#/", "#/skills", "#/schedules", "#/connectors", "#/memory"], where);
      for (const i of b.items.slice(0, 5)) assert.equal(i.need || "", COUNTS[i.text] || "", `${where}: ${i.text}'s count`);
      // Each count is read once, with what it counts (review 37: twice).
      for (const name of ["Runs", "Skills (1 waiting for review)", "Schedules (2 paused after a failed or timed-out run)", "Connectors (2 keys to set)", "Memory"]) {
        assert.equal(await page.getByRole("link", { name, exact: true }).count(), 1, `${where}: no link named "${name}"`);
      }
      const t = b.items[5];
      assert.ok(b.last && t.href === GOOD["/api/info"].temporalUI && t.target === "_blank" && /noopener/.test(t.rel), `${where}: Temporal is last, in a new tab`);
      assert.ok(!/\d+ commands/.test(b.headerText), `${where}: the commands pill is gone`);
      for (const h of b.hrefs) assert.ok(h.startsWith("#/") || h === GOOD["/api/info"].temporalUI, `${where}: the header links to ${h}`);
      assert.equal(b.overflow, 0, `${where}: the page scrolls sideways by ${b.overflow}px`);
      assert.deepEqual(b.outside, [], `${where}: header parts outside the viewport`);
      // Every link by keyboard, each with a visible focus ring.
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.locator("header select, header .brand").first().focus();
      const reached = [];
      for (let i = 0; i < 14 && reached.length < 6; i++) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || !a.closest("nav.topbar, a.temporal")) return null;
          const s = getComputedStyle(a);
          return { text: a.childNodes[0].textContent.trim(), ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 };
        });
        if (f) { assert.ok(f.ring, `${where}: ${f.text} has no visible focus`); reached.push(f.text); }
      }
      assert.deepEqual(reached, ["Runs", "Skills", "Schedules", "Connectors", "Memory", "Temporal"], `${where}: keyboard order`);
      assert.deepEqual(errors, [], `${where}: page errors`);
      if (shots) {
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        const name = `${hash === "#/" ? "home" : hash === LONG_AGENT ? "agent" : "review"}-${width}-${scheme}.png`;
        await page.screenshot({ path: path.join(shots, name), clip: { x: 0, y: 0, width, height: width < 500 ? 640 : 420 } });
      }
      checks++;
      await ctx.close();
    }
    // A long agent name wraps at 320 px too (review 37: it scrolled).
    for (const scheme of ["light", "dark"]) {
      const { ctx, page } = await open(browser, cdn, { width: 320, scheme, answers: GOOD, hash: LONG_AGENT });
      await page.waitForFunction(() => document.querySelectorAll("header .need").length === 3);
      const b = await bar(page);
      assert.equal(b.overflow, 0, `320px ${scheme}: the agent page scrolls sideways by ${b.overflow}px`);
      assert.deepEqual(b.outside, [], `320px ${scheme}: header parts outside the viewport`);
      checks++;
      await ctx.close();
    }
    // A count follows its page: resuming a schedule there takes it off
    // the bar without leaving the page (review 37: it stayed until you
    // navigated).
    {
      const answers = { ...GOOD, "/api/schedules/morning-brief/resume": {} };
      const { ctx, page, errors, asked } = await open(browser, cdn, { width: 1280, scheme: "light", answers, hash: "#/schedules" });
      await page.waitForFunction(() => document.querySelector('header a[href="#/schedules"] .need')?.textContent.startsWith("2"));
      answers["/api/schedules"] = { schedules: GOOD["/api/schedules"].schedules.map((s) => s.name === "morning-brief" ? { ...s, paused: false, note: "resumed from heedle" } : s) };
      const before = asked.length;
      await page.locator(".panel.connector", { hasText: "morning-brief" }).getByRole("button", { name: "Resume" }).click();
      await page.waitForFunction(() => document.querySelector('header a[href="#/schedules"] .need')?.textContent.startsWith("1"), null, { timeout: 5000 });
      assert.deepEqual(errors, []);
      assert.ok(asked.length > before, "resuming asked the API");
      checks++;
      await ctx.close();
    }
    // Answers that failed, weren't understood, or never came: no counts,
    // and nothing in the bar says so.
    {
      const { ctx, page, errors, asked } = await open(browser, cdn, { width: 375, scheme: "light", answers: BROKEN, hash: "#/skills" });
      for (let i = 0; i < 100 && !["/api/skills", "/api/schedules", "/api/connectors"].every((p) => asked.includes(p)); i++) await page.waitForTimeout(100);
      await page.waitForTimeout(500);
      const b = await bar(page);
      assert.deepEqual(b.items.map((i) => i.need), ["", "", "", "", "", ""], "broken answers give no counts");
      assert.ok(!/error|locked|couldn't/i.test(b.headerText), "broken answers say nothing in the bar");
      assert.deepEqual(b.current, [["Skills", "page"]]);
      assert.deepEqual(errors, []);
      checks++;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`topbar: ${checks} checks hold`);
}

main().catch((e) => { console.error("topbar:", e.message); process.exit(1); });
