package drawdown

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/heedle-ai/pirn"
)

type memSecrets map[string]string

func (m memSecrets) Lookup(_ context.Context, name string) (string, bool, error) {
	v, ok := m[name]
	return v, ok, nil
}
func (m memSecrets) Store(_ context.Context, name, value string) error {
	if err := pirn.CheckSecret(name, value); err != nil {
		return err
	}
	m[name] = value
	return nil
}
func (m memSecrets) Delete(_ context.Context, name string) error { delete(m, name); return nil }

// TestInv_KeysAreSetOnlyHereAndNeverShown: the Connectors page lists the
// worker's connectors as its file has them now, with where each key is
// found (environment, keychain or missing), never a key's value; a key is
// set or deleted only from this machine, only by a name a connector uses
// (or the Anthropic key), only as JSON, and straight into the keychain,
// never through Temporal. (Roadmap 7.2.)
func TestInv_KeysAreSetOnlyHereAndNeverShown(t *testing.T) {
	t.Setenv("FROM_ENV_KEY", "env-value-123")
	keys := memSecrets{"MAPS_KEY": "maps-value-456"}
	cs := pirn.Connectors{
		{Name: "maps", URL: "https://maps.example/mcp", TokenEnv: "MAPS_KEY"},
		{Name: "search", Image: "img@sha256:" + strings.Repeat("a", 64), Command: []string{"srv"}, Secrets: map[string]string{"KEY": "SEARCH_KEY", "OTHER": "FROM_ENV_KEY"}},
	}
	s := &Server{Secrets: keys, ConnectorsFile: "/home/me/.heedle/connectors.json", Connectors: func() (pirn.Connectors, error) { return cs, nil }}
	h := s.Handler()
	call := func(method, path, body, remote, ctype string) (int, map[string]any, string) {
		r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, strings.NewReader(body))
		r.RemoteAddr = remote
		if ctype != "" {
			r.Header.Set("Content-Type", ctype)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var m map[string]any
		json.Unmarshal(w.Body.Bytes(), &m)
		return w.Code, m, w.Body.String()
	}
	const here = "127.0.0.1:50000"
	code, m, raw := call("GET", "/api/connectors", "", here, "")
	if code != 200 || strings.Contains(raw, "maps-value-456") || strings.Contains(raw, "env-value-123") {
		t.Fatalf("list: %d %s", code, raw)
	}
	from := map[string]string{}
	for _, c := range m["connectors"].([]any) {
		for _, sv := range c.(map[string]any)["secrets"].([]any) {
			sv := sv.(map[string]any)
			from[sv["name"].(string)] = sv["from"].(string)
		}
	}
	if from["MAPS_KEY"] != "keychain" || from["FROM_ENV_KEY"] != "environment" || from["SEARCH_KEY"] != "missing" || m["anthropic"].(map[string]any)["from"] != "missing" {
		t.Errorf("where keys are found: %v %v", from, m["anthropic"])
	}

	if code, _, _ := call("POST", "/api/secrets", `{"name":"SEARCH_KEY","value":"s3cret-789"}`, "192.168.1.20:4000", "application/json"); code != http.StatusForbidden || keys["SEARCH_KEY"] != "" {
		t.Errorf("from another machine: %d %v", code, keys)
	}
	if code, _, _ := call("POST", "/api/secrets", `{"name":"SEARCH_KEY","value":"s3cret-789"}`, here, "text/plain"); code != http.StatusUnsupportedMediaType || keys["SEARCH_KEY"] != "" {
		t.Errorf("not JSON (a form another site could post): %d", code)
	}
	if code, _, _ := call("POST", "/api/secrets", `{"name":"HOME_TOKEN","value":"x1"}`, here, "application/json"); code != http.StatusBadRequest || keys["HOME_TOKEN"] != "" {
		t.Errorf("a name no connector uses: %d", code)
	}
	if code, _, _ := call("POST", "/api/secrets", `{"name":"SEARCH_KEY","value":"has space"}`, here, "application/json"); code != http.StatusBadRequest {
		t.Errorf("a bad value: %d", code)
	}
	code, m, raw = call("POST", "/api/secrets", `{"name":"SEARCH_KEY","value":"s3cret-789"}`, "[::1]:4000", "application/json")
	if code != 200 || keys["SEARCH_KEY"] != "s3cret-789" || m["from"] != "keychain" || strings.Contains(raw, "s3cret-789") {
		t.Errorf("set: %d %s", code, raw)
	}
	if code, _, _ := call("POST", "/api/secrets", `{"name":"ANTHROPIC_API_KEY","value":"sk-ant-1"}`, here, "application/json"); code != 200 || keys["ANTHROPIC_API_KEY"] != "sk-ant-1" {
		t.Errorf("the Anthropic key: %d", code)
	}
	if code, m, _ := call("POST", "/api/secrets/delete", `{"name":"SEARCH_KEY"}`, here, "application/json"); code != 200 || m["from"] != "missing" || keys["SEARCH_KEY"] != "" {
		t.Errorf("delete: %d %v", code, m)
	}
}
