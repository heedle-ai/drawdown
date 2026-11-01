package drawdown_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/testsuite"

	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/warp"
)

// fakeTemporal runs each submitted plan for real, through shuttle's
// PlanWorkflow in Temporal's test environment, and records it with loom's
// Recorder: what loom's RunWorkflow does. Only the server is simulated.
type fakeTemporal struct {
	store   *warp.Store
	sources string
	down    bool
	mu      sync.Mutex
	execs   []drawdown.Execution
}

func (f *fakeTemporal) Submit(ctx context.Context, in loom.RunInput) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	plan.Register(env)
	shipment.RegisterCommands(env, f.sources)
	env.ExecuteWorkflow(plan.WorkflowName, in.Plan)
	if err := env.GetWorkflowError(); err != nil {
		return "", "", err
	}
	var res plan.Result
	if err := env.GetWorkflowResult(&res); err != nil {
		return "", "", err
	}
	wf, err := loom.WorkflowID(ctx, in)
	if err != nil {
		return "", "", err
	}
	run := fmt.Sprintf("run-%d", len(f.execs)+1)
	start := time.Unix(1761900000+int64(len(f.execs))*60, 0).UTC()
	if _, err := (&loom.Recorder{Store: f.store}).Record(ctx, loom.RecordInput{
		Program: in.Program, Plan: in.Plan, Result: res, Ref: in.Ref, WorkflowID: wf, RunID: run, At: start,
	}); err != nil {
		return "", "", err
	}
	f.execs = append(f.execs, drawdown.Execution{WorkflowID: wf, RunID: run, Status: "Completed", Start: start, Close: start.Add(time.Second)})
	return wf, run, nil
}

func (f *fakeTemporal) List(context.Context) ([]drawdown.Execution, error) {
	if f.down {
		return nil, errors.New("connection refused")
	}
	return f.execs, nil
}

func (f *fakeTemporal) Describe(_ context.Context, wf, run string) (drawdown.Execution, error) {
	for _, e := range f.execs {
		if e.WorkflowID == wf && e.RunID == run {
			return e, nil
		}
	}
	return drawdown.Execution{}, errors.New("not found")
}

type world struct {
	t       *testing.T
	srv     *httptest.Server
	fake    *fakeTemporal
	sources string
}

func newWorld(t *testing.T) *world {
	dir := t.TempDir()
	for _, n := range []string{"weather", "carrier", "factory"} {
		b, err := os.ReadFile(filepath.Join(shipment.SourcesDir(), n+".txt"))
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, n+".txt"), b, 0o644)
	}
	store, err := warp.Init(context.Background(), filepath.Join(dir, "store.git"))
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeTemporal{store: store, sources: dir}
	s := &drawdown.Server{Store: store, Ref: loom.DefaultRef, Registry: shipment.Registry(), Temporal: fake,
		TemporalUI: "http://localhost:8233", Examples: map[string]string{"shipment": shipment.Program}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &world{t: t, srv: srv, fake: fake, sources: dir}
}

func (w *world) call(method, path string, body any) (int, map[string]any, string) {
	w.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, w.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	json.Unmarshal(raw, &m)
	return res.StatusCode, m, string(raw)
}

func TestCompile(t *testing.T) {
	w := newWorld(t)
	code, m, _ := w.call("POST", "/api/compile", map[string]string{"program": shipment.Program})
	if code != 200 || len(m["plan"].(map[string]any)["nodes"].([]any)) != 4 {
		t.Fatalf("compile shipment: %d %v", code, m)
	}
	code, m, _ = w.call("POST", "/api/compile", map[string]string{"program": "(pipe\n  (echo \"a\""})
	if code != 200 || m["line"] != 2.0 || m["col"] != 12.0 || !strings.Contains(m["error"].(string), "unclosed") {
		t.Errorf("syntax error: %d %v", code, m)
	}
	code, m, _ = w.call("POST", "/api/compile", map[string]string{"program": `(pipe (echo "a") shout)`})
	if code != 200 || m["line"] != nil || !strings.Contains(m["error"].(string), `unknown builtin "shout"`) {
		t.Errorf("unknown command: %d %v", code, m)
	}
	if code, _, _ := w.call("POST", "/api/compile", map[string]any{"program": "x", "extra": 1}); code != 400 {
		t.Errorf("unknown field: %d, want 400", code)
	}
}

func TestSubmitListDetailDiff(t *testing.T) {
	w := newWorld(t)

	code, first, _ := w.call("POST", "/api/runs", map[string]string{"program": shipment.Program})
	if code != 202 {
		t.Fatalf("submit: %d %v", code, first)
	}
	os.WriteFile(filepath.Join(w.sources, "weather.txt"), []byte("on-time\nStorm has passed.\n"), 0o644)
	_, second, _ := w.call("POST", "/api/runs", map[string]string{"program": shipment.Program})
	if first["workflowId"] != second["workflowId"] || first["runId"] == second["runId"] {
		t.Fatalf("same program should share a workflow ID, not a run ID: %v %v", first, second)
	}

	_, list, _ := w.call("GET", "/api/runs", nil)
	runs := list["runs"].([]any)
	if len(runs) != 2 {
		t.Fatalf("runs = %v", runs)
	}
	newest := runs[0].(map[string]any)
	if newest["runId"] != second["runId"] || newest["status"] != "Completed" || newest["commit"] == "" || newest["program"] != shipment.Program {
		t.Errorf("newest row = %v", newest)
	}

	_, detail, _ := w.call("GET", fmt.Sprintf("/api/runs/%s/%s", second["workflowId"], second["runId"]), nil)
	rec := detail["record"].(map[string]any)
	outs := rec["outputs"].(map[string]any)
	if !strings.HasPrefix(outs["n3"].(string), "the shipment will be late: SUPPORTED\n  for:     factory\n") {
		t.Errorf("n3 = %q", outs["n3"])
	}
	if detail["execution"].(map[string]any)["status"] != "Completed" || rec["previous"] == nil || rec["previous"] != rec["parent"] {
		t.Errorf("detail = %v", detail)
	}

	code, _, diff := w.call("GET", fmt.Sprintf("/api/diff/%s/%s", rec["previous"], rec["commit"]), nil)
	for _, want := range []string{"-weather: delay", "+weather: on-time", "outputs/n3", "-  for:     factory, weather"} {
		if code != 200 || !strings.Contains(diff, want) {
			t.Errorf("diff (%d) lacks %q:\n%s", code, want, diff)
		}
	}
	if strings.Contains(diff, "outputs/n1") || strings.Contains(diff, "plan.json") {
		t.Errorf("diff shows unchanged evidence:\n%s", diff)
	}
}

func TestList_WhenTemporalIsDown_ShowsRecords(t *testing.T) {
	w := newWorld(t)
	w.call("POST", "/api/runs", map[string]string{"program": `(echo "a")`})
	w.fake.down = true
	_, list, _ := w.call("GET", "/api/runs", nil)
	runs := list["runs"].([]any)
	if len(runs) != 1 || runs[0].(map[string]any)["status"] != "Recorded" || list["temporalError"] == nil {
		t.Errorf("list = %v", list)
	}
}

func TestDiffAndDetail_RejectBadInput(t *testing.T) {
	w := newWorld(t)
	if code, _, _ := w.call("GET", "/api/diff/HEAD/HEAD", nil); code != 400 {
		t.Errorf("diff of revision expressions: %d, want 400", code)
	}
	if code, _, _ := w.call("GET", "/api/runs/loom-x/nope", nil); code != 404 {
		t.Errorf("unknown run: %d, want 404", code)
	}
	if code, m, _ := w.call("POST", "/api/runs", map[string]string{"program": "(echo"}); code != 422 || m["line"] != 1.0 {
		t.Errorf("submitting a broken program: %d %v", code, m)
	}
}

func TestGuard_RefusesCrossSiteAndRebinding(t *testing.T) {
	w := newWorld(t)
	post := func(ct, origin, host, body string) int {
		req, _ := http.NewRequest("POST", w.srv.URL+"/api/runs", strings.NewReader(body))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	ok := `{"program":"(echo \"a\")"}`
	cases := []struct {
		name, ct, origin, host, body string
		want                         int
	}{
		{"form post as text/plain", "text/plain", "", "", ok + "=", 415},
		{"no content type", "", "", "", ok, 415},
		{"cross-origin page", "application/json", "https://evil.example", "", ok, 403},
		{"DNS rebinding host", "application/json", "", "evil.example:8090", ok, 403},
		{"trailing data", "application/json", "", "", ok + " {}", 400},
		{"same-origin page", "application/json", w.srv.URL, "", ok, 202},
	}
	for _, c := range cases {
		if got := post(c.ct, c.origin, c.host, c.body); got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
	if n := len(w.fake.execs); n != 1 {
		t.Errorf("%d runs started, want only the same-origin one", n)
	}
}

func TestList_IsBoundedAndRecordedRowsHaveNoDuration(t *testing.T) {
	w := newWorld(t)
	for i := 0; i < drawdown.ListLimit+5; i++ {
		w.call("POST", "/api/runs", map[string]string{"program": fmt.Sprintf(`(echo "%d")`, i)})
	}
	w.fake.down = true
	start := time.Now()
	_, list, _ := w.call("GET", "/api/runs", nil)
	runs := list["runs"].([]any)
	if len(runs) != drawdown.ListLimit {
		t.Errorf("listed %d records, want the latest %d", len(runs), drawdown.ListLimit)
	}
	if row := runs[0].(map[string]any); row["status"] != "Recorded" || row["close"] != nil || row["program"] != fmt.Sprintf(`(echo "%d")`, drawdown.ListLimit+4) {
		t.Errorf("newest recorded row = %v", row)
	}
	first := time.Since(start)
	start = time.Now()
	w.call("GET", "/api/runs", nil)
	again := time.Since(start)
	t.Logf("listing %d records: first %v, cached %v", drawdown.ListLimit, first, again)
}

func TestDetail_ReportsTemporalErrorWhenNoRecord(t *testing.T) {
	w := newWorld(t)
	w.call("POST", "/api/runs", map[string]string{"program": `(echo "a")`})
	code, m, _ := w.call("GET", "/api/runs/loom-x/run-404", nil)
	if code != 404 || !strings.Contains(m["error"].(string), "Temporal: not found") {
		t.Errorf("detail of an unknown run: %d %v", code, m)
	}
}

func TestPage(t *testing.T) {
	w := newWorld(t)
	for path, want := range map[string]string{
		"/":       `integrity="sha384-`,
		"/app.js": "ReactDOM.createRoot",
	} {
		res, err := http.Get(w.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || !strings.Contains(string(b), want) {
			t.Errorf("GET %s: %d, missing %q", path, res.StatusCode, want)
		}
		if csp := res.Header.Get("Content-Security-Policy"); csp != drawdown.ContentSecurityPolicy || !strings.Contains(csp, "script-src 'self' https://cdn.jsdelivr.net;") {
			t.Errorf("GET %s: Content-Security-Policy = %q", path, csp)
		}
	}
	_, info, _ := w.call("GET", "/api/info", nil)
	if info["ref"] != loom.DefaultRef || len(info["commands"].([]any)) != 3 {
		t.Errorf("info = %v", info)
	}
}

// TestServeForBrowser serves the UI with the fake Temporal, for driving it
// from a real browser. It runs only when DRAWDOWN_BROWSER_ADDR is set, and
// keeps serving until DRAWDOWN_BROWSER_DONE (a file path) exists.
func TestServeForBrowser(t *testing.T) {
	addr := os.Getenv("DRAWDOWN_BROWSER_ADDR")
	if addr == "" {
		t.Skip("set DRAWDOWN_BROWSER_ADDR to serve the UI for a browser test")
	}
	w := newWorld(t)
	s := &http.Server{Addr: addr, Handler: w.srv.Config.Handler}
	go s.ListenAndServe()
	defer s.Close()
	os.WriteFile(os.Getenv("DRAWDOWN_BROWSER_SOURCES"), []byte(w.sources), 0o644)
	for i := 0; i < 600; i++ {
		if _, err := os.Stat(os.Getenv("DRAWDOWN_BROWSER_DONE")); err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}
