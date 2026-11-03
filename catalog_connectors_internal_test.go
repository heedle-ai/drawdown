package drawdown

import (
	"context"
	"encoding/json"
	"errors"
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
			// Even to its own host: a redirect could leave https (review 28).
			if r.URL.Path == "/v0/servers" {
				http.Redirect(w, r, "/v1/servers", http.StatusFound)
				return
			}
			w.Write([]byte(`{"servers":[{"server":{"name":"io.github.evil/x","description":"d","remotes":[{"type":"streamable-http","url":"https://evil.dev/mcp"}]}}]}`))
		default:
			w.Write([]byte(`{"servers":[
  {"server":{"name":"io.github.acme/maps-mcp","description":"Places","version":"2.0.0","remotes":[{"type":"streamable-http","url":"https://maps.acme.dev/mcp"}]},
   "_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":true}}},
  {"server":{"name":"io.github.acme/maps-mcp","description":"Places","version":"1.0.0"},
   "_meta":{"io.modelcontextprotocol.registry/official":{"isLatest":false}}},
  {"server":{"name":"io.github.acme/old","description":"Old","version":"0.1.0"},
   "_meta":{"io.modelcontextprotocol.registry/official":"not an object"}}],
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

// failingSecrets refuses every store.
type failingSecrets struct{ memSecrets }

func (failingSecrets) Store(context.Context, string, string) error {
	return errors.New("keychain locked")
}

// TestInv_AddingAConnectorKeepsTheFileWhole: a remote connector is added
// to (or removed from) the connectors file only from this machine, only
// if the whole file then passes its check and still holds what was read
// (a hand edit meanwhile is never lost), all at once, keeping the file's
// mode and any symbolic link to it; its token goes to the keychain, never
// the file, under HEEDLE_CONNECTOR_<NAME>_TOKEN, a name nothing else uses:
// not one the environment holds, another connector names, or the keychain
// has; a token that can't be stored adds nothing; removing one removes
// only a token the page made, and only once the file no longer names it.
// (Roadmap 7.2; review 28.)
func TestInv_AddingAConnectorKeepsTheFileWhole(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "dotfiles", "connectors.json")
	os.MkdirAll(filepath.Dir(real), 0o755)
	os.WriteFile(real, []byte(`{"connectors":[{"name":"hand","url":"https://hand.dev/mcp","tokenEnv":"HAND_KEY"}]}`), 0o644)
	file := filepath.Join(dir, "heedle", "connectors.json")
	os.MkdirAll(filepath.Dir(file), 0o700)
	if err := os.Symlink(real, file); err != nil {
		t.Fatal(err)
	}
	keys := memSecrets{"HAND_KEY": "hand-1"}
	hook := func() {}
	read := func() (pirn.Connectors, error) {
		hook()
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
	code, m, raw := s.call(t, "POST", "/api/connectors/add", `{"name":"maps","url":"https://maps.acme.dev/mcp","token":"tok-123"}`, here)
	if code != 200 || m["token"] != "HEEDLE_CONNECTOR_MAPS_TOKEN" {
		t.Fatalf("add: %d %s", code, raw)
	}
	b, _ := os.ReadFile(real)
	if strings.Contains(string(b), "tok-123") || keys["HEEDLE_CONNECTOR_MAPS_TOKEN"] != "tok-123" || !strings.Contains(string(b), `"tokenEnv": "HEEDLE_CONNECTOR_MAPS_TOKEN"`) {
		t.Errorf("file %s, keys %v", b, keys)
	}
	if fi, err := os.Lstat(file); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the symbolic link was replaced by a file")
	}
	if fi, _ := os.Stat(real); fi.Mode().Perm() != 0o644 {
		t.Errorf("mode %v, want 0644 kept", fi.Mode().Perm())
	}
	if cs, err := read(); err != nil || len(cs) != 2 {
		t.Errorf("read back: %v %v", cs, err)
	}
	t.Setenv("HEEDLE_CONNECTOR_ENVY_TOKEN", "from-the-environment")
	keys["HEEDLE_CONNECTOR_KEPT_TOKEN"] = "someone's"
	for body, want := range map[string]int{
		`{"name":"maps","url":"https://other.dev/mcp"}`:                 http.StatusConflict,
		`{"name":"Bad Name","url":"https://b.dev/mcp"}`:                 http.StatusBadRequest,
		`{"name":"plain","url":"http://b.dev/mcp"}`:                     http.StatusBadRequest,
		`{"name":"tok","url":"https://b.dev/mcp","token":"has space"}`:  http.StatusBadRequest,
		`{"name":"envy","url":"https://b.dev/mcp","token":"t1"}`:        http.StatusConflict,
		`{"name":"kept","url":"https://b.dev/mcp","token":"t1"}`:        http.StatusConflict,
		`{"name":"x","url":"https://b.dev/mcp","token":"t","bad":true}`: http.StatusBadRequest,
	} {
		if code, _, raw := s.call(t, "POST", "/api/connectors/add", body, here); code != want {
			t.Errorf("%s: %d %s", body, code, raw)
		}
	}
	if after, _ := os.ReadFile(real); string(after) != string(b) || keys["HEEDLE_CONNECTOR_KEPT_TOKEN"] != "someone's" {
		t.Errorf("a refused change changed something:\n%s %v", after, keys)
	}
	// A token that can't be stored adds nothing.
	s.Secrets = failingSecrets{keys}
	if code, _, _ := s.call(t, "POST", "/api/connectors/add", `{"name":"docs","url":"https://docs.dev/mcp","token":"t2"}`, here); code != http.StatusBadRequest {
		t.Errorf("a token that can't be stored: %d", code)
	}
	if after, _ := os.ReadFile(real); string(after) != string(b) {
		t.Errorf("a connector without its token was added:\n%s", after)
	}
	s.Secrets = keys
	// A hand edit between reading and writing: nothing is written, and a
	// remove keeps its keys.
	hook = func() { os.WriteFile(real, append(b, ' '), 0o644) }
	if code, _, _ := s.call(t, "POST", "/api/connectors/remove", `{"name":"maps"}`, here); code != http.StatusConflict || keys["HEEDLE_CONNECTOR_MAPS_TOKEN"] == "" {
		t.Errorf("a remove over a hand edit: %d %v", code, keys)
	}
	hook = func() {}
	if code, _, _ := s.call(t, "POST", "/api/connectors/remove", `{"name":"maps","url":"https://x.dev"}`, here); code != http.StatusBadRequest {
		t.Errorf("a remove with more than a name: %d", code)
	}
	if code, _, _ := s.call(t, "POST", "/api/connectors/remove", `{"name":"maps"}`, here); code != 200 || keys["HEEDLE_CONNECTOR_MAPS_TOKEN"] != "" {
		t.Errorf("remove: %d %v", code, keys)
	}
	// A hand-written connector's key isn't the page's to delete.
	if code, _, _ := s.call(t, "POST", "/api/connectors/remove", `{"name":"hand"}`, here); code != 200 || keys["HAND_KEY"] != "hand-1" {
		t.Errorf("remove a hand-written one: %d %v", code, keys)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*", ".connectors-*")); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
	os.WriteFile(real, []byte(`{"connectors":[{"name":"x","url":"http://bad"}]}`), 0o644)
	if code, _, _ := s.call(t, "POST", "/api/connectors/add", `{"name":"docs2","url":"https://docs.dev/mcp"}`, here); code != http.StatusConflict {
		t.Errorf("onto a bad file: %d", code)
	}
}
