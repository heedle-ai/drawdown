package drawdown

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/heedle-ai/pirn"
)

// TestInv_CatalogOffersOnlyWhatHeedleCanReach: a registry server is
// offered as ready only if it has a streamable-http remote at a plain
// https:// address needing at most an Authorization token; any other is
// shown with why it can't be added here. (Roadmap 7.2.)
func TestInv_CatalogOffersOnlyWhatHeedleCanReach(t *testing.T) {
	var s registryServer
	parse := func(js string) registryServer {
		s = registryServer{}
		if err := json.Unmarshal([]byte(js), &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	for js, want := range map[string]string{
		`{"name":"io.github.acme/maps-mcp","remotes":[{"type":"streamable-http","url":"https://maps.acme.dev/mcp"}]}`:                                                                "ready",
		`{"name":"a/b","remotes":[{"type":"streamable-http","url":"https://b.dev/mcp","headers":[{"name":"Authorization","isRequired":true,"isSecret":true}]}]}`:                     "ready token",
		`{"name":"a/b","remotes":[{"type":"streamable-http","url":"https://b.dev/mcp","headers":[{"name":"X-API-Key","isRequired":true,"isSecret":true}]}]}`:                         "no X-API-Key",
		`{"name":"a/b","remotes":[{"type":"sse","url":"https://b.dev/sse"}]}`:                                                                                                        "no SSE",
		`{"name":"a/b","remotes":[{"type":"streamable-http","url":"http://b.dev/mcp"}]}`:                                                                                             "no https",
		`{"name":"a/b","remotes":[{"type":"streamable-http","url":"https://{tenant}.b.dev/mcp","variables":{"tenant":{"isRequired":true}}}]}`:                                        "no filled in",
		`{"name":"a/b","packages":[{"registryType":"npm","identifier":"@a/b"}]}`:                                                                                                     "no package",
		`{"name":"a/b","remotes":[{"type":"sse","url":"https://b.dev/sse"},{"type":"streamable-http","url":"https://b.dev/mcp","headers":[{"name":"X-Trace","isRequired":false}]}]}`: "ready",
	} {
		e := assess(parse(js))
		ok := e.Fit == strings.Fields(want)[0]
		switch rest := strings.TrimPrefix(want, strings.Fields(want)[0]); {
		case strings.TrimSpace(rest) == "token":
			ok = ok && e.Token
		case strings.TrimSpace(rest) != "":
			ok = ok && strings.Contains(e.Why, strings.TrimSpace(rest)) && e.URL == ""
		default:
			ok = ok && !e.Token && e.URL != ""
		}
		if !ok {
			t.Errorf("%s: %+v", js, e)
		}
	}
	for in, want := range map[string]string{"io.github.acme/maps-mcp": "maps", "com.example/Weather_Server": "weather", "x/" + strings.Repeat("a", 40): strings.Repeat("a", 24), "a/---": "server"} {
		if got := suggestName(in); got != want {
			t.Errorf("suggestName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestInv_CatalogAsksOnlyTheRegistry: the catalog asks the registry for
// the latest versions matching a search, keeps only latest entries, at
// most MaxRegistryServers, and says so plainly when the registry fails,
// answers too much, or redirects to another host. (Roadmap 7.2.)
func TestInv_CatalogAsksOnlyTheRegistry(t *testing.T) {
	var got *http.Request
	reply := ""
	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		switch reply {
		case "fail":
			http.Error(w, "down", 503)
		case "huge":
			w.Write([]byte(`{"servers":[{"server":{"name":"` + strings.Repeat("x", MaxRegistryBytes) + `"}}]}`))
		case "away":
			http.Redirect(w, r, "https://elsewhere.example/v0/servers", http.StatusFound)
		default:
			w.Write([]byte(`{"servers":[
  {"server":{"name":"io.github.acme/maps-mcp","description":"Places","version":"2.0.0","remotes":[{"type":"streamable-http","url":"https://maps.acme.dev/mcp"}]},
   "_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":true}}},
  {"server":{"name":"io.github.acme/maps-mcp","description":"Places","version":"1.0.0"},
   "_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":false}}}],
 "metadata":{"nextCursor":"c2"}}`))
		}
	}))
	defer reg.Close()
	s := &Server{MCPRegistry: reg.URL}
	code, m, raw := s.call(t, "POST", "/api/connectors/catalog", `{"search":"maps"}`, "127.0.0.1:5000")
	if code != 200 || got.URL.Query().Get("search") != "maps" || got.URL.Query().Get("version") != "latest" || got.URL.Path != "/v0/servers" {
		t.Fatalf("catalog: %d %s, asked %v", code, raw, got.URL)
	}
	servers := m["servers"].([]any)
	if len(servers) != 1 || m["next"] != "c2" || servers[0].(map[string]any)["fit"] != "ready" || servers[0].(map[string]any)["suggest"] != "maps" {
		t.Errorf("servers: %s", raw)
	}
	for _, bad := range []string{"fail", "huge", "away"} {
		reply = bad
		if code, m, _ := s.call(t, "POST", "/api/connectors/catalog", `{"search":"maps"}`, "127.0.0.1:5000"); code != http.StatusBadGateway || m["error"] == nil {
			t.Errorf("%s: %d %v", bad, code, m)
		}
	}
}

// TestInv_AddingAConnectorKeepsTheFileWhole: a remote connector is added
// to (or removed from) the connectors file only from this machine, only
// if the whole file then passes its check, replacing the file at once; a
// token given with it goes to the keychain, never the file; removing one
// removes its keys. (Roadmap 7.2.)
func TestInv_AddingAConnectorKeepsTheFileWhole(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "heedle", "connectors.json")
	keys := memSecrets{}
	read := func() (pirn.Connectors, error) {
		f, err := os.Open(file)
		if os.IsNotExist(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		defer f.Close()
		return pirn.ReadConnectors(f)
	}
	s := &Server{ConnectorsFile: file, Connectors: read, Secrets: keys}
	const here = "127.0.0.1:5000"
	if code, _, _ := s.call(t, "POST", "/api/connectors/add", `{"name":"maps","url":"https://maps.acme.dev/mcp"}`, "192.168.1.9:5000"); code != http.StatusForbidden {
		t.Errorf("from another machine: %d", code)
	}
	if code, _, raw := s.call(t, "POST", "/api/connectors/add", `{"name":"maps","url":"https://maps.acme.dev/mcp","token":"tok-123"}`, here); code != 200 {
		t.Fatalf("add: %d %s", code, raw)
	}
	b, _ := os.ReadFile(file)
	if strings.Contains(string(b), "tok-123") || keys["MAPS_TOKEN"] != "tok-123" || !strings.Contains(string(b), `"tokenEnv": "MAPS_TOKEN"`) {
		t.Errorf("file %s, keys %v", b, keys)
	}
	if cs, err := read(); err != nil || len(cs) != 1 {
		t.Errorf("read back: %v %v", cs, err)
	}
	for body, want := range map[string]int{
		`{"name":"maps","url":"https://other.dev/mcp"}`:                http.StatusConflict,
		`{"name":"Bad Name","url":"https://b.dev/mcp"}`:                http.StatusBadRequest,
		`{"name":"plain","url":"http://b.dev/mcp"}`:                    http.StatusBadRequest,
		`{"name":"tok","url":"https://b.dev/mcp","token":"has space"}`: http.StatusBadRequest,
	} {
		if code, _, raw := s.call(t, "POST", "/api/connectors/add", body, here); code != want {
			t.Errorf("%s: %d %s", body, code, raw)
		}
	}
	if after, _ := os.ReadFile(file); string(after) != string(b) {
		t.Errorf("a refused change changed the file:\n%s", after)
	}
	if code, _, _ := s.call(t, "POST", "/api/connectors/add", `{"name":"docs","url":"https://docs.dev/mcp"}`, here); code != 200 {
		t.Errorf("a second: %d", code)
	}
	if code, _, _ := s.call(t, "POST", "/api/connectors/remove", `{"name":"maps"}`, here); code != 200 || keys["MAPS_TOKEN"] != "" {
		t.Errorf("remove: %d %v", code, keys)
	}
	if cs, _ := read(); len(cs) != 1 || cs[0].Name != "docs" {
		t.Errorf("after remove: %v", cs)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "heedle", ".connectors-*")); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
	os.WriteFile(file, []byte(`{"connectors":[{"name":"x","url":"http://bad"}]}`), 0o600)
	if code, _, _ := s.call(t, "POST", "/api/connectors/add", `{"name":"docs2","url":"https://docs.dev/mcp"}`, here); code != http.StatusConflict {
		t.Errorf("onto a bad file: %d", code)
	}
}
