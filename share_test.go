package drawdown_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/treadle"
)

// TestInv_ShareShowsTheStoreOnlyHere: a skill's page gets the store's
// folder for its Share command only on this machine: not through a
// proxy, and not on a server given -hosts, since it names a folder of
// yours. (Roadmap 10.6.)
func TestInv_ShareShowsTheStoreOnlyHere(t *testing.T) {
	w := newWorld(t)
	if code, _, raw := w.call("POST", "/api/skills/add", map[string]any{"files": map[string][]byte{"SKILL.md": []byte("---\nname: weather\ndescription: Says the weather.\n---\nSay it.\n")}}); code/100 != 2 {
		t.Fatalf("%d %s", code, raw)
	}
	for _, c := range []struct {
		hosts   []string
		forward bool
		want    bool
	}{{nil, false, true}, {nil, true, false}, {[]string{"heedle.example"}, false, false}} {
		s := &drawdown.Server{Skills: &treadle.Library{Store: w.store}, Commands: shipment.Registry, Store: w.store, Ref: loom.DefaultRef, Registry: shipment.Registry(),
			Temporal: w.fake, StoreDir: "/home/ada/.heedle/store.git", Hosts: c.hosts}
		srv := httptest.NewServer(s.Handler())
		req, _ := http.NewRequest("GET", srv.URL+"/api/skills/weather", nil)
		if c.forward {
			req.Header.Set("X-Forwarded-For", "203.0.113.9")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var b strings.Builder
		buf := make([]byte, 4096)
		for n, _ := res.Body.Read(buf); n > 0; n, _ = res.Body.Read(buf) {
			b.Write(buf[:n])
		}
		res.Body.Close()
		srv.Close()
		if got := strings.Contains(b.String(), `"store":"/home/ada/.heedle/store.git"`); got != c.want || res.StatusCode != 200 {
			t.Errorf("hosts %v forwarded %v: %d %s", c.hosts, c.forward, res.StatusCode, b.String())
		}
	}
}

// TestInv_CatalogImportsArePinned: an import the page asks for with the
// commit a catalog listed carries it to the worker, which imports that
// commit or nothing; a commit that isn't one is refused before anything
// is fetched. (Roadmap 10.6.)
func TestInv_CatalogImportsArePinned(t *testing.T) {
	w := newWorld(t)
	code, _, raw := w.call("POST", "/api/skills/import", map[string]string{"link": "https://github.com/example/skills", "path": "skills/trip", "commit": "abc"})
	if code != 400 || !strings.Contains(raw, `commit \"abc\"`) {
		t.Errorf("%d %s", code, raw)
	}
}
