package drawdown_test

import (
	"context"
	"strings"
	"testing"

	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
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
