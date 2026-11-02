package drawdown_test

import (
	"strings"
	"testing"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/treadle"
)

// TestInv_CatalogsAreListedOnAWorker: the page lists a repository's skills
// through a worker (loom.ListSkills), for a GitHub link to a repository or
// an https:// repository; a folder's link, a file:// repository or an
// empty link is refused before any worker is asked; a worker's refusal is
// 400, Temporal down 502.
func TestInv_CatalogsAreListedOnAWorker(t *testing.T) {
	w := newWorld(t)
	w.fake.catalog = loom.Catalog{Entries: []treadle.CatalogEntry{
		{Source: treadle.Source{Repo: "https://github.com/anthropics/skills", Path: "skills/pdf", Commit: strings.Repeat("a", 40)}, Name: "pdf", Description: "Reads PDFs."},
	}, Omitted: 2}
	code, got, body := w.call("POST", "/api/skills/catalog", map[string]any{"link": "https://github.com/anthropics/skills"})
	entries, _ := got["entries"].([]any)
	if code != 200 || len(entries) != 1 || got["omitted"].(float64) != 2 {
		t.Fatalf("catalog: %d %s", code, body)
	}
	if len(w.fake.listed) != 1 || w.fake.listed[0].Repo != "https://github.com/anthropics/skills" || w.fake.listed[0].Path != "" {
		t.Errorf("the worker was asked %+v", w.fake.listed)
	}
	for _, link := range []string{"", "https://github.com/anthropics/skills/tree/main/skills/pdf", "file:///tmp/skills", "http://example.com/skills"} {
		if code, _, body := w.call("POST", "/api/skills/catalog", map[string]any{"link": link}); code != 400 {
			t.Errorf("catalog of %q: %d %s", link, code, body)
		}
	}
	if len(w.fake.listed) != 1 {
		t.Errorf("a refused link reached a worker: %+v", w.fake.listed)
	}
	w.fake.down = true
	if code, _, _ := w.call("POST", "/api/skills/catalog", map[string]any{"link": "https://github.com/anthropics/skills"}); code != 502 {
		t.Errorf("Temporal down: %d", code)
	}
}
