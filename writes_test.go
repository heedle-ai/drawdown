package drawdown_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/shuttle/plan"
)

// TestInv_WritesAreDecidedThroughTheRun: a running run's writes come from
// Temporal (loom's WritesQuery), and approving or declining one signals
// the run, never runs it here; a finished run's writes come from its
// record; anything but a run's workflow ID, or a decision without a node
// and ID, is refused; and Temporal being down is reported.
func TestInv_WritesAreDecidedThroughTheRun(t *testing.T) {
	w := newWorld(t)
	wf := "loom-" + strings.Repeat("ab", 20)
	send := pirn.Write{ID: "w1", Connector: "mail", Tool: "send", Input: json.RawMessage(`{"to":"a"}`), Approve: true}
	w.fake.writes = map[string][]loom.WriteOutcome{wf: {{Node: "n0", Write: send, Status: loom.WriteWaiting}}}
	_, got, _ := w.call("GET", "/api/writes/"+wf, nil)
	if ws := got["writes"].([]any); len(ws) != 1 || ws[0].(map[string]any)["status"] != "waiting" {
		t.Errorf("writes %v", got)
	}
	// Review 19: a merge's re-run (".../rerun-N") couldn't be decided here.
	w.fake.writes[wf+"/rerun-1"] = []loom.WriteOutcome{{Node: "n0", Write: send, Status: loom.WriteWaiting}}
	if code, got, _ := w.call("POST", "/api/writes/"+wf+"/rerun-1", map[string]any{"node": "n0", "id": "w1", "approve": false}); code != 200 ||
		got["writes"].([]any)[0].(map[string]any)["status"] != "declined" {
		t.Errorf("a re-run's write: %d %v", code, got)
	}
	if code, _, _ := w.call("GET", "/api/writes/"+wf+"%2Frerun-1", nil); code != 200 {
		t.Errorf("a re-run's ID as the page encodes it: %d", code)
	}
	if code, _, _ := w.call("GET", "/api/writes/"+wf+"/other", nil); code != 400 {
		t.Errorf("a path past the workflow ID: %d", code)
	}
	code, got, _ := w.call("POST", "/api/writes/"+wf, map[string]any{"node": "n0", "id": "w1", "approve": true})
	if ws := got["writes"].([]any); code != 200 || ws[0].(map[string]any)["status"] != "approved" {
		t.Errorf("approve: %d %v", code, got)
	}
	for _, c := range []struct {
		path string
		body any
	}{
		{"/api/writes/not-a-run", map[string]any{"node": "n0", "id": "w1"}},
		{"/api/writes/" + wf, map[string]any{"node": "n0"}},
		{"/api/writes/" + wf, map[string]any{"node": "n0", "id": "w1", "extra": 1}},
	} {
		if code, _, _ := w.call("POST", c.path, c.body); code != 400 {
			t.Errorf("%s %v: %d", c.path, c.body, code)
		}
	}
	p, _ := loom.Compile(context.Background(), draft.DefaultRegistry(), `(echo "x")`)
	if _, err := (&loom.Recorder{Store: w.store}).Record(context.Background(), loom.RecordInput{Program: `(echo "x")`, Plan: p,
		Result: plan.Result{Outputs: map[string]string{"n0": "x"}}, Ref: loom.DefaultRef, WorkflowID: wf, RunID: "r1", At: time.Unix(1700000000, 0),
		Writes: []loom.WriteOutcome{{Node: "n0", Write: send, Status: loom.WriteDone, Output: "sent"}}}); err != nil {
		t.Fatal(err)
	}
	_, detail, body := w.call("GET", "/api/runs/"+wf+"/r1", nil)
	rec, _ := detail["record"].(map[string]any)
	if ws, _ := rec["writes"].([]any); len(ws) != 1 || ws[0].(map[string]any)["output"] != "sent" {
		t.Errorf("the record's writes: %s", body)
	}
	w.fake.down = true
	if code, _, _ := w.call("GET", "/api/writes/"+wf, nil); code != 502 {
		t.Errorf("Temporal down: %d", code)
	}
	if code, _, _ := w.call("POST", "/api/writes/"+wf, map[string]any{"node": "n0", "id": "w1", "approve": true}); code != 502 {
		t.Errorf("Temporal down, deciding: %d", code)
	}
}

// TestInv_FormsAreSentOnlyWhenAPersonSays: a running act step's live frame
// carries the form it waits to send (summary and screenshot); Send or
// Cancel signals the run, only for a form waiting now (409 otherwise, and
// for one decided already); anything but a run's workflow ID, or a
// decision without an ID, is refused; Temporal being down is reported.
// (Roadmap 9.7.)
func TestInv_FormsAreSentOnlyWhenAPersonSays(t *testing.T) {
	w := newWorld(t)
	wf := "loom-" + strings.Repeat("cd", 20)
	w.fake.live = map[string][]drawdown.LiveFrame{wf: {{Activity: "3", Kind: "act", URL: "https://forms.example.org/x", Image: "data:image/jpeg;base64,/9g=",
		Pending: &pirn.ActPending{ID: "f00d", Node: "n0", Summary: "Name Ada.", URL: "https://forms.example.org/x"}}}}
	code, m, _ := w.call("GET", "/api/live/"+wf, nil)
	if fr := m["frames"].([]any); code != 200 || fr[0].(map[string]any)["pending"].(map[string]any)["summary"] != "Name Ada." {
		t.Errorf("live: %d %v", code, m)
	}
	if code, _, _ := w.call("POST", "/api/forms/"+wf, map[string]any{"id": "beef", "send": true}); code != 409 || len(w.fake.forms) != 0 {
		t.Errorf("a form that isn't waiting: %d %v", code, w.fake.forms)
	}
	code, m, _ = w.call("POST", "/api/forms/"+wf, map[string]any{"id": "f00d", "send": false})
	if code != 200 || len(w.fake.forms) != 1 || w.fake.forms[0].Send || m["frames"].([]any)[0].(map[string]any)["pending"] != nil {
		t.Errorf("cancel: %d %v %v", code, m, w.fake.forms)
	}
	if code, _, _ := w.call("POST", "/api/forms/"+wf, map[string]any{"id": "f00d", "send": true}); code != 409 || len(w.fake.forms) != 1 {
		t.Errorf("a second decision: %d %v", code, w.fake.forms)
	}
	for _, c := range []struct {
		path string
		body any
	}{
		{"/api/forms/not-a-run", map[string]any{"id": "f00d", "send": true}},
		{"/api/forms/" + wf, map[string]any{"send": true}},
		{"/api/forms/" + wf, map[string]any{"id": "f00d", "send": true, "extra": 1}},
	} {
		if code, _, _ := w.call("POST", c.path, c.body); code != 400 {
			t.Errorf("%s %v: %d", c.path, c.body, code)
		}
	}
	w.fake.down = true
	if code, _, _ := w.call("POST", "/api/forms/"+wf, map[string]any{"id": "f00d", "send": true}); code != 502 {
		t.Errorf("Temporal down: %d", code)
	}
}
