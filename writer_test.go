package drawdown_test

import (
	"context"
	"strings"
	"testing"

	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
)

// claude is a stand-in that answers every question with one reply.
type claude string

func (c claude) Ask(context.Context, pirn.Question) (pirn.Answer, error) {
	return pirn.Answer{Pirn: 1, Model: "m", Text: string(c)}, nil
}

// TestInv_WritingAndCreatingRunOnAWorker: the page has a worker's Claude
// write a program for a task (shown with its plan; nothing runs) and
// create a skill from a description (it waits for review); empty or
// overlong descriptions are refused; a task with no program is 422 and a
// worker or Temporal failure 502.
func TestInv_WritingAndCreatingRunOnAWorker(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	writer := func(reply string) *loom.Writer {
		return &loom.Writer{Asker: claude(reply), Commands: func(context.Context) (*registry.Registry, []loom.Command, error) {
			reg := shipment.Registry()
			return reg, loom.Commands(reg, loom.BuiltinCommands), nil
		}}
	}
	w.fake.writer = writer("```\n" + shipment.Program + "```")
	code, got, body := w.call("POST", "/api/write", map[string]any{"description": "Is the shipment late?"})
	if code != 200 || got["program"] != shipment.Program || len(got["plan"].(map[string]any)["nodes"].([]any)) != 4 {
		t.Errorf("write: %d %s", code, body)
	}
	if refs := must(w.store.Refs(ctx, "refs/loom/")); len(refs) != 0 {
		t.Errorf("writing a program ran it: %v", refs)
	}
	w.fake.writer = writer("(nope)")
	if code, _, body := w.call("POST", "/api/write", map[string]any{"description": "x"}); code != 422 || !strings.Contains(body, "no program") {
		t.Errorf("no program: %d %s", code, body)
	}
	for _, d := range []string{"", strings.Repeat("x", loom.MaxDescription+1)} {
		if code, _, _ := w.call("POST", "/api/write", map[string]any{"description": d}); code != 400 {
			t.Errorf("description of %d bytes: %d", len(d), code)
		}
	}

	if code, _, body := w.call("POST", "/api/skills/create", map[string]any{"description": "Sum a column."}); code != 400 || !strings.Contains(body, "agent image") {
		t.Errorf("a worker that can't create: %d %s", code, body)
	}
	w.fake.create = func(_ context.Context, d string) (map[string][]byte, error) {
		return map[string][]byte{"SKILL.md": []byte("---\nname: csv-sum\ndescription: Sums a column.\n---\nGo.\n")}, nil
	}
	code, got, body = w.call("POST", "/api/skills/create", map[string]any{"description": "Sum a column."})
	if sk, _ := got["skill"].(map[string]any); code != 200 || sk["pending"] != true || sk["created"] != "Sum a column." {
		t.Errorf("create: %d %s", code, body)
	}
	if code, _, _ := w.call("POST", "/api/skills/create", map[string]any{"description": " "}); code != 400 {
		t.Errorf("an empty description: %d", code)
	}
	w.fake.down = true
	if code, _, _ := w.call("POST", "/api/write", map[string]any{"description": "x"}); code != 502 {
		t.Errorf("Temporal down: %d", code)
	}
}
