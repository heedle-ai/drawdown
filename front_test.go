package drawdown_test

import (
	"bytes"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"slices"
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

type sessionKeys map[string]string

func (m sessionKeys) Lookup(_ context.Context, n string) (string, bool, error) {
	v, ok := m[n]
	return v, ok, nil
}
func (m sessionKeys) Store(_ context.Context, n, v string) error { m[n] = v; return nil }
func (m sessionKeys) Delete(_ context.Context, n string) error   { delete(m, n); return nil }

// TestInv_SignedInRunsOnlyWhereShown: a program whose act steps start
// signed in as you (:signed-in) runs or is scheduled only when the request
// carries exactly those hosts, as the card showed them in red;
// /api/compile gives them, from the program alone (roadmap 9.11, review
// 53).
func TestInv_SignedInRunsOnlyWhereShown(t *testing.T) {
	w := newWorld(t)
	commands := func() *registry.Registry {
		reg := shipment.Registry()
		reg.MustRegister(pirn.ActBuiltinSpec())
		return reg
	}
	ss := &pirn.Sessions{Dir: filepath.Join(t.TempDir(), "sessions"), Vault: sessionKeys{}}
	if err := ss.Save(context.Background(), "forms.example.org", []byte(`{"cookies":[{"name":"sid","value":"v","domain":"forms.example.org"}],"origins":[]}`)); err != nil {
		t.Fatal(err)
	}
	tc := &submitsOnly{fakeTemporal: w.fake}
	ui := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: commands, Store: w.store, Ref: loom.DefaultRef, Registry: commands(), Temporal: tc, Sessions: ss}
	w.srv = httptest.NewServer(ui.Handler())
	t.Cleanup(w.srv.Close)
	prog := `(act "Change my address" "https://forms.example.org/" "cdn.example.org" :signed-in "forms.example.org")`
	hosts := []string{"cdn.example.org", "forms.example.org"}
	_, got, _ := w.call("POST", "/api/compile", map[string]any{"program": prog})
	if in, _ := got["actSignedIn"].([]any); len(in) != 1 || in[0] != "forms.example.org" {
		t.Errorf("compile: %v", got)
	}
	for _, shown := range [][]string{nil, {"cdn.example.org"}, hosts} {
		if code, got, body := w.call("POST", "/api/runs", map[string]any{"program": prog, "actHosts": hosts, "actSignedIn": shown}); code != 422 || got["actSignedIn"] == nil || !strings.Contains(body, "signed in as you on forms.example.org") {
			t.Errorf("run, shown %v: %d %s", shown, code, body)
		}
		if code, _, body := w.call("POST", "/api/schedules", map[string]any{"name": "act", "program": prog, "every": "24h", "actHosts": hosts, "actSignedIn": shown}); code != 422 {
			t.Errorf("schedule, shown %v: %d %s", shown, code, body)
		}
	}
	if len(tc.got) != 0 {
		t.Fatalf("a run started: %v", tc.got)
	}
	w.call("POST", "/api/runs", map[string]any{"program": prog, "actHosts": hosts, "actSignedIn": []string{"forms.example.org"}})
	if len(tc.got) != 1 {
		t.Errorf("shown, it didn't start: %v", tc.got)
	}
}

// schedulesOnly records schedule actions and never starts a run.
type schedulesOnly struct {
	*submitsOnly
	actions []string
}

func (s *schedulesOnly) SetBudget(ctx context.Context, name string, b loom.Budget) error {
	s.actions = append(s.actions, name+" budget")
	return s.submitsOnly.SetBudget(ctx, name, b)
}

func (s *schedulesOnly) ScheduleAction(ctx context.Context, name, action string) error {
	s.actions = append(s.actions, name+" "+action)
	if action == "run" {
		return nil
	}
	return s.submitsOnly.ScheduleAction(ctx, name, action)
}

// TestInv_EveryRunStartIsHere: every drawdown path that starts a run
// (a run, a schedule, a schedule's run-now or resume) refuses a program
// whose act steps start signed in as you unless the request comes from
// this machine; from another host, through a proxy, another site,
// another origin, another port or a rebound name it starts nothing. No
// other handler reaches Temporal's ways of starting a run (review 53,
// round 2).
func TestInv_EveryRunStartIsHere(t *testing.T) {
	w := newWorld(t)
	commands := func() *registry.Registry {
		reg := shipment.Registry()
		reg.MustRegister(pirn.ActBuiltinSpec())
		return reg
	}
	tc := &schedulesOnly{submitsOnly: &submitsOnly{fakeTemporal: w.fake}}
	ui := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: commands, Store: w.store, Ref: loom.DefaultRef, Registry: commands(), Temporal: tc}
	w.srv = httptest.NewServer(ui.Handler())
	t.Cleanup(w.srv.Close)
	signed := `(act "Change my address" "https://forms.example.org/" :signed-in "forms.example.org")`
	plain := `(act "Join as Ada" "https://forms.example.org/")`
	hosts := []string{"forms.example.org"}
	if code, _, body := w.call("POST", "/api/schedules", map[string]any{"name": "signed", "program": signed, "every": "24h", "actHosts": hosts, "actSignedIn": hosts}); code != 201 {
		t.Fatalf("schedule from here: %d %s", code, body)
	}
	if code, _, body := w.call("POST", "/api/schedules", map[string]any{"name": "plain", "program": plain, "every": "24h", "actHosts": hosts}); code != 201 {
		t.Fatalf("schedule from here: %d %s", code, body)
	}
	call := func(path string, body any, headers ...string) int {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", w.srv.URL+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			if headers[i] == "Host" {
				req.Host = headers[i+1]
			}
			req.Header.Set(headers[i], headers[i+1])
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	port := strings.TrimPrefix(w.srv.URL, "http://127.0.0.1")
	elsewhere := map[string][]string{
		"through a proxy": {"X-Forwarded-For", "100.64.0.7"},
		"forwarded":       {"Forwarded", "for=100.64.0.7"},
		"another site":    {"Sec-Fetch-Site", "cross-site"},
		"another origin":  {"Origin", "https://evil.example"},
		"another port":    {"Origin", "http://127.0.0.1:9999", "Sec-Fetch-Site", "same-site"},
		"a rebound name":  {"Host", "evil.example" + port},
	}
	for name, h := range elsewhere {
		if code := call("/api/runs", map[string]any{"program": signed, "actHosts": hosts, "actSignedIn": hosts}, h...); code < 400 {
			t.Errorf("run, %s: %d", name, code)
		}
		if code := call("/api/schedules", map[string]any{"name": "again", "program": signed, "every": "24h", "actHosts": hosts, "actSignedIn": hosts}, h...); code < 400 {
			t.Errorf("schedule, %s: %d", name, code)
		}
		for _, a := range []string{"run", "resume"} {
			if code := call("/api/schedules/signed/"+a, map[string]any{}, h...); code != 403 {
				t.Errorf("%s, %s: %d", a, name, code)
			}
		}
		// A new budget can resume a schedule its budget paused.
		if code := call("/api/schedules/signed/budget", map[string]any{"usd": 5}, h...); code != 403 {
			t.Errorf("budget, %s: %d", name, code)
		}
	}
	if len(tc.got) != 0 || len(tc.actions) != 0 {
		t.Fatalf("started from elsewhere: runs %v, actions %v", tc.got, tc.actions)
	}
	// A program not signed in runs or resumes from another host; from
	// here, a signed-in one does.
	for _, a := range []string{"run", "resume"} {
		if code := call("/api/schedules/plain/"+a, map[string]any{}, "X-Forwarded-For", "100.64.0.7"); code != 200 {
			t.Errorf("plain %s through a proxy: %d", a, code)
		}
		if code := call("/api/schedules/signed/"+a, map[string]any{}); code != 200 {
			t.Errorf("signed %s from here: %d", a, code)
		}
	}
	if want := []string{"plain run", "signed run", "plain resume", "signed resume"}; !slices.Equal(tc.actions, want) {
		t.Errorf("actions %v, want %v", tc.actions, want)
	}
	if code := call("/api/schedules/plain/budget", map[string]any{"usd": 5}, "X-Forwarded-For", "100.64.0.7"); code != 200 {
		t.Errorf("plain budget through a proxy: %d", code)
	}
	// Every method of Temporal (and Budgeter) is classed as starting a run
	// of the person's program or not, so one added later fails here until
	// it's classed (review 53, round 3).
	starts := map[string]bool{"Submit": true, "CreateSchedule": true, "ScheduleAction": true, "SetBudget": true}
	others := map[string]bool{"List": true, "Describe": true, "Steps": true, "Live": true, "ChangeSkills": true, "Writes": true, "DecideWrite": true, "DecideForm": true, "WriteProgram": true, "Ask": true, "ListSkills": true, "Schedules": true}
	for _, it := range []reflect.Type{reflect.TypeFor[drawdown.Temporal](), reflect.TypeFor[drawdown.Budgeter]()} {
		for i := range it.NumMethod() {
			if m := it.Method(i).Name; !starts[m] && !others[m] {
				t.Errorf("%s.%s: class it as starting runs or not", it.Name(), m)
			}
		}
	}
	// Whatever the receiver or alias, only these handlers call a method
	// that starts runs, and each checks signedInShown or mayStartSchedule.
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, f := range pkgs["drawdown"].Files {
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			// TemporalClient is the interface's own adapter onto loom.
			if fd.Recv != nil {
				if id, ok := fd.Recv.List[0].Type.(*ast.Ident); ok && id.Name == "TemporalClient" {
					continue
				}
			}
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				if c, ok := n.(*ast.CallExpr); ok {
					if sel, ok := c.Fun.(*ast.SelectorExpr); ok && starts[sel.Sel.Name] {
						found = append(found, fd.Name.Name)
					}
				}
				return true
			})
		}
	}
	slices.Sort(found)
	if want := []string{"createSchedule", "scheduleAction", "setBudget", "submit"}; !slices.Equal(found, want) {
		t.Errorf("functions that start runs: %v, want %v; check each with signedInShown or mayStartSchedule", found, want)
	}
}
