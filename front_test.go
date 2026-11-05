package drawdown_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/treadle"
)

// TestInv_AskRunsOnAWorker: Ask heedle sends the request, the earlier
// turns, today and the time zone to a worker's Claude and answers its
// proposal (summary, program and plan, any schedule); nothing runs; a
// request it can't propose for is 422, a bad request 422 before Claude is
// asked, and a worker or Temporal failure 502. (Roadmap 8.3.)
func TestInv_AskRunsOnAWorker(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	writer := func(reply string) *loom.Writer {
		return &loom.Writer{Asker: claude(reply), Commands: func(context.Context) (*registry.Registry, []loom.Command, error) {
			reg := shipment.Registry()
			return reg, loom.Commands(reg, loom.BuiltinCommands), nil
		}}
	}
	w.fake.writer = writer("```json\n" + `{"summary": "I'll check the shipment every morning.", "program": "(pipe (par (source \"weather\") (source \"carrier\")) (assess \"late\"))", "cron": "0 8 * * *", "timeZone": "Europe/Lisbon", "name": "shipment-check"}` + "\n```")
	code, got, body := w.call("POST", "/api/ask", map[string]any{"request": "Check the shipment every morning at 8",
		"earlier": []map[string]string{{"request": "check the shipment", "summary": "s", "program": "(echo)"}}, "today": "2026-11-04", "timeZone": "Europe/Lisbon"})
	sched, _ := got["schedule"].(map[string]any)
	if code != 200 || got["summary"] != "I'll check the shipment every morning." || got["plan"] == nil || got["name"] != "shipment-check" || sched["cron"] != "0 8 * * *" {
		t.Errorf("ask: %d %s", code, body)
	}
	if refs := must(w.store.Refs(ctx, "refs/loom/")); len(refs) != 0 {
		t.Errorf("asking ran something: %v", refs)
	}
	w.fake.writer = writer("no")
	if code, _, body := w.call("POST", "/api/ask", map[string]any{"request": "x"}); code != 422 || !strings.Contains(body, "no program") {
		t.Errorf("no proposal: %d %s", code, body)
	}
	for _, bad := range []map[string]any{{"request": ""}, {"request": "x", "today": "tomorrow"}, {"request": "x", "timeZone": "Local"}} {
		if code, _, body := w.call("POST", "/api/ask", bad); code != 422 {
			t.Errorf("%v: %d %s", bad, code, body)
		}
	}
	w.fake.down = true
	if code, _, _ := w.call("POST", "/api/ask", map[string]any{"request": "x"}); code != 502 {
		t.Errorf("Temporal down: %d", code)
	}
}

// TestInv_AskDisclosesActHosts: a proposal with act steps comes with the
// hosts they may click, type and submit forms on without asking again,
// for the card to disclose before Run; one without act steps has none.
// (Roadmap 9.5.)
func TestInv_AskDisclosesActHosts(t *testing.T) {
	w := newWorld(t)
	reg := shipment.Registry()
	reg.MustRegister(pirn.ActBuiltinSpec())
	writer := func(reply string) *loom.Writer {
		return &loom.Writer{Asker: claude(reply), Commands: func(context.Context) (*registry.Registry, []loom.Command, error) {
			return reg, loom.Commands(reg, loom.BuiltinCommands), nil
		}}
	}
	w.fake.writer = writer("```json\n" + `{"summary": "I'll sign you up.", "program": "(act \"Join as Ada\" \"https://forms.example.org/volunteer\" \"cdn.example.org\")"}` + "\n```")
	code, got, body := w.call("POST", "/api/ask", map[string]any{"request": "Sign me up as a volunteer"})
	hosts, _ := got["actHosts"].([]any)
	if code != 200 || len(hosts) != 2 || hosts[0] != "cdn.example.org" || hosts[1] != "forms.example.org" || got["plan"] == nil {
		t.Errorf("ask: %d %s", code, body)
	}
	w.fake.writer = writer("```json\n" + `{"summary": "Hi.", "program": "(echo \"hi\")"}` + "\n```")
	if code, got, body := w.call("POST", "/api/ask", map[string]any{"request": "Say hi"}); code != 200 || got["actHosts"] != nil {
		t.Errorf("no act step: %d %s", code, body)
	}
}

// submitsOnly is the fake Temporal, but a submitted run is only kept,
// not run: the fake's worker has no act.
type submitsOnly struct {
	*fakeTemporal
	got []loom.RunInput
}

func (s *submitsOnly) Submit(_ context.Context, in loom.RunInput) (string, string, error) {
	s.got = append(s.got, in)
	return "wf", "run", nil
}

// TestInv_ActRunsOnlyWhereShown: a program with act steps runs or is
// scheduled only when the request carries exactly the hosts the page
// showed it may act on (loom.ActHosts); otherwise 422, naming them, and
// nothing starts. /api/compile gives the hosts for the editor to show.
// (Review 39: only the front door's card disclosed them, and the editor,
// a changed program or a direct request ran act steps unannounced.)
func TestInv_ActRunsOnlyWhereShown(t *testing.T) {
	w := newWorld(t)
	commands := func() *registry.Registry {
		reg := shipment.Registry()
		reg.MustRegister(pirn.ActBuiltinSpec())
		return reg
	}
	tc := &submitsOnly{fakeTemporal: w.fake}
	ui := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: commands, Store: w.store, Ref: loom.DefaultRef, Registry: commands(), Temporal: tc}
	w.srv = httptest.NewServer(ui.Handler())
	t.Cleanup(w.srv.Close)
	prog := `(act "Join as Ada" "https://forms.example.org/" "cdn.example.org")`
	_, got, _ := w.call("POST", "/api/compile", map[string]any{"program": prog})
	if hosts, _ := got["actHosts"].([]any); len(hosts) != 2 || hosts[0] != "cdn.example.org" {
		t.Errorf("compile: %v", got)
	}
	for _, shown := range [][]string{nil, {"forms.example.org"}, {"forms.example.org", "cdn.example.org"}, {"cdn.example.org", "forms.example.org", "x.example.org"}} {
		if code, got, body := w.call("POST", "/api/runs", map[string]any{"program": prog, "actHosts": shown}); code != 422 || got["actHosts"] == nil || !strings.Contains(body, "stop before sending and ask you") {
			t.Errorf("run, shown %v: %d %s", shown, code, body)
		}
		if code, _, body := w.call("POST", "/api/schedules", map[string]any{"name": "act", "program": prog, "every": "24h", "actHosts": shown}); code != 422 {
			t.Errorf("schedule, shown %v: %d %s", shown, code, body)
		}
	}
	if len(tc.got) != 0 {
		t.Fatalf("a run started: %v", tc.got)
	}
	if code, _, body := w.call("POST", "/api/runs", map[string]any{"program": prog, "actHosts": []string{"cdn.example.org", "forms.example.org"}}); code != 202 || len(tc.got) != 1 {
		t.Errorf("shown: %d %s", code, body)
	}
	if code, _, body := w.call("POST", "/api/runs", map[string]any{"program": `(echo "hi")`}); code != 202 {
		t.Errorf("no act step: %d %s", code, body)
	}
	// Roadmap 9.7: act steps stop before sending and ask, and the page says
	// so; one that sends without asking runs only where that was shown too.
	both := []string{"cdn.example.org", "forms.example.org"}
	if _, _, body := w.call("POST", "/api/runs", map[string]any{"program": prog}); !strings.Contains(body, "stop before sending and ask you") {
		t.Errorf("an asking step's refusal: %s", body)
	}
	if code, _, body := w.call("POST", "/api/runs", map[string]any{"program": prog, "actHosts": both, "actSendsFreely": both}); code != 422 {
		t.Errorf("shown as sending freely, but it asks: %d %s", code, body)
	}
	free := `(act "Join as Ada" "https://forms.example.org/" "cdn.example.org" :send-without-asking)`
	_, got, _ = w.call("POST", "/api/compile", map[string]any{"program": free})
	if f, _ := got["actSendsFreely"].([]any); len(f) != 2 {
		t.Errorf("compile, sending freely: %v", got)
	}
	tc.got = nil
	for _, shown := range [][]string{nil, {"forms.example.org"}} {
		if code, got, body := w.call("POST", "/api/runs", map[string]any{"program": free, "actHosts": both, "actSendsFreely": shown}); code != 422 || got["actSendsFreely"] == nil || !strings.Contains(body, "without asking again") {
			t.Errorf("sending freely, shown %v: %d %s", shown, code, body)
		}
		if code, _, body := w.call("POST", "/api/schedules", map[string]any{"name": "act", "program": free, "every": "24h", "actHosts": both, "actSendsFreely": shown}); code != 422 {
			t.Errorf("schedule sending freely, shown %v: %d %s", shown, code, body)
		}
	}
	if len(tc.got) != 0 {
		t.Fatalf("a run that sends without asking started unannounced: %v", tc.got)
	}
	if code, _, body := w.call("POST", "/api/runs", map[string]any{"program": free, "actHosts": both, "actSendsFreely": both}); code != 202 || len(tc.got) != 1 {
		t.Errorf("sending freely, shown: %d %s", code, body)
	}
	// Roadmap 9.8: the details a step may use run only where they were
	// shown too.
	uses := `(act "Join as me" "https://forms.example.org/" :uses "email name")`
	_, got, _ = w.call("POST", "/api/compile", map[string]any{"program": uses})
	if u, _ := got["actUses"].([]any); len(u) != 2 || u[0] != "name" {
		t.Errorf("compile, uses: %v", got)
	}
	tc.got = nil
	for _, shown := range [][]string{nil, {"name"}, {"email", "name"}} {
		if code, got, body := w.call("POST", "/api/runs", map[string]any{"program": uses, "actHosts": []string{"forms.example.org"}, "actUses": shown}); code != 422 || got["actUses"] == nil || !strings.Contains(body, "may use your name, email") {
			t.Errorf("uses, shown %v: %d %s", shown, code, body)
		}
	}
	if len(tc.got) != 0 {
		t.Fatalf("a run using details started unannounced: %v", tc.got)
	}
	if code, _, body := w.call("POST", "/api/runs", map[string]any{"program": uses, "actHosts": []string{"forms.example.org"}, "actUses": []string{"name", "email"}}); code != 202 || len(tc.got) != 1 {
		t.Errorf("uses, shown: %d %s", code, body)
	}
}
