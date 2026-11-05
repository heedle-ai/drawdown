package drawdown_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/bobbin"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

// TestInv_OnlyWarpRunsGit: no package here starts processes itself; all
// Git work goes through warp, the single writer. Every way the standard
// library offers to start a process is banned: os/exec, syscall,
// golang.org/x/sys, and os.StartProcess.
func TestInv_OnlyWarpRunsGit(t *testing.T) {
	out, err := exec.Command("go", "list", "-f", "{{.Dir}}|{{.ImportPath}}|{{join .Imports \" \"}}|{{join .GoFiles \" \"}}", "./...").Output()
	if err != nil {
		t.Fatal(err)
	}
	banned := map[string]bool{"os/exec": true, "syscall": true, "golang.org/x/sys/unix": true, "golang.org/x/sys/execabs": true}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "|")
		dir, pkg, imports, files := f[0], f[1], strings.Fields(f[2]), strings.Fields(f[3])
		for _, imp := range imports {
			if banned[imp] || strings.HasPrefix(imp, "golang.org/x/sys") {
				t.Errorf("%s imports %s; run git only through warp", pkg, imp)
			}
		}
		for _, name := range files {
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			if regexp.MustCompile(`\bos\.StartProcess\b`).Match(b) {
				t.Errorf("%s/%s calls os.StartProcess; run git only through warp", pkg, name)
			}
		}
	}
}

// TestInv_UIOnlyReadsHistory: the server's view of warp has no method that
// writes, so the UI can't edit history even by mistake (DRAW-8).
func TestInv_UIOnlyReadsHistory(t *testing.T) {
	writes := map[string]bool{"Commit": true, "PutBlob": true, "PutTree": true, "Advance": true}
	h := reflect.TypeOf((*drawdown.History)(nil)).Elem()
	for i := 0; i < h.NumMethod(); i++ {
		if writes[h.Method(i).Name] {
			t.Errorf("History has %s, which writes", h.Method(i).Name)
		}
	}
	if f, _ := reflect.TypeOf(drawdown.Server{}).FieldByName("Store"); f.Type != h {
		t.Errorf("Server.Store is %v, want the read-only drawdown.History", f.Type)
	}
	var _ drawdown.History = (*warp.Store)(nil) // a real store still fits
	// Skills too are read through an interface with no way to change
	// them: changes go to a worker (Temporal.ChangeSkills).
	lib := reflect.TypeOf((*drawdown.Library)(nil)).Elem()
	reads := map[string]bool{"Skills": true, "Pending": true, "Versions": true, "Folder": true, "Review": true, "AddTo": true}
	for i := 0; i < lib.NumMethod(); i++ {
		if !reads[lib.Method(i).Name] {
			t.Errorf("Library has %s, which isn't a known read", lib.Method(i).Name)
		}
	}
	if f, _ := reflect.TypeOf(drawdown.Server{}).FieldByName("Skills"); f.Type != lib {
		t.Errorf("Server.Skills is %v, want the read-only drawdown.Library", f.Type)
	}
	var _ drawdown.Library = (*treadle.Library)(nil)
}

// TestInv_AgentTabs checks the page's agent-tab code, which has no Go
// counterpart: every agent link opens one named tab per agent (so opening
// it again focuses that tab), names never get rel=noopener (which would
// stop the reuse), agents nest by dots, and images from outputs and live
// frames are shown only as JPEG data URLs. The full behaviour is checked
// by driving the page in Chromium (How It Works, Tested).
func TestInv_AgentTabs(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	for _, want := range []string{
		`const tabName = (ref) => "heedle-agent-" + agentName(ref);`,
		`return html` + "`" + `<a href=${agentHref(agent)} target=${tabName(agent)}>${children}</a>` + "`" + `;`,
		`const i = name.lastIndexOf(".");`,
		`page.screenshot.startsWith("data:image/jpeg;base64,")`,
		`f.image.startsWith("data:image/jpeg;base64,")`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
	if regexp.MustCompile(`target=\$\{tabName[^>]*noopener`).MatchString(js) {
		t.Error("agent links must not use rel=noopener: the named tab couldn't be reused")
	}
}

// TestInv_AnswersAreShownAsText: an ask step's answer (pirn's JSON) is shown
// as its text with the model and token counts. The page inserts HTML only
// in the known places: clearing, or HTML made by diff2html, which escapes
// what it renders; model text and page text are always data.
func TestInv_AnswersAreShownAsText(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	for _, want := range []string{
		"const { agent, act, answer, page } = DD.parse(text);", // act since roadmap 9.5
		"<pre class=\"answer-text\">${answer.text}</pre>",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
	sinks := regexp.MustCompile(`innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|DOMParser|createContextualFragment`).FindAllStringIndex(js, -1)
	allowed := []string{
		`ref.current.innerHTML = Diff2Html.html(r.data, { drawFileList: true, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });`,
		// Clearing a file's diff before showing another: no data.
		`if (ref.current) ref.current.innerHTML = "";`,
		// One file's change (warp's DiffBlobs), as it comes from Git.
		`ref.current.innerHTML = Diff2Html.html(r.data, { drawFileList: false, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });`,
		// An import waiting for review (warp's DiffTrees), as it comes from Git.
		`if (diff && ref.current) ref.current.innerHTML = Diff2Html.html(diff, { drawFileList: true, matching: "lines", outputFormat: "line-by-line", colorScheme: "auto" });`,
	}
	known := 0
	for _, a := range allowed {
		known += strings.Count(js, a)
	}
	if len(sinks) != known {
		t.Errorf("static/app.js inserts HTML in %d places, only %d of them known ones", len(sinks), known)
	}
	for _, a := range allowed {
		if !strings.Contains(js, a) {
			t.Errorf("static/app.js lacks the known HTML sink %s", a)
		}
	}
}

// TestInv_InspectorTellsTheTruth: the step inspector's claims about where
// a step ran are the sandboxes' real command lines: a container step and a
// browse step each run in a container that is removed afterwards, with
// nothing mounted, and a container step has no network at all.
func TestInv_InspectorTellsTheTruth(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	for _, claim := range []string{
		`container: { where: "A fresh Podman container from a content-pinned image, removed when the step ends"`,
		`net: "None (--network=none)"`,
		`nothing is mounted from the machine`,
		`HEEDLE_NODE and HEEDLE_ATTEMPT in its environment, nothing else from the machine`,
		`browse: { where: "A fresh Podman container running a fresh Chromium profile, removed when the step ends"`,
		`Chromium is set to reach only the hosts the program names`,
		`The container itself is on Podman's network, so this rests on Chromium's own settings`,
		`with both, the arguments, then \" | \", then the inputs joined with spaces`,
		`agent: { where: "A fresh Podman container (a bobbin session) for this step alone`,
		`net: "None for its commands (--network=none). Only the worker talks to the Claude API"`,
		`no environment variables from the machine or the worker`,
		`local ones each in its own container with no network`,
		`every write it queued (run once after the run's steps, never in the step)`,
		`image: { where: "podman build on the worker, from base images pinned to content and already on it: nothing is pulled"`,
		`net: "None for RUN steps (--network=none). With \"push\", the worker pushes the image with its own login"`,
		`A fresh build context holding only the Containerfile and in/<node>.txt for each input`,
		`skill: { where: "A Claude agent step following a skill: a fresh Podman container (a bobbin session) for this step alone`,
		`holding the skill's folder at the version the plan pins in /work/skill`,
	} {
		if !strings.Contains(js, claim) {
			t.Errorf("static/app.js no longer claims %s", claim)
		}
	}
	container := strings.Join(bobbin.Spec{Image: strings.Repeat("ab", 32)}.Argv(time.Minute), " ")
	browser := strings.Join(reed.Browser{Image: strings.Repeat("ab", 32)}.Argv("v", []string{"a.example"}), " ")
	session := strings.Join(bobbin.Spec{Image: strings.Repeat("ab", 32)}.SessionArgv("s", time.Minute), " ")
	if build := strings.Join(bobbin.BuildArgv("/c", "/i"), " "); !strings.Contains(build, "--network=none") || !strings.Contains(build, "--pull=never") ||
		strings.Contains(build, "-v ") || strings.Contains(build, "--volume") {
		t.Errorf("image builds changed; update the inspector: %s", build)
	}
	if !strings.Contains(session, "--network=none") {
		t.Errorf("agent sessions have a network: %s", session)
	}
	// A local connector's server runs in a bobbin session of its own
	// (with the same --network=none), and writes are only ever queued.
	if src, err := os.ReadFile("../pirn/mcp.go"); err != nil || !strings.Contains(string(src), "box, err := a.Runner.Start(ctx, bobbin.Spec{Image: c.Image, Secrets: secrets})") ||
		!strings.Contains(string(src), "res.Writes = append(res.Writes, w)") {
		t.Errorf("connectors changed; update the inspector (%v)", err)
	}
	// treadle's skill steps are pirn's agent steps, with the skill in /work/skill.
	if src, err := os.ReadFile("../treadle/command.go"); err != nil || !strings.Contains(string(src), "return pirn.Step(ctx, a, pirn.Question{") {
		t.Errorf("skill steps no longer run as pirn agent steps; update the inspector (%v)", err)
	}
	if src, err := os.ReadFile("../pirn/agent.go"); err != nil || !strings.Contains(string(src), `SkillDir = "/work/skill"`) {
		t.Errorf("skills moved from /work/skill; update the inspector (%v)", err)
	}
	// pirn starts its session from an image alone: no environment.
	// (Review 7: DRAW-22 said agent steps had HEEDLE_NODE and HEEDLE_ATTEMPT.)
	if pirnSrc, err := os.ReadFile("../pirn/agent.go"); err != nil || !strings.Contains(string(pirnSrc), "a.Runner.Start(ctx, bobbin.Spec{Image: a.Image})") || strings.Contains(session, "--env") {
		t.Errorf("an agent session's environment changed; update the inspector (%v): %s", err, session)
	}
	for name, argv := range map[string]string{"container": container, "browse": browser, "agent": session} {
		if !strings.Contains(argv, "--rm") {
			t.Errorf("%s step isn't removed afterwards: %s", name, argv)
		}
		for _, mount := range []string{"-v ", "--volume", "--mount", "-p ", "--publish"} {
			if strings.Contains(argv, mount) {
				t.Errorf("%s step mounts or publishes something (%s): %s", name, mount, argv)
			}
		}
	}
	if !strings.Contains(container, "--network=none") {
		t.Errorf("container step has a network: %s", container)
	}
	// browse's network limit is Chromium's: a dead proxy for every host but
	// the allowed ones. The container itself has a network, as the page says.
	if strings.Contains(browser, "--network=none") {
		t.Errorf("browse containers now have no network; update the inspector: %s", browser)
	}
	if flags := strings.Join(reed.ChromiumFlags([]string{"a.example"}, nil), " "); !strings.Contains(flags, "--proxy-server=http://127.0.0.1:9") ||
		!strings.Contains(flags, "a.example") {
		t.Errorf("Chromium isn't limited to the allowed hosts: %s", flags)
	}
	// A container step's environment is exactly HEEDLE_NODE and HEEDLE_ATTEMPT.
	src, err := os.ReadFile("../bobbin/command.go")
	if err != nil {
		t.Fatal(err)
	}
	if env := regexp.MustCompile(`Env:\s+map\[string\]string\{([^}]*)\}`).FindSubmatch(src); env == nil ||
		regexp.MustCompile(`"HEEDLE_[A-Z]+"`).FindAllString(string(env[1]), -1) == nil ||
		strings.Join(regexp.MustCompile(`"[A-Z_]+":`).FindAllString(string(env[1]), -1), " ") != `"HEEDLE_NODE": "HEEDLE_ATTEMPT":` {
		t.Errorf("bobbin's step environment changed; update the inspector: %s", env)
	}
	// echo: with both, the arguments, " | ", then the inputs.
	if out, _ := plan.Echo(context.Background(), plan.Input{Args: []string{"a"}, Upstream: map[string]string{"n0": "x", "n1": "y"}}); out != "a | x y" {
		t.Errorf("echo now gives %q; update the inspector", out)
	}
}

// TestInv_OutputsAreParsedInOnePlace: every step output is read through
// lib.js's checked parse, so JSON that only looks like an answer or a page
// is shown as text, never trusted (lib.js's own tests, ci:ui, check the
// shapes); and a view that fails anyway is caught by an error boundary
// instead of blanking the page.
func TestInv_OutputsAreParsedInOnePlace(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js := string(b)
	if strings.Contains(js, "JSON.parse(") {
		t.Error("static/app.js parses JSON itself; use DD.parse")
	}
	for _, want := range []string{"class ErrorBoundary extends React.Component", "<${ErrorBoundary} route=${route.join(\"/\")}>${body}<//>"} {
		if !strings.Contains(js, want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
	page, _ := os.ReadFile("static/index.html")
	if !strings.Contains(string(page), "<script src=\"lib.js\"></script>\n<script src=\"app.js\"></script>") {
		t.Error("index.html must load lib.js before app.js")
	}
}

// TestInv_FontsAreServedHere: the page's fonts come from drawdown itself,
// so the Content-Security-Policy keeps fonts to 'self' and no font file is
// fetched without an integrity check; their licences ship beside them.
func TestInv_FontsAreServedHere(t *testing.T) {
	b, err := os.ReadFile("static/index.html")
	if err != nil {
		t.Fatal(err)
	}
	urls := regexp.MustCompile(`src:url\(([^)]+)\)`).FindAllStringSubmatch(string(b), -1)
	if len(urls) != 3 {
		t.Fatalf("%d @font-face sources, want 3", len(urls))
	}
	for _, u := range urls {
		if !strings.HasPrefix(u[1], "fonts/") {
			t.Errorf("font %s isn't served by drawdown", u[1])
		}
		if _, err := os.Stat(filepath.Join("static", u[1])); err != nil {
			t.Errorf("font file %s: %v", u[1], err)
		}
	}
	for _, l := range []string{"LICENSE-bricolage-grotesque.txt", "LICENSE-jetbrains-mono.txt"} {
		if b, err := os.ReadFile(filepath.Join("static/fonts", l)); err != nil || !strings.Contains(string(b), "SIL Open Font License") {
			t.Errorf("%s: %v", l, err)
		}
	}
	if !strings.Contains(drawdown.ContentSecurityPolicy, "font-src 'self' data:;") {
		t.Errorf("CSP lets fonts come from elsewhere: %s", drawdown.ContentSecurityPolicy)
	}
}

// TestInv_GraphViewerLeavesLinksAlone: in the full-screen graph, dragging
// never captures a press on a link, a button or anything focusable, so a
// step's links, its chevron and the arrows stay usable; the wheel listener
// isn't passive, so zooming the graph doesn't zoom the page; and closing
// returns focus to the full-screen button.
func TestInv_GraphViewerLeavesLinksAlone(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`if (e.target.closest("a, button, [tabindex], pre, .cg-detail")) return;`,
		`box.addEventListener("wheel", wheel, { passive: false });`,
		`setTimeout(() => fullRef.current && fullRef.current.focus(), 0);`,
		"onPointerCancel=${() => { drag.current = null; }}",
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
}

// TestInv_StepPageStartsFresh: each step page is keyed by its route, so
// moving to another step never carries an open file or its diff over, and
// a file's diff is cleared before another loads. (Review 9: a row with the
// same path stayed open, showing the previous step's diff.)
func TestInv_StepPageStartsFresh(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"html`<${StepPage} key=${route.join(\"/\")} ",
		`if (ref.current) ref.current.innerHTML = "";`,
		"}, [open, f.status, f.before, f.blob, oci]);",
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
}

// TestInv_RegistryPatternsAgree: pirn (which pushes files), bobbin (which
// pushes images), loom (which records) and this page (which shows a fetch
// command) accept exactly the same registry repositories: one pattern,
// written four times.
func TestInv_RegistryPatternsAgree(t *testing.T) {
	read := func(path, re string) string {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(re).FindSubmatch(b)
		if m == nil {
			t.Fatalf("%s: no registry pattern", path)
		}
		return string(m[1])
	}
	pirn := read("../pirn/registry.go", "repoRef = regexp.MustCompile\\(`([^`]+)`\\)")
	loom := read("../loom/files.go", "ociRepo   = regexp.MustCompile\\(`([^`]+)`\\)")
	page := strings.ReplaceAll(read("static/lib.js", `const OCI_REPO = /(.+)/;`), `\/`, "/")
	bobbin := read("../bobbin/build.go", "imageRepo = regexp.MustCompile\\(`([^`]+)`\\)")
	if pirn != loom || pirn != page || pirn != bobbin {
		t.Errorf("registry patterns differ:\npirn %s\nloom %s\npage %s\nbobbin %s", pirn, loom, page, bobbin)
	}
}

// TestInv_NoSecondRenderer: the graphs are React elements; no library that
// draws its own HTML (Mermaid was one) is loaded or called.
func TestInv_NoSecondRenderer(t *testing.T) {
	for _, f := range []string{"static/app.js", "static/index.html"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(string(b)), "mermaid") {
			t.Errorf("%s still uses mermaid", f)
		}
	}
}

// TestInv_CompositionGraphKeepsItsPlace: folding keeps focus on the same
// button; what is open or folded belongs to one drawing and starts afresh
// when the program changes shape; a drawing from requires shows each
// step's waits; the record link needs a record before it; and the full
// screen view keeps focus inside it. (Review 25.)
func TestInv_CompositionGraphKeepsItsPlace(t *testing.T) {
	b, err := os.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<button type=\"button\" class=\"cg-fold\" aria-expanded=${!folded}",
		"const sig = JSON.stringify([sh, exact]);",
		"${!ctx.exact && !open && html`<div class=\"cg-waits\">",
		"${ctx.rec && ctx.rec.parent && html`<${IconLink}",
		"// A modal keeps focus inside it.",
		"const shown = plan ? lastGood.current : err ? lastGood.current : null;",
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("static/app.js lacks %s", want)
		}
	}
	if strings.Contains(string(b), "cg-folded") {
		t.Error("a folded group is a different element from the fold button again")
	}
}
