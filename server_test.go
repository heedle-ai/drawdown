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

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/treadle"
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
	live    map[string][]drawdown.LiveFrame
	steps   map[string][]drawdown.Step
	writes  map[string][]loom.WriteOutcome
	forms   []loom.FormDecision
	writer  *loom.Writer
	create  func(context.Context, string) (map[string][]byte, error)
	catalog loom.Catalog
	listed  []treadle.Source
	sched   map[string]*loom.Schedule
	schedIn map[string]loom.RunInput
	// realTime records runs at the time they run, not at fixed times.
	realTime bool
}

// fakeSchedules is the fake's schedules as loom's budget check reads and
// pauses them; f.mu is held.
type fakeSchedules struct{ f *fakeTemporal }

func (s fakeSchedules) Budget(_ context.Context, name string) (loom.ScheduleBudget, error) {
	sc := s.f.sched[name]
	if sc == nil {
		return loom.ScheduleBudget{}, loom.ErrNoSchedule
	}
	b := loom.ScheduleBudget{TimeZone: sc.Spec.TimeZone, Paused: sc.Paused, Note: sc.Note}
	if sc.Budget != nil {
		b.Budget = *sc.Budget
	}
	return b, nil
}

func (s fakeSchedules) Pause(_ context.Context, name, note string) error {
	if sc := s.f.sched[name]; sc != nil {
		sc.Paused, sc.Note = true, note
	}
	return nil
}

// standInClaude answers ask, agent and act steps as Claude would, without
// Claude: each a pirn result whose tokens depend on its arguments, noted
// on the step's meter as pirn notes what Claude answers, so a worker
// that counts its steps (loom.Counted) counts them.
func standInClaude(env loom.Activities) {
	answer := func(in plan.Input) pirn.Answer {
		n := int64(len(strings.Join(in.Args, " ")))
		return pirn.Answer{Pirn: 1, Model: "claude-sonnet-5-5", Text: "A stand-in answer.", StopReason: "end_turn", InputTokens: 1200 + 40*n, OutputTokens: 300 + 3*n}
	}
	reply := func(ctx context.Context, a pirn.Answer, v any) (string, error) {
		pirn.MeterFrom(ctx).Add(pirn.Call{Model: a.Model, Input: a.InputTokens, Output: a.OutputTokens})
		b, err := json.Marshal(v)
		return string(b), err
	}
	env.RegisterActivityWithOptions(func(ctx context.Context, in plan.Input) (string, error) { a := answer(in); return reply(ctx, a, a) }, activity.RegisterOptions{Name: pirn.ActivityName})
	env.RegisterActivityWithOptions(func(ctx context.Context, in plan.Input) (string, error) {
		a := answer(in)
		a.InputTokens, a.OutputTokens = a.InputTokens*6, a.OutputTokens*4
		return reply(ctx, a, pirn.AgentResult{Answer: a, Agent: 1, Turns: 6, Inputs: map[string]string{}})
	}, activity.RegisterOptions{Name: pirn.AgentActivityName})
	env.RegisterActivityWithOptions(func(ctx context.Context, in plan.Input) (string, error) {
		a := answer(in)
		a.InputTokens, a.OutputTokens = a.InputTokens*3, a.OutputTokens*2
		return reply(ctx, a, pirn.ActResult{Answer: a, Act: 1, Turns: 3, Ended: "done"})
	}, activity.RegisterOptions{Name: pirn.ActActivityName})
}

func (f *fakeTemporal) CreateSchedule(ctx context.Context, name string, in loom.RunInput, spec loom.ScheduleSpec) error {
	if _, err := loom.ScheduleOptions(ctx, "loom", name, in, spec); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sched == nil {
		f.sched, f.schedIn = map[string]*loom.Schedule{}, map[string]loom.RunInput{}
	}
	if f.sched[name] != nil {
		return temporal.ErrScheduleAlreadyRunning
	}
	f.sched[name] = &loom.Schedule{Name: name, Program: in.Program, Ref: in.Ref, Spec: spec, Recent: []loom.ScheduleRun{}}
	f.schedIn[name] = in
	return nil
}

func (f *fakeTemporal) Schedules(context.Context) ([]loom.Schedule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []loom.Schedule
	for _, s := range f.sched {
		out = append(out, *s)
	}
	return out, nil
}

// ScheduleAction runs a schedule now as Temporal would: a run of exactly
// its input.
func (f *fakeTemporal) ScheduleAction(ctx context.Context, name, action string) error {
	f.mu.Lock()
	s, in := f.sched[name], f.schedIn[name]
	f.mu.Unlock()
	if s == nil {
		return serviceerror.NewNotFound("schedule not found")
	}
	switch action {
	case "pause", "resume":
		f.mu.Lock()
		s.Paused = action == "pause"
		f.mu.Unlock()
	case "delete":
		f.mu.Lock()
		delete(f.sched, name)
		f.mu.Unlock()
	case "run":
		// As Temporal does: the workflow ID with the time added.
		wf, run, err := f.start(ctx, in, time.Now().UTC().Format("-2006-01-02T15:04:05.000000000Z"), name)
		if err != nil {
			return err
		}
		f.mu.Lock()
		s.Recent = append(s.Recent, loom.ScheduleRun{WorkflowID: wf, RunID: run, At: time.Now()})
		f.mu.Unlock()
	}
	return nil
}

func (f *fakeTemporal) Live(_ context.Context, wf string) ([]drawdown.LiveFrame, error) {
	if f.down {
		return nil, errors.New("connection refused")
	}
	return f.live[wf], nil
}

func (f *fakeTemporal) Submit(ctx context.Context, in loom.RunInput) (string, string, error) {
	return f.start(ctx, in, "", "")
}

// start runs and records in, its workflow ID with suffix added: a
// schedule's runs have the time Temporal adds, and are checked against
// the schedule's budget first by loom's own check (roadmap 10.4).
func (f *fakeTemporal) start(ctx context.Context, in loom.RunInput, suffix, schedule string) (string, string, error) {
	// Real Temporal only starts the workflow here; a worker runs and records
	// it later. The fake does both now, so it mustn't be bound by the
	// server's Temporal timeout (DRAW-18).
	ctx = context.WithoutCancel(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	wf, err := loom.WorkflowID(ctx, in)
	if err != nil {
		return "", "", err
	}
	wf += suffix
	run := fmt.Sprintf("run-%d", len(f.execs)+1)
	start := time.Unix(1761900000+int64(len(f.execs))*60, 0).UTC()
	if f.realTime {
		start = time.Now().UTC().Truncate(time.Second)
	}
	if schedule != "" {
		note, err := (&loom.Recorder{Store: f.store, Schedules: fakeSchedules{f}}).Budget(ctx, loom.BudgetInput{Schedule: schedule, Ref: in.Ref, At: start})
		if err != nil {
			return "", "", err
		}
		if note != "" {
			f.execs = append(f.execs, drawdown.Execution{WorkflowID: wf, RunID: run, Status: "Completed", Start: start, Close: start, Ref: in.Ref, Skipped: note})
			return wf, run, nil
		}
	}
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	// The plan's workflow, as RunWorkflow names it; its Claude steps
	// counted in the usage ledger, as loom's worker counts them.
	env.SetStartWorkflowOptions(client.StartWorkflowOptions{ID: wf + "/plan"})
	plan.Register(env)
	shipment.RegisterCommands(env, f.sources)
	standInClaude(loom.Counted(env, f.store))
	env.ExecuteWorkflow(plan.WorkflowName, in.Plan)
	if err := env.GetWorkflowError(); err != nil {
		return "", "", err
	}
	var res plan.Result
	if err := env.GetWorkflowResult(&res); err != nil {
		return "", "", err
	}
	if _, err := (&loom.Recorder{Store: f.store}).Record(ctx, loom.RecordInput{
		Program: in.Program, Plan: in.Plan, Result: res, Ref: in.Ref, WorkflowID: wf, RunID: run, At: start, Schedule: schedule,
	}); err != nil {
		return "", "", err
	}
	f.execs = append(f.execs, drawdown.Execution{WorkflowID: wf, RunID: run, Status: "Completed", Start: start, Close: start.Add(time.Second), Ref: in.Ref})
	return wf, run, nil
}

// Writes answers the writes a test gave the fake for a workflow.
func (f *fakeTemporal) Writes(_ context.Context, wf string) ([]loom.WriteOutcome, error) {
	if f.down {
		return nil, errors.New("connection refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]loom.WriteOutcome(nil), f.writes[wf]...), nil
}

// DecideWrite decides a waiting write, as RunWorkflow does on its signal.
func (f *fakeTemporal) DecideWrite(_ context.Context, wf string, d loom.WriteDecision) error {
	if f.down {
		return errors.New("connection refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, w := range f.writes[wf] {
		if w.Node == d.Node && w.ID == d.ID && w.Status == loom.WriteWaiting {
			f.writes[wf][i].Status = map[bool]string{true: loom.WriteApproved, false: loom.WriteDeclined}[d.Approve]
		}
	}
	return nil
}

// DecideForm decides a form an act step waits to send, as loom.DecideForm
// does: only one waiting now (on a live frame), which then stops waiting.
func (f *fakeTemporal) DecideForm(_ context.Context, wf string, d loom.FormDecision) error {
	if f.down {
		return errors.New("connection refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, fr := range f.live[wf] {
		if fr.Pending != nil && fr.Pending.ID == d.ID {
			f.forms = append(f.forms, d)
			f.live[wf][i].Pending = nil
			return nil
		}
	}
	return fmt.Errorf("%w: no form %q waits", pirn.ErrInvalid, d.ID)
}

// ListSkills answers the fake's catalog, keeping what it was asked.
func (f *fakeTemporal) ListSkills(_ context.Context, src treadle.Source) (loom.Catalog, error) {
	if f.down {
		return loom.Catalog{}, errors.New("connection refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listed = append(f.listed, src)
	return f.catalog, nil
}

// WriteProgram writes with the fake's writer (a stand-in Claude).
func (f *fakeTemporal) WriteProgram(ctx context.Context, description string) (loom.Written, error) {
	if f.down {
		return loom.Written{}, errors.New("connection refused")
	}
	if f.writer == nil {
		return loom.Written{}, errors.New("no writer")
	}
	return f.writer.Write(ctx, description)
}

func (f *fakeTemporal) Ask(ctx context.Context, in loom.AskRequest) (loom.Proposal, error) {
	if f.down {
		return loom.Proposal{}, errors.New("connection refused")
	}
	if f.writer == nil {
		return loom.Proposal{}, errors.New("no writer")
	}
	if f.writer.Ledger != nil {
		// What a worker runs for AskWorkflow: its calls in the ledger.
		return f.writer.AskActivity(ctx, in)
	}
	return f.writer.Ask(ctx, in)
}

// ChangeSkills runs loom's skills workflow in Temporal's test suite, on
// the fake's store, as a worker would.
func (f *fakeTemporal) ChangeSkills(ctx context.Context, in loom.SkillsChange) (treadle.Skill, error) {
	if f.down {
		return treadle.Skill{}, errors.New("connection refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	loom.RegisterSkills(env, loom.Skills{Library: &treadle.Library{Store: f.store}, Create: f.create})
	env.ExecuteWorkflow(loom.SkillsWorkflowName, in)
	var s treadle.Skill
	err := env.GetWorkflowError()
	if err == nil {
		err = env.GetWorkflowResult(&s)
	}
	var app *temporal.ApplicationError
	if errors.As(err, &app) && app.Type() == loom.SkillsRefused {
		return treadle.Skill{}, fmt.Errorf("%w: %s", treadle.ErrInvalid, app.Message())
	}
	return s, err
}

func (f *fakeTemporal) Steps(_ context.Context, wf, run string) ([]drawdown.Step, error) {
	if f.down {
		return nil, errors.New("connection refused")
	}
	return f.steps[wf+"/"+run], nil
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
	store   *warp.Store
	memory  string // the server's memory file
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
	s := &drawdown.Server{Skills: &treadle.Library{Store: store}, Commands: shipment.Registry, Store: store, Ref: loom.DefaultRef, Registry: shipment.Registry(), Temporal: fake,
		TemporalUI: "http://localhost:8233", Examples: map[string]string{"shipment": shipment.Program}, MemoryFile: filepath.Join(dir, "memory.json")}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &world{t: t, srv: srv, fake: fake, sources: dir, store: store, memory: s.MemoryFile}
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

// submit starts a run of program on the default history and fails the
// test unless it is accepted.
func (w *world) submit(program string) {
	w.t.Helper()
	if code, _, raw := w.call("POST", "/api/runs", map[string]string{"program": program}); code != 202 {
		w.t.Fatalf("submit %s: %d %s", program, code, raw)
	}
}

// TestInv_FakeRecordsOutsideTheTimeout: the fake Temporal runs and records
// a submitted program itself, which real Temporal leaves to a worker, so it
// must finish even when the server's Temporal timeout has expired.
func TestInv_FakeRecordsOutsideTheTimeout(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p, err := draft.Compile(context.Background(), shipment.Registry(), draft.Source(`(echo "a")`))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.fake.Submit(ctx, loom.RunInput{Program: `(echo "a")`, Plan: p, Ref: loom.DefaultRef}); err != nil {
		t.Errorf("submit with an expired context: %v", err)
	}
}

func TestCompile(t *testing.T) {
	w := newWorld(t)
	code, m, _ := w.call("POST", "/api/compile", map[string]string{"program": shipment.Program})
	if code != 200 || len(m["plan"].(map[string]any)["nodes"].([]any)) != 4 {
		t.Fatalf("compile shipment: %d %v", code, m)
	}
	if sh, ok := m["shape"].(map[string]any); !ok || sh["kind"] == "" {
		t.Fatalf("compile shipment has no shape: %v", m["shape"])
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
	code, second, raw := w.call("POST", "/api/runs", map[string]string{"program": shipment.Program})
	if code != 202 {
		t.Fatalf("second submit: %d %s", code, raw)
	}
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
	if sh, ok := rec["shape"].(map[string]any); !ok || sh["kind"] != "pipe" || len(sh["parts"].([]any)) != 2 {
		t.Errorf("a run's record has no composition: %v", rec["shape"])
	}
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
	w.submit(`(echo "a")`)
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
		if code, _, raw := w.call("POST", "/api/runs", map[string]string{"program": fmt.Sprintf(`(echo "%d")`, i)}); code != 202 {
			t.Fatalf("submit %d: %d %s", i, code, raw)
		}
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
	w.submit(`(echo "a")`)
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
// keeps serving until DRAWDOWN_BROWSER_DONE (a file path) exists. Besides
// the hello world's commands it has ask, agent and browse, so programs
// that use them compile and show (the fake runs only the hello world's).
func TestServeForBrowser(t *testing.T) {
	addr := os.Getenv("DRAWDOWN_BROWSER_ADDR")
	if addr == "" {
		t.Skip("set DRAWDOWN_BROWSER_ADDR to serve the UI for a browser test")
	}
	w := newWorld(t)
	w.fake.realTime = true // runs this month, for the Costs page
	commands := func() *registry.Registry {
		reg := shipment.Registry()
		reg.MustRegister(pirn.BuiltinSpec())
		reg.MustRegister(pirn.AgentBuiltinSpec())
		reg.MustRegister(pirn.ActBuiltinSpec())
		reg.MustRegister(reed.BuiltinSpec())
		return reg
	}
	ui := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: commands, Store: w.store, Ref: loom.DefaultRef, Registry: commands(),
		Temporal: w.fake, TemporalUI: "http://localhost:8233", Examples: map[string]string{"shipment": shipment.Program}, MemoryFile: w.memory, StoreDir: w.store.Dir()}
	// Calls no record holds, as loom's worker counts them in the usage
	// ledger (roadmap 10.4.1): a front-door ask, a retried attempt and a
	// run that failed, for the Costs page.
	now := time.Now().UTC()
	w.ledger(
		loom.LedgerEntry{Kind: loom.LedgerFrontDoor, At: now, Workflow: "ask-browser", Run: "a", Activity: "1", Calls: []pirn.Call{{Model: "claude-sonnet-5-5", Input: 2400, Output: 310}, {Model: "claude-sonnet-5-5", Input: 2600, Output: 280}}},
		loom.LedgerEntry{Kind: loom.LedgerAttempt, At: now, Workflow: "loom-browser/plan", Run: "p", Activity: "1", Node: "n0", Step: "agent", Attempt: 1, Failed: true, Calls: []pirn.Call{{Model: "claude-sonnet-5-5", Input: 18000, Output: 1200}}},
		loom.LedgerEntry{Kind: loom.LedgerAttempt, At: now, Workflow: "loom-browser/plan", Run: "p", Activity: "2", Node: "n0", Step: "agent", Attempt: 2, Failed: true, Calls: []pirn.Call{{Model: "claude-sonnet-5-5", Input: 21000, Output: 1500}}},
	)
	s := &http.Server{Addr: addr, Handler: ui.Handler()}
	go s.ListenAndServe()
	defer s.Close()
	os.WriteFile(os.Getenv("DRAWDOWN_BROWSER_SOURCES"), []byte(w.sources), 0o644)
	// Until DONE exists, however long the browser takes: go test's
	// -timeout bounds it (review 38: it stopped after 5 minutes).
	for {
		if _, err := os.Stat(os.Getenv("DRAWDOWN_BROWSER_DONE")); err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// TestBranchesMergesAndBeliefs: runs on a branch, a merge back into main,
// and what the UI shows for each: the refs, each ref's runs, the merge
// row, and the merged beliefs.
func TestBranchesMergesAndBeliefs(t *testing.T) {
	w := newWorld(t)
	const whatif = "refs/loom/what-if"
	const slip = "(pipe (source \"factory\") (assess \"production will slip\"))"
	rec := &loom.Recorder{Store: w.fake.store}
	if code, _, raw := w.call("POST", "/api/runs", map[string]string{"program": shipment.Program}); code != 202 {
		t.Fatal(raw)
	}
	mainHead, _, _ := w.fake.store.Resolve(context.Background(), loom.DefaultRef)
	if err := rec.Branch(context.Background(), loom.BranchRecordInput{To: whatif, At: mainHead}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(w.sources, "factory.txt"), []byte("on-time\nLine 2 repaired.\n"), 0o644)
	for _, src := range []string{shipment.Program, slip} {
		if code, _, raw := w.call("POST", "/api/runs", map[string]string{"program": src, "ref": whatif}); code != 202 {
			t.Fatal(raw)
		}
	}
	if code, _, raw := w.call("POST", "/api/runs", map[string]string{"program": `(echo "main only")`}); code != 202 {
		t.Fatal(raw)
	}
	whatifHead, _, _ := w.fake.store.Resolve(context.Background(), whatif)
	if _, err := rec.Merge(context.Background(), loom.MergeRecordInput{Into: loom.DefaultRef, Theirs: whatifHead,
		WorkflowID: "loom-merge-x", RunID: "merge-1", At: time.Unix(1761999999, 0)}); err != nil {
		t.Fatal(err)
	}

	_, m, _ := w.call("GET", "/api/refs", nil)
	if fmt.Sprint(m["refs"]) != "[refs/loom/runs refs/loom/what-if]" || m["default"] != loom.DefaultRef {
		t.Errorf("refs = %v", m)
	}
	// Each agent's head commit comes with it, for the agent list.
	headOf := func(ref string) string {
		id, _, _ := w.fake.store.Resolve(context.Background(), ref)
		return string(id)
	}
	if heads, _ := m["heads"].(map[string]any); heads[whatif] != headOf(whatif) || heads[loom.DefaultRef] != headOf(loom.DefaultRef) {
		t.Errorf("heads = %v", m["heads"])
	}
	_, m, _ = w.call("GET", "/api/runs?ref="+whatif, nil)
	if runs := m["runs"].([]any); len(runs) != 3 { // the branch's two runs and the run it started from
		t.Errorf("what-if runs = %d, want 3: %v", len(runs), runs)
	}
	_, m, _ = w.call("GET", "/api/runs", nil)
	var merge map[string]any
	for _, r := range m["runs"].([]any) {
		if r.(map[string]any)["status"] == "Merged" {
			merge = r.(map[string]any)
		}
	}
	if merge == nil || merge["merged"] != string(whatifHead) || merge["parent"] == nil {
		t.Errorf("no merge row on main: %v", m["runs"])
	}
	_, m, _ = w.call("GET", "/api/beliefs", nil)
	bs := m["beliefs"].([]any)
	got := map[string]string{}
	for _, b := range bs {
		b := b.(map[string]any)
		outs := b["outputs"].(map[string]any)
		got[b["program"].(string)] = fmt.Sprint(outs["n3"], outs["n1"], outs["n0"])
	}
	if len(got) != 3 || !strings.Contains(got[shipment.Program], "for:     weather\n") ||
		!strings.Contains(got[slip], "production will slip: NOT SUPPORTED") || !strings.Contains(got[`(echo "main only")`], "main only") {
		t.Errorf("merged beliefs = %v", got)
	}

	for _, bad := range []string{"refs/heads/main", "refs/loom/a..b", "HEAD"} {
		if code, _, _ := w.call("GET", "/api/runs?ref="+bad, nil); code != 400 {
			t.Errorf("runs?ref=%s: %d, want 400", bad, code)
		}
		if code, _, _ := w.call("GET", "/api/beliefs?ref="+bad, nil); code != 400 {
			t.Errorf("beliefs?ref=%s: %d, want 400", bad, code)
		}
		if code, _, _ := w.call("POST", "/api/runs", map[string]string{"program": `(echo "x")`, "ref": bad}); code != 400 {
			t.Errorf("submit ref %s: %d, want 400", bad, code)
		}
	}
	if code, m, _ := w.call("GET", "/api/beliefs?ref=refs/loom/empty", nil); code != 200 || len(m["beliefs"].([]any)) != 0 {
		t.Errorf("beliefs of a missing ref: %d %v", code, m)
	}
}

// TestList_CraftedMergeTrailerDoesNotCrash: a root commit carrying a
// Loom-Merge trailer is listed as an ordinary record, never dereferenced as
// a merge. (Review 4: it crashed the runs list.)
func TestList_CraftedMergeTrailerDoesNotCrash(t *testing.T) {
	w := newWorld(t)
	s := w.fake.store
	ctx := context.Background()
	tree, _ := s.PutTree(ctx, nil)
	c, err := s.Commit(ctx, warp.CommitSpec{Tree: tree, Message: "crafted",
		Trailers: []warp.Trailer{{Key: loom.TrailerMerge, Value: "x"}},
		Author:   warp.Signature{Name: "x", Email: "x@x", When: time.Unix(1, 0)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Advance(ctx, "refs/loom/crafted", "", c); err != nil {
		t.Fatal(err)
	}
	if code, m, raw := w.call("GET", "/api/runs?ref=refs/loom/crafted", nil); code != 200 || len(m["runs"].([]any)) != 1 {
		t.Fatalf("%d %s", code, raw)
	}
	if code, _, _ := w.call("GET", "/api/beliefs?ref=refs/loom/crafted", nil); code != 200 {
		t.Fatalf("beliefs of a record without an index: %d", code)
	}
}

// TestLive_ReturnsFramesAndReportsTemporalErrors: the live endpoint passes
// on the browsing steps' latest frames, and says when Temporal is down.
func TestLive_ReturnsFramesAndReportsTemporalErrors(t *testing.T) {
	w := newWorld(t)
	w.fake.live = map[string][]drawdown.LiveFrame{"wf-1": {{Activity: "5", Attempt: 1, URL: "https://a.example/", Image: "data:image/jpeg;base64,/9g="}}}
	code, m, _ := w.call("GET", "/api/live/wf-1", nil)
	if fr := m["frames"].([]any); code != 200 || len(fr) != 1 || fr[0].(map[string]any)["url"] != "https://a.example/" {
		t.Errorf("%d %v", code, m)
	}
	if _, m, _ := w.call("GET", "/api/live/other", nil); len(m["frames"].([]any)) != 0 {
		t.Errorf("unknown workflow: %v", m)
	}
	w.fake.down = true
	if _, m, _ := w.call("GET", "/api/live/wf-1", nil); m["temporalError"] == nil {
		t.Errorf("Temporal down: %v", m)
	}
}

// TestSteps_ReportsTemporalErrorsWithoutFailing: the timeline's steps come
// from Temporal; when Temporal is down the endpoint still answers, with
// no steps and the error, so the run's record stays readable.
func TestSteps_ReportsTemporalErrorsWithoutFailing(t *testing.T) {
	w := newWorld(t)
	w.fake.steps = map[string][]drawdown.Step{"wf/run": {{Node: "n0", Activity: "Echo", Status: "Completed", Attempts: 2}}}
	code, m, _ := w.call("GET", "/api/steps/wf/run", nil)
	steps, _ := m["steps"].([]any)
	if code != 200 || len(steps) != 1 || steps[0].(map[string]any)["attempts"] != 2.0 || m["temporalError"] != nil {
		t.Errorf("steps: %d %v", code, m)
	}
	w.fake.down = true
	code, m, _ = w.call("GET", "/api/steps/wf/run", nil)
	if steps, _ := m["steps"].([]any); code != 200 || steps == nil || len(steps) != 0 || !strings.Contains(fmt.Sprint(m["temporalError"]), "connection refused") {
		t.Errorf("steps with Temporal down: %d %v", code, m)
	}
}

// SetBudget sets a schedule's budget as loom.SetBudget does: raising it
// resumes one its budget paused.
func (f *fakeTemporal) SetBudget(_ context.Context, name string, b loom.Budget) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sched[name]
	if s == nil {
		return serviceerror.NewNotFound("schedule not found")
	}
	was := 0.0
	if s.Budget != nil {
		was = s.Budget.USD
	}
	s.Budget = nil
	if b.USD > 0 {
		s.Budget = &b
	}
	if _, byBudget := loom.BudgetPaused(s.Note); s.Paused && byBudget && (b.USD == 0 || b.USD > was) {
		s.Paused, s.Note = false, ""
	}
	return nil
}
