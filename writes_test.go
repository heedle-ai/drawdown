package drawdown_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/draft"
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
