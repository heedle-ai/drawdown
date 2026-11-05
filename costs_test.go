package drawdown_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/treadle"
)

// claudeRun records a run of src, whose Claude steps answered as outs
// (by node), at at, started by schedule if not "", and lists it as a
// finished execution; it returns its workflow and run IDs.
func (w *world) claudeRun(src string, outs map[string]any, at time.Time, schedule string) (string, string) {
	w.t.Helper()
	reg := draft.DefaultRegistry()
	reg.MustRegister(pirn.BuiltinSpec())
	reg.MustRegister(pirn.AgentBuiltinSpec())
	reg.MustRegister(pirn.ActBuiltinSpec())
	p, err := loom.Compile(context.Background(), reg, src)
	if err != nil {
		w.t.Fatal(err)
	}
	outputs := map[string]string{}
	for n, v := range outs {
		b, _ := json.Marshal(v)
		outputs[n] = string(b)
	}
	w.fake.mu.Lock()
	defer w.fake.mu.Unlock()
	wf, run := "loom-claude-"+schedule, "claude-run-"+at.Format("20060102150405")
	if _, err := (&loom.Recorder{Store: w.store}).Record(context.Background(), loom.RecordInput{Program: src, Plan: p, Result: plan.Result{Outputs: outputs},
		Ref: loom.DefaultRef, WorkflowID: wf, RunID: run, At: at, Schedule: schedule}); err != nil {
		w.t.Fatal(err)
	}
	w.fake.execs = append(w.fake.execs, drawdown.Execution{WorkflowID: wf, RunID: run, Status: "Completed", Start: at, Close: at.Add(time.Second), Ref: loom.DefaultRef})
	return wf, run
}

const lisbon = `(pipe (ask "Plan three days in Lisbon; I like food and tiles.") (agent "Find the tile museums and their hours.") (act "Book the table." "https://book.example.org/"))`

var lisbonOuts = map[string]any{
	"n0": pirn.Answer{Pirn: 1, Model: "claude-sonnet-5-5", Text: "Day 1…", InputTokens: 1795, OutputTokens: 412},
	"n1": pirn.AgentResult{Answer: pirn.Answer{Pirn: 1, Model: "claude-sonnet-5-5", InputTokens: 48210, OutputTokens: 3907}, Agent: 1, Turns: 9},
	"n2": pirn.ActResult{Answer: pirn.Answer{Pirn: 1, Model: "claude-mythos-5-1", InputTokens: 9000, OutputTokens: 700}, Act: 1, Turns: 4},
}

// TestInv_RunPageShowsTokensAndEstimate: a recorded run's page has each
// Claude step's model and tokens, exactly as recorded, and the estimate:
// with a step whose model has no price, that step has none and the total
// says it isn't complete, never a dollar figure for it; with a price for
// it in your prices file, the whole run has one, naming your prices.
// (Roadmap 10.4: the Lisbon trip shows tokens per step and an estimated
// total.)
func TestInv_RunPageShowsTokensAndEstimate(t *testing.T) {
	w := newWorld(t)
	wf, run := w.claudeRun(lisbon, lisbonOuts, time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC), "")
	code, m, raw := w.call("GET", "/api/runs/"+wf+"/"+run, nil)
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	var got struct {
		Usage struct {
			Steps []loom.StepUsage
			Total loom.Tokens
			Cost  loom.Costs
		}
	}
	b, _ := json.Marshal(m)
	json.Unmarshal(b, &got)
	u := got.Usage
	if len(u.Steps) != 3 || u.Steps[1].Tokens != (loom.Tokens{Input: 48210, Output: 3907}) || u.Steps[1].Requests != 9 || u.Steps[2].Model != "claude-mythos-5-1" ||
		u.Total != (loom.Tokens{Input: 1795 + 48210 + 9000, Output: 412 + 3907 + 700}) {
		t.Fatalf("usage %+v", u)
	}
	want := (1795+48210)*2/1e6 + (412+3907)*10/1e6
	if c := u.Cost; c.Complete || len(c.Unpriced) != 1 || c.Unpriced[0].Node != "n2" || c.AsOf != "2026-11-05" || c.USD < want-1e-9 || c.USD > want+1e-9 {
		t.Fatalf("cost %+v", u.Cost)
	}
	if _, ok := u.Cost.ByModel["claude-mythos-5-1"]; ok {
		t.Error("a dollar figure for a model with no price")
	}
	// Your price for it: the whole run is estimated, saying whose prices.
	prices := filepath.Join(t.TempDir(), "prices.json")
	os.WriteFile(prices, []byte(`{"models":{"claude-mythos-5-1":{"input":100,"output":500}}}`), 0o600)
	w2 := newWorldWith(t, w, prices)
	_, m, _ = w2.call("GET", "/api/runs/"+wf+"/"+run, nil)
	b, _ = json.Marshal(m)
	json.Unmarshal(b, &got)
	if c := got.Usage.Cost; !c.Complete || len(c.Yours) != 1 || c.USD < want+0.9+0.35-1e-9 {
		t.Errorf("with your prices: %+v", c)
	}
}

// TestInv_CostsPage: the Costs page's answer is this month and the six
// before it by model, in the time zone asked for, each with its runs,
// tokens and estimate; a model with no price has tokens and a null
// estimate (never 0); the costliest runs and schedules of the month; the
// price table's date and source. A month or time zone that isn't one is
// refused. (Roadmap 10.4.)
func TestInv_CostsPage(t *testing.T) {
	w := newWorld(t)
	// Recorded in the order they ran, as records are.
	news := map[string]any{"n0": pirn.Answer{Pirn: 1, Model: "claude-sonnet-5-5", InputTokens: 10000, OutputTokens: 1000}}
	w.claudeRun(`(ask "the news")`, news, time.Date(2026, 4, 30, 9, 0, 0, 0, time.UTC), "news") // seven months back: not shown
	w.claudeRun(`(ask "the news")`, news, time.Date(2026, 10, 31, 23, 30, 0, 0, time.UTC), "news")
	w.claudeRun(`(ask "the news")`, news, time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC), "news")
	w.claudeRun(lisbon, lisbonOuts, time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC), "")

	code, m, raw := w.call("GET", "/api/costs?month=2026-11&tz=UTC", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	var v struct {
		Zone, AsOf, Source string
		Months             []struct {
			Month   string
			Runs    int
			Tokens  loom.Tokens
			USD     *float64
			Priced  float64
			ByModel []struct {
				Model  string
				Runs   int
				Tokens loom.Tokens
				USD    *float64
			}
		}
		Runs      []struct{ RunID string }
		Schedules []struct {
			Name string
			Runs int
			USD  *float64
		}
	}
	b, _ := json.Marshal(m)
	json.Unmarshal(b, &v)
	if v.Zone != "UTC" || v.AsOf != "2026-11-05" || !strings.HasPrefix(v.Source, "https://") || len(v.Months) != drawdown.CostMonths {
		t.Fatalf("%+v", v)
	}
	nov, oct := v.Months[0], v.Months[1]
	if nov.Month != "2026-11" || nov.Runs != 2 || nov.USD != nil || nov.Tokens.Input != 1795+48210+9000+10000 || len(nov.ByModel) != 2 {
		t.Fatalf("November %+v", nov)
	}
	for _, x := range nov.ByModel {
		switch {
		case x.Model == "claude-mythos-5-1" && (x.USD != nil || x.Tokens.Input != 9000 || x.Runs != 1):
			t.Errorf("no price: %+v", x)
		case x.Model == "claude-sonnet-5-5" && (x.USD == nil || x.Runs != 2):
			t.Errorf("priced: %+v", x)
		}
	}
	if oct.Month != "2026-10" || oct.Runs != 1 || oct.USD == nil || *oct.USD < 0.03-1e-9 || v.Months[6].Month != "2026-05" || v.Months[6].Runs != 0 {
		t.Errorf("before %+v", v.Months)
	}
	// The page reads "yours" as a list: with no prices file it's empty,
	// never null (the page refused the answer and showed nothing).
	if !strings.Contains(raw, `"yours":[]`) {
		t.Errorf("yours isn't a list: %s", raw)
	}
	if len(v.Runs) != 2 || len(v.Schedules) != 1 || v.Schedules[0].Name != "news" || v.Schedules[0].Runs != 1 {
		t.Errorf("costliest %+v %+v", v.Runs, v.Schedules)
	}
	// In Lisbon (UTC+0 in November) the same; in Tokyo, October's last
	// run is November's.
	_, m, _ = w.call("GET", "/api/costs?month=2026-11&tz=Asia/Tokyo", nil)
	b, _ = json.Marshal(m)
	json.Unmarshal(b, &v)
	if v.Zone != "Asia/Tokyo" || v.Months[0].Runs != 3 {
		t.Errorf("Tokyo: %+v", v.Months[0])
	}
	for _, q := range []string{"?month=November", "?tz=Mars/Olympus", "?tz=Local", "?month=2026-13"} {
		if code, _, raw := w.call("GET", "/api/costs"+q, nil); code != 400 {
			t.Errorf("%s: %d %s", q, code, raw)
		}
	}
}

// TestInv_SchedulesShowSpendAndBudget: the Schedules page has each
// schedule's month to date and last 30 days, as its budget counts them,
// and its budget, which it sets through Temporal: raising it resumes a
// schedule its budget paused; a budget that isn't whole cents from 0, a
// resume with no budget, an unknown schedule or a body that isn't JSON
// is refused. (Roadmap 10.4.)
func TestInv_SchedulesShowSpendAndBudget(t *testing.T) {
	w := newWorld(t)
	if code, _, raw := w.call("POST", "/api/schedules", map[string]string{"name": "news", "program": `(echo "a")`, "every": "1h"}); code != 201 {
		t.Fatalf("%d %s", code, raw)
	}
	now := time.Now().UTC()
	news := map[string]any{"n0": pirn.Answer{Pirn: 1, Model: "claude-sonnet-5-5", InputTokens: 10000, OutputTokens: 1000}}
	w.claudeRun(`(ask "the news")`, news, now.AddDate(0, 0, -40), "news")
	w.claudeRun(`(ask "the news")`, news, now.Add(-2*time.Hour), "")
	w.claudeRun(`(ask "the news")`, news, now.Add(-time.Hour), "news")
	_, m, raw := w.call("GET", "/api/schedules", nil)
	var v struct {
		Spend map[string]map[string]struct {
			Runs int
			USD  *float64
		}
	}
	b, _ := json.Marshal(m)
	json.Unmarshal(b, &v)
	month, last30 := v.Spend["news"]["month"], v.Spend["news"]["last30"]
	inMonth := 0
	if now.Add(-time.Hour).Month() == now.Month() {
		inMonth = 1 // not in the first hour of a month
	}
	if last30.Runs != 1 || last30.USD == nil || *last30.USD < 0.03-1e-9 || month.Runs != inMonth || month.USD == nil {
		t.Fatalf("spend %s", raw)
	}

	w.fake.sched["news"].Paused, w.fake.sched["news"].Note = true, "paused: monthly budget $0.01 reached (est.) in November 2026"
	w.fake.sched["news"].Budget = &loom.Budget{USD: 0.01}
	if code, _, raw := w.call("POST", "/api/schedules/news/budget", map[string]any{"usd": 5, "resumeNextMonth": true}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	if s := w.fake.sched["news"]; s.Paused || s.Budget == nil || *s.Budget != (loom.Budget{USD: 5, ResumeNextMonth: true}) {
		t.Errorf("schedule %+v", s)
	}
	_, _, raw = w.call("GET", "/api/schedules", nil)
	if !strings.Contains(raw, `"budget":{"usd":5,"resumeNextMonth":true}`) {
		t.Errorf("budget not listed: %s", raw)
	}
	for _, bad := range []map[string]any{{"usd": -1}, {"usd": 0.001}, {"usd": 2e6}, {"usd": 0, "resumeNextMonth": true}, {"usd": "5"}} {
		if code, _, raw := w.call("POST", "/api/schedules/news/budget", bad); code != 400 {
			t.Errorf("%v: %d %s", bad, code, raw)
		}
	}
	if code, _, _ := w.call("POST", "/api/schedules/nope/budget", map[string]any{"usd": 5}); code != 404 {
		t.Errorf("unknown schedule: %d", code)
	}
	if code, _, _ := w.call("POST", "/api/schedules/news/budget", nil); code < 400 {
		t.Errorf("no JSON: %d", code)
	}
	if code, _, _ := w.call("POST", "/api/schedules/news/budget", map[string]any{"usd": 0}); code != 200 || w.fake.sched["news"].Budget != nil {
		t.Errorf("removing it: %d %+v", code, w.fake.sched["news"].Budget)
	}
}

// claudeCommands are the hello world's commands and Claude's.
func claudeCommands() *registry.Registry {
	reg := shipment.Registry()
	reg.MustRegister(pirn.BuiltinSpec())
	reg.MustRegister(pirn.AgentBuiltinSpec())
	reg.MustRegister(pirn.ActBuiltinSpec())
	return reg
}

// newWorldWith is a server on w's store and Temporal, with Claude's
// commands and your prices file.
func newWorldWith(t *testing.T, w *world, prices string) *world {
	s := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: claudeCommands, Store: w.store, Ref: loom.DefaultRef, Registry: claudeCommands(), Temporal: w.fake,
		PricesFile: prices}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &world{t: t, srv: srv, fake: w.fake, sources: w.sources, store: w.store}
}

// TestInv_BudgetPausesAScheduleBeforeItsSecondRun: through the page's
// API, a schedule of a Claude step with a $0.01 budget runs once; asked
// to run again, it starts nothing (no record, the run saying why, so the
// page doesn't wait for one), and the schedule is listed paused with the
// budget's note. (Roadmap 10.4 acceptance; the fake Temporal checks with
// loom's own Recorder.Budget, as RunWorkflow does.)
func TestInv_BudgetPausesAScheduleBeforeItsSecondRun(t *testing.T) {
	w := newWorldWith(t, newWorld(t), "")
	w.fake.realTime = true
	if code, _, raw := w.call("POST", "/api/schedules", map[string]string{"name": "news", "program": `(ask "What's new in Lisbon this week? Food, tiles and trams, please.")`, "every": "24h"}); code != 201 {
		t.Fatalf("%d %s", code, raw)
	}
	if code, _, raw := w.call("POST", "/api/schedules/news/budget", map[string]any{"usd": 0.01}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	for i := 0; i < 2; i++ {
		if code, _, raw := w.call("POST", "/api/schedules/news/run", map[string]any{}); code != 200 {
			t.Fatalf("run %d: %d %s", i, code, raw)
		}
	}
	runs := w.fake.sched["news"].Recent
	if len(runs) != 2 {
		t.Fatalf("runs %+v", runs)
	}
	_, first, _ := w.call("GET", "/api/runs/"+runs[0].WorkflowID+"/"+runs[0].RunID, nil)
	_, second, raw := w.call("GET", "/api/runs/"+runs[1].WorkflowID+"/"+runs[1].RunID, nil)
	month := time.Now().UTC().Format("January 2006")
	if first["record"] == nil || second["record"] != nil || second["execution"].(map[string]any)["skipped"] != "paused: monthly budget $0.01 reached (est.) in "+month {
		t.Fatalf("second run: %s", raw)
	}
	_, _, raw = w.call("GET", "/api/schedules", nil)
	if !strings.Contains(raw, `"paused":true,"note":"paused: monthly budget $0.01 reached (est.) in `+month+`"`) {
		t.Errorf("schedule not paused: %s", raw)
	}
}
