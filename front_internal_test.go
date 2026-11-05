package drawdown

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

// TestInv_ReadyChecksAsARunWould: /api/ready compiles a program as a run
// would (with the store's newest skills) and says whether it can run now:
// each connector its skills and agent steps ask for, ready or why not,
// and the Anthropic key; a program that doesn't compile is 422 and a
// connectors file that fails its check is said, never "ready"; keys are
// read as steps read them, and agent and skill steps need an agent image.
// So a proposal's card can check again after something is connected.
// (Roadmap 8.2; review 33.)
func TestInv_ReadyChecksAsARunWould(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	ctx := context.Background()
	store, err := warp.Init(ctx, t.TempDir()+"/s.git")
	if err != nil {
		t.Fatal(err)
	}
	lib := &treadle.Library{Store: store}
	if _, err := lib.Add(ctx, map[string][]byte{"SKILL.md": []byte("---\nname: trip\ndescription: Plans trips.\nmetadata:\n  connectors: \"search maps\"\n---\nPlan it.\n")}, time.Now()); err != nil {
		t.Fatal(err)
	}
	cs := pirn.Connectors{{Name: "search", URL: "https://search.example/mcp", TokenEnv: "SEARCH_KEY"}}
	var csErr error
	keys := memSecrets{"SEARCH_KEY": "s"}
	// The shipment's commands, browse and act.
	commands := func() *registry.Registry {
		reg := shipment.Registry()
		if err := reg.Register(reed.BuiltinSpec()); err != nil {
			t.Fatal(err)
		}
		if err := reg.Register(pirn.ActBuiltinSpec()); err != nil {
			t.Fatal(err)
		}
		return reg
	}
	s := &Server{Store: store, Ref: loom.DefaultRef, Skills: lib, Commands: commands, Registry: commands(),
		Connectors: func() (pirn.Connectors, error) { return cs, csErr }, Secrets: keys}
	call := func(program string) (int, loom.Readiness) {
		b, _ := json.Marshal(map[string]string{"program": program})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8090/api/ready", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		s.Handler().ServeHTTP(rec, req)
		var r loom.Readiness
		json.Unmarshal(rec.Body.Bytes(), &r)
		return rec.Code, r
	}
	code, r := call(`(trip "Lisbon")`)
	if code != 200 || r.Ready || r.Claude != "key" || len(r.Needs) != 2 || r.Needs[0].Connector != "maps" || r.Needs[0].Problem != "absent" || r.Needs[1].Problem != "" {
		t.Errorf("no maps, no key: %d %+v", code, r)
	}
	cs = append(cs, pirn.Connector{Name: "maps", URL: "https://maps.example/mcp", TokenEnv: "MAPS_KEY"})
	keys["ANTHROPIC_API_KEY"] = "k"
	if _, r := call(`(trip "Lisbon")`); r.Ready || r.Needs[0].Problem != "key" || r.Needs[0].Key != "MAPS_KEY" {
		t.Errorf("maps without its key: %+v", r)
	}
	keys["MAPS_KEY"] = "m"
	if _, r := call(`(trip "Lisbon")`); r.Ready || r.Agent == "" {
		t.Errorf("no agent image: %+v", r)
	}
	s.Agents = true
	if _, r := call(`(trip "Lisbon")`); !r.Ready {
		t.Errorf("all there: %+v", r)
	}
	// Keys are read as steps read them (StepKeys, such as the OAuth vault
	// that refreshes a signed-in token), not from the keychain directly
	// (review 33).
	s.StepKeys = memSecrets{"SEARCH_KEY": "s", "ANTHROPIC_API_KEY": "k"}
	if _, r := call(`(trip "Lisbon")`); r.Ready || r.Needs[0].Problem != "key" {
		t.Errorf("steps can't read the maps key: %+v", r)
	}
	s.StepKeys = nil
	if _, r := call(`(echo "hi")`); !r.Ready || len(r.Needs) != 0 || r.Claude != "" {
		t.Errorf("needs nothing: %+v", r)
	}
	// Review 35: a browse step needs a browser image.
	if _, r := call(`(browse "example.org")`); r.Ready || r.Browser == "" {
		t.Errorf("browse with no browser image: %+v", r)
	}
	s.Browsers = true
	if _, r := call(`(browse "example.org")`); !r.Ready {
		t.Errorf("browse with a browser image: %+v", r)
	}
	// Roadmap 9.5: an act step needs Claude and a browser-agent image.
	if _, r := call(`(act "sign up" "https://forms.example.org/")`); r.Ready || r.BrowserAgent == "" || r.Browser != "" {
		t.Errorf("act with no browser-agent image: %+v", r)
	}
	s.BrowserAgents = true
	if _, r := call(`(act "sign up" "https://forms.example.org/")`); r.Ready != (r.Claude == "") || r.BrowserAgent != "" {
		t.Errorf("act with a browser-agent image: %+v", r)
	}
	if code, _ := call(`(nope)`); code != 422 {
		t.Errorf("doesn't compile: %d", code)
	}
	csErr = errors.New("connectors file: bad")
	if _, r := call(`(trip "Lisbon")`); r.Ready || r.Error == "" {
		t.Errorf("a bad connectors file: %+v", r)
	}
}
