// The System page and the Run page's Cancel run, in a real browser (CI's
// system step, roadmap 9.2):
//   node ui/system.check.js [screenshot-dir]
// It opens the page in Chromium through Playwright as the top bar's check
// does (ui/topbar.check.js: the page's files from static/, the CDN files
// from their npm packages, the API from fixtures). It checks that the
// page shows heedle's containers with links to their runs, its images
// and Podman's machine with its notes; that Stop run, Remove old images
// and Cancel run send exactly what they should, and only after asking;
// that the page fits at 375 px in light and dark mode with no sideways
// scroll; and that an answer it can't read says so. With a directory, it
// saves the screenshots there.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { open, cdnFiles, GOOD } = require("./topbar.check.js");

const HEX = (c) => c.repeat(64);
const SYSTEM = {
  containers: [
    { id: HEX("a"), name: "bobbin-session-4f2a", image: "ghcr.io/heedle-ai/pirn-agent@sha256:" + HEX("1"), created: new Date(Date.now() - 260e3).toISOString(), state: "running",
      cpu: "38.2%", memory: "212MB / 536.9MB", labels: { kind: "agent", workflow: "loom-7d1c/plan", run: "p-1", step: "n2" }, workflow: "loom-7d1c", run: "r-1", status: "running" },
    { id: HEX("b"), name: "reed-act-9c01", image: "ghcr.io/heedle-ai/reed-browser-agent@sha256:" + HEX("2"), created: new Date(Date.now() - 90e3).toISOString(), state: "running",
      cpu: "11.0%", memory: "640MB / 1.074GB", labels: { kind: "act", workflow: "loom-7d1c/plan", run: "p-1", step: "n3" }, workflow: "loom-7d1c", run: "r-1", status: "running" },
    { id: HEX("c"), name: "bobbin-session-77e0", image: "ghcr.io/heedle-ai/pirn-agent@sha256:" + HEX("1"), created: new Date(Date.now() - 3600e3).toISOString(), state: "running",
      labels: { kind: "connector", workflow: "loom-50aa/plan", run: "p-2", step: "n0" }, workflow: "loom-50aa", run: "r-2", status: "canceled" },
  ],
  images: [
    { id: "1", names: ["ghcr.io/heedle-ai/pirn-agent@sha256:" + HEX("1")], size: 412e6, created: "2026-11-04T10:00:00Z", containers: 2, pinned: true },
    { id: "2", names: ["ghcr.io/heedle-ai/reed-browser-agent@sha256:" + HEX("2")], size: 1210e6, created: "2026-11-04T10:00:00Z", containers: 1, pinned: true },
    { id: "3", names: ["ghcr.io/heedle-ai/reed-browser@sha256:" + HEX("9")], size: 890e6, created: "2026-10-21T10:00:00Z", containers: 0, pinned: false },
    { id: "4", names: ["ghcr.io/heedle-ai/pirn-agent@sha256:" + HEX("8")], size: 398e6, created: "2026-10-21T10:00:00Z", containers: 0, pinned: false },
    { id: "5", names: ["ghcr.io/heedle-ai/reed-browser@sha256:" + HEX("7")], size: 120e6, created: "2026-10-01T10:00:00Z", containers: 1, pinned: false },
  ],
  keep: ["ghcr.io/heedle-ai/pirn-agent@sha256:" + HEX("1"), "ghcr.io/heedle-ai/reed-browser-agent@sha256:" + HEX("2")],
  machine: { name: "podman-machine-default", running: true, cpus: 2, memory: 2147483648, disk: 107374182400 },
  notes: ["Podman's machine has 2.0 GiB of memory; browser agents need at least 4 GiB. Give it more with: podman machine stop; podman machine set --memory 4096; podman machine start"],
  errors: {},
};
const RUN = { execution: { workflowId: "loom-7d1c", runId: "r-1", status: "Running", start: new Date(Date.now() - 300e3).toISOString(), close: "0001-01-01T00:00:00Z" },
  record: null, temporalUI: "http://localhost:8233", namespace: "default" };

// posts records what the page posts to the System API, and answers it.
async function posts(page) {
  const sent = [];
  await page.route(/\/api\/system\/(stop|prune)$/, (route) => {
    const r = route.request();
    sent.push(`${new URL(r.url()).pathname} ${r.postData()}`);
    return route.fulfill({ json: r.url().endsWith("stop") ? { workflow: "loom-7d1c", run: "r-1" } : { removed: ["x", "y"] } });
  });
  return sent;
}

async function main() {
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  assert.ok(+process.versions.node.split(".")[0] >= 22, `system: needs Node 22 or later, not ${process.versions.node}`);
  const cdn = cdnFiles();
  const browser = await chromium.launch();
  const answers = { ...GOOD, "/api/system": SYSTEM, "/api/runs/loom-7d1c/r-1": RUN, "/api/steps/loom-7d1c/r-1": { steps: [] }, "/api/writes/loom-7d1c": { writes: [] } };
  let checks = 0;
  try {
    for (const width of [1280, 375]) for (const scheme of ["light", "dark"]) {
      const where = `${width}px ${scheme}`;
      const { ctx, page, errors } = await open(browser, cdn, { width, scheme, answers, hash: "#/system" });
      const sent = await posts(page);
      await page.waitForSelector("main h3");
      const v = await page.evaluate(() => ({
        current: [...document.querySelectorAll("header [aria-current]")].map((a) => a.textContent.trim()),
        links: [...document.querySelectorAll("main a")].map((a) => a.getAttribute("href")),
        text: document.querySelector("main").textContent,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        stops: [...document.querySelectorAll("main button")].filter((b) => b.textContent === "Stop run").length,
      }));
      assert.deepEqual(v.current, ["System"], `${where}: the System section is current`);
      assert.deepEqual(v.links, ["#/run/loom-7d1c/r-1", "#/run/loom-7d1c/r-1", "#/run/loom-50aa/r-2"], `${where}: each container links to its run`);
      for (const want of ["agent", "act", "connector", "step n2", "38.2%", "212MB / 536.9MB", "canceled", "kept", "in use", "old", "3.0 GB in all; 1.3 GB is old.", "2 CPUs", "2 GiB memory", "100 GiB disk", "at least 4 GiB"]) {
        assert.ok(v.text.includes(want), `${where}: the page doesn't say "${want}"`);
      }
      assert.equal(v.stops, 2, `${where}: Stop run is offered for the running run's containers only`);
      assert.equal(v.overflow, 0, `${where}: the page scrolls sideways by ${v.overflow}px`);
      if (shots) await page.screenshot({ path: path.join(shots, `system-${width}-${scheme}.png`), fullPage: true });
      if (width === 1280 && scheme === "light") {
        // Stop run asks first, then sends only the run's workflow ID.
        await page.getByRole("button", { name: "Stop run" }).first().click();
        assert.deepEqual(sent, [], "Stop run sent before it was confirmed");
        await page.getByRole("button", { name: "Keep it" }).click();
        await page.getByRole("button", { name: "Stop run" }).first().click();
        await page.locator("button.danger", { hasText: "Stop run" }).click();
        await page.getByRole("status").filter({ hasText: "Stopped loom-7d1c" }).waitFor();
        await page.getByRole("button", { name: "Remove old images" }).click();
        await page.getByRole("status").filter({ hasText: "Removed 2 old image names" }).waitFor();
        assert.deepEqual(sent, ['/api/system/stop {"workflow":"loom-7d1c"}', "/api/system/prune {}"], "what the page sent");
      }
      assert.deepEqual(errors, [], `${where}: page errors`);
      checks++;
      await ctx.close();
    }
    // The Run page offers Cancel run while a run runs, and sends only its
    // workflow ID, after asking.
    {
      const { ctx, page, errors } = await open(browser, cdn, { width: 375, scheme: "light", answers, hash: "#/run/loom-7d1c/r-1" });
      const sent = await posts(page);
      await page.getByRole("button", { name: "Cancel run" }).click();
      assert.deepEqual(sent, [], "Cancel run sent before it was confirmed");
      await page.locator("button.danger", { hasText: "Cancel run" }).click();
      await page.getByRole("status").filter({ hasText: "Cancelled." }).waitFor();
      assert.deepEqual(sent, ['/api/system/stop {"workflow":"loom-7d1c"}']);
      if (shots) await page.screenshot({ path: path.join(shots, "run-cancel-375-light.png") });
      assert.deepEqual(errors, []);
      checks++;
      await ctx.close();
    }
    // An answer the page can't read, or the server's refusal from another
    // machine, is said, not hidden.
    for (const [answer, says] of [[{ containers: "x" }, "wasn't understood"],
      [{ status: 403, body: { error: "the System page works only on the machine heedle runs on, at localhost, not through a proxy" } }, "works only on the machine heedle runs on"]]) {
      const { ctx, page, errors } = await open(browser, cdn, { width: 375, scheme: "light", answers: { ...answers, "/api/system": answer }, hash: "#/system" });
      await page.locator("main .error").waitFor();
      assert.ok((await page.locator("main").textContent()).includes(says), `the page doesn't say "${says}"`);
      assert.deepEqual(errors, []);
      checks++;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`system: ${checks} checks hold`);
}

main().catch((e) => { console.error("system:", e.message); process.exit(1); });
