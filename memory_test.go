package drawdown_test

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
)

// TestInv_MemoryPageShowsAndChangesIt: /api/memory lists everything
// remembered, word for word, with the version a change must be based on;
// add (the text), edit (the ID, text and version), forget (the ID and
// version) and forget-all (the version) change it, each answering with
// what's remembered afterwards; a change based on a stale version, or
// made while the file is edited by hand, is 409 and the hand edit kept; a
// secret is 400 without being repeated; changes come only from this
// machine; a server with no memory file lists nothing and changes
// nothing. (Roadmap 10.1.)
func TestInv_MemoryPageShowsAndChangesIt(t *testing.T) {
	w := newWorld(t)
	code, got, body := w.call("GET", "/api/memory", nil)
	if code != 200 || len(got["memories"].([]any)) != 0 || got["file"] != w.memory {
		t.Fatalf("nothing yet: %d %s", code, body)
	}
	code, got, body = w.call("POST", "/api/memory/add", map[string]string{"text": "  <b>Vegetarian</b>.  "})
	m, _ := got["memory"].(map[string]any)
	if code != 200 || m["text"] != "<b>Vegetarian</b>." || len(got["memories"].([]any)) != 1 {
		t.Fatalf("add: %d %s", code, body)
	}
	id, v := m["id"].(string), got["version"].(string)
	if code, again, _ := w.call("POST", "/api/memory/add", map[string]string{"text": "<B>vegetarian</B>."}); code != 200 || again["version"] != v {
		t.Errorf("the same again changed something: %d %v", code, again)
	}
	if code, _, body := w.call("POST", "/api/memory/add", map[string]string{"text": "my card is 4111 1111 1111 1111"}); code != 400 || strings.Contains(body, "4111") {
		t.Errorf("a card number: %d %s", code, body)
	}
	for _, bad := range []struct {
		op   string
		body map[string]string
	}{
		{"edit", map[string]string{"id": id, "text": "x"}},
		{"forget", map[string]string{"id": id}},
		{"forget-all", map[string]string{}},
		{"add", map[string]string{"id": id, "text": "x"}},
		{"forget", map[string]string{"id": id, "text": "x", "version": v}},
	} {
		if code, _, body := w.call("POST", "/api/memory/"+bad.op, bad.body); code != 400 {
			t.Errorf("%s %v: %d %s", bad.op, bad.body, code, body)
		}
	}
	if code, _, _ := w.call("POST", "/api/memory/remember-everything", map[string]string{"text": "x"}); code != 404 {
		t.Errorf("an unknown change: %d", code)
	}
	code, got, body = w.call("POST", "/api/memory/edit", map[string]string{"id": id, "text": "Vegan.", "version": v})
	if code != 200 || !strings.Contains(body, "Vegan.") || strings.Contains(body, "Vegetarian") {
		t.Fatalf("edit: %d %s", code, body)
	}
	// New words are a new memory, with a new ID (review 47).
	if nid := got["memories"].([]any)[0].(map[string]any)["id"].(string); nid == id {
		t.Errorf("an edit kept the ID %s", id)
	} else {
		id = nid
	}
	if code, _, _ := w.call("POST", "/api/memory/forget", map[string]string{"id": id, "version": v}); code != 409 {
		t.Errorf("a stale version: %d", code)
	}
	// Edited by hand while the page was open: the page's change is refused,
	// and the hand edit stays.
	v = got["version"].(string)
	b, _ := os.ReadFile(w.memory)
	hand := strings.Replace(string(b), "Vegan.", "Vegan, but eats fish.", 1)
	os.WriteFile(w.memory, []byte(hand), 0o600)
	if code, _, _ := w.call("POST", "/api/memory/edit", map[string]string{"id": id, "text": "Vegan.", "version": v}); code != 409 {
		t.Errorf("over a hand edit: %d", code)
	}
	if b, _ := os.ReadFile(w.memory); string(b) != hand {
		t.Errorf("the hand edit was lost:\n%s", b)
	}
	_, got, _ = w.call("GET", "/api/memory", nil)
	code, got, body = w.call("POST", "/api/memory/forget", map[string]string{"id": id, "version": got["version"].(string)})
	if b, _ := os.ReadFile(w.memory); code != 200 || strings.Contains(string(b), "fish") || len(got["memories"].([]any)) != 0 {
		t.Errorf("forget: %d %s\n%s", code, body, b)
	}
	if code, _, _ := w.call("POST", "/api/memory/forget", map[string]string{"id": id, "version": got["version"].(string)}); code != 404 {
		t.Errorf("forgetting it twice: %d", code)
	}
	w.call("POST", "/api/memory/add", map[string]string{"text": "Home airport: IAD."})
	_, got, _ = w.call("GET", "/api/memory", nil)
	if code, got, _ := w.call("POST", "/api/memory/forget-all", map[string]string{"version": got["version"].(string)}); code != 200 || len(got["memories"].([]any)) != 0 {
		t.Errorf("forget-all: %d", code)
	}
	// Changes only from this machine (with -hosts, every request might be a
	// proxy's), and none without a memory file.
	remote := &drawdown.Server{Store: w.store, Hosts: []string{"heedle.example"}, MemoryFile: w.memory}
	rs := httptest.NewServer(remote.Handler())
	defer rs.Close()
	rw := &world{t: t, srv: rs}
	if code, _, _ := rw.call("POST", "/api/memory/add", map[string]string{"text": "x"}); code != 403 {
		t.Errorf("from elsewhere: %d", code)
	}
	// Review 47: reading it too.
	if code, _, body := rw.call("GET", "/api/memory", nil); code != 403 || strings.Contains(body, "IAD") {
		t.Errorf("read from elsewhere: %d %s", code, body)
	}
	none := httptest.NewServer((&drawdown.Server{Store: w.store}).Handler())
	defer none.Close()
	nw := &world{t: t, srv: none}
	if code, got, _ := nw.call("GET", "/api/memory", nil); code != 200 || len(got["memories"].([]any)) != 0 || got["file"] != "" {
		t.Errorf("no memory file: %d %v", code, got)
	}
	if code, _, _ := nw.call("POST", "/api/memory/add", map[string]string{"text": "x"}); code != 501 {
		t.Errorf("no memory file, add: %d", code)
	}
}

// TestInv_MemoryProblemsCanBeSeenAndForgotten: a memory edited by hand
// into one heedle won't send is listed, with why, and can be forgotten;
// a file heedle can't read at all is said, with nothing listed, and Forget
// everything empties it without a version. (Review 47: either one locked
// the page and the front door.)
func TestInv_MemoryProblemsCanBeSeenAndForgotten(t *testing.T) {
	w := newWorld(t)
	_, got, _ := w.call("POST", "/api/memory/add", map[string]string{"text": "Window seat."})
	id := got["memory"].(map[string]any)["id"].(string)
	b, _ := os.ReadFile(w.memory)
	os.WriteFile(w.memory, []byte(strings.Replace(string(b), "Window seat.", "pw: hunter2", 1)), 0o600)
	code, got, body := w.call("GET", "/api/memory", nil)
	if probs, _ := got["problems"].(map[string]any); code != 200 || !strings.Contains(probs[id].(string), "password") {
		t.Fatalf("a hand-edited secret: %d %s", code, body)
	}
	if code, _, body := w.call("POST", "/api/memory/forget", map[string]string{"id": id, "version": got["version"].(string)}); code != 200 || strings.Contains(body, "hunter2") {
		t.Errorf("forgetting it: %d %s", code, body)
	}
	os.WriteFile(w.memory, []byte("{ not json"), 0o600)
	if code, got, _ := w.call("GET", "/api/memory", nil); code != 409 || got["unreadable"] != true {
		t.Errorf("an unreadable file: %d %v", code, got)
	}
	if code, _, body := w.call("POST", "/api/memory/forget-all", map[string]string{}); code != 200 {
		t.Errorf("emptying it: %d %s", code, body)
	}
	if b, _ := os.ReadFile(w.memory); strings.TrimSpace(string(b)) != "[]" {
		t.Errorf("after emptying: %s", b)
	}
	// With a readable file, forget-all still needs the version.
	if code, _, _ := w.call("POST", "/api/memory/forget-all", map[string]string{}); code != 400 {
		t.Errorf("forget-all without a version: %d", code)
	}
}

// TestInv_RememberedOnlyWhenYouSaySo: asking heedle never writes the
// memory file, even when Claude suggests remembering something; the
// suggestion comes back with the proposal, and only adding it (the card's
// Remember) remembers it. The next request then sends it, as the memory
// source, and the proposal names it by ID; once forgotten, the next sends
// nothing, and its text is nowhere in the store or the folder. (Roadmap
// 10.1.)
func TestInv_RememberedOnlyWhenYouSaySo(t *testing.T) {
	w := newWorld(t)
	asker := &recordingClaude{}
	w.fake.writer = &loom.Writer{Asker: asker, MemoryFile: w.memory, Commands: func(context.Context) (*registry.Registry, []loom.Command, error) {
		reg := shipment.Registry()
		return reg, loom.Commands(reg, loom.BuiltinCommands), nil
	}}
	asker.reply = "```json\n" + `{"summary": "A weekend in Porto, with vegetarian places.", "program": "(echo \"porto\")", "remember": ["Vegetarian; no fish either."]}` + "\n```"
	code, got, body := w.call("POST", "/api/ask", map[string]any{"request": "Plan a weekend in Porto, I'm vegetarian and don't eat fish"})
	if code != 200 || len(got["remember"].([]any)) != 1 || got["memory"] != nil {
		t.Fatalf("ask: %d %s", code, body)
	}
	if _, err := os.Stat(w.memory); err == nil {
		t.Fatal("asking wrote the memory file")
	}
	if code, _, body := w.call("POST", "/api/memory/add", map[string]string{"text": got["remember"].([]any)[0].(string)}); code != 200 {
		t.Fatalf("Remember: %d %s", code, body)
	}
	asker.reply = "```json\n" + `{"summary": "Three days in Lisbon, with vegetarian places, as you like.", "program": "(echo \"lisbon\")"}` + "\n```"
	_, got, body = w.call("POST", "/api/ask", map[string]any{"request": "Plan three days in Lisbon"})
	ms, _ := loom.ReadMemory(w.memory)
	last := asker.asked[len(asker.asked)-1]
	if ids, _ := got["memory"].([]any); len(ids) != 1 || ids[0] != ms[0].ID || last.Sources[len(last.Sources)-1].ID != "memory" || strings.Contains(body, "fish") {
		t.Fatalf("the next ask: %s\n%+v", body, last.Sources)
	}
	_, mem, _ := w.call("GET", "/api/memory", nil)
	w.call("POST", "/api/memory/forget", map[string]string{"id": ms[0].ID, "version": mem["version"].(string)})
	// The page sends the turn made with it, as it keeps them; what that
	// turn proposed stays out (review 47).
	_, got, _ = w.call("POST", "/api/ask", map[string]any{"request": "make it four days", "earlier": []map[string]any{
		{"request": "Plan three days in Lisbon", "summary": "Lisbon, and no fish either, as you said.", "program": "(echo \"lisbon\")", "memory": []string{ms[0].ID}}}})
	last = asker.asked[len(asker.asked)-1]
	if got["memory"] != nil || last.Sources[len(last.Sources)-1].ID == "memory" {
		t.Errorf("after Forget, the request still used memory: %v %+v", got, last.Sources)
	}
	for _, s := range last.Sources {
		if strings.Contains(s.Text, "fish") {
			t.Errorf("after Forget, source %s still says: %s", s.ID, s.Text)
		}
	}
	// A request from another machine (with -hosts) sends no memory: it's
	// shown and changed only from this one (review 47).
	w.call("POST", "/api/memory/add", map[string]string{"text": "Home airport: IAD."})
	remote := &drawdown.Server{Store: w.store, Hosts: []string{"heedle.example"}, Temporal: w.fake, MemoryFile: w.memory}
	rs := httptest.NewServer(remote.Handler())
	defer rs.Close()
	if code, got, body := (&world{t: t, srv: rs}).call("POST", "/api/ask", map[string]any{"request": "Plan Lisbon"}); code != 200 || got["memory"] != nil {
		t.Errorf("an ask from elsewhere: %d %s", code, body)
	}
	if last := asker.asked[len(asker.asked)-1]; last.Sources[len(last.Sources)-1].ID == "memory" {
		t.Error("an ask from elsewhere sent memory")
	}
	// The suggestion's words were in what was asked, so they're in the
	// requests; the memory itself is in the memory file alone.
	objects, err := exec.Command("git", "-C", w.store.Dir(), "cat-file", "--batch-all-objects", "--batch").Output()
	if err != nil || strings.Contains(string(objects), "no fish either") {
		t.Errorf("the store holds the forgotten memory: %v", err)
	}
	filepath.WalkDir(filepath.Dir(w.memory), func(p string, d os.DirEntry, err error) error {
		if b, _ := os.ReadFile(p); err == nil && !d.IsDir() && strings.Contains(string(b), "no fish either") {
			t.Errorf("%s holds the forgotten memory", p)
		}
		return nil
	})
}

// recordingClaude answers every question with reply, and keeps them.
type recordingClaude struct {
	reply string
	asked []pirn.Question
}

func (c *recordingClaude) Ask(_ context.Context, q pirn.Question) (pirn.Answer, error) {
	c.asked = append(c.asked, q)
	return pirn.Answer{Pirn: 1, Model: "m", Text: c.reply}, nil
}
