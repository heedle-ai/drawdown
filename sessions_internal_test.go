package drawdown

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/heedle-ai/pirn"
)

// TestInv_SavedSignInsOnlyHere: the saved sign-ins are listed, by host and
// times and never what they hold, and forgotten, file and key, only from
// this machine; the hosts a program's act steps would start signed in on
// are those of its hosts with a kept sign-in, exactly (roadmap 9.11).
func TestInv_SavedSignInsOnlyHere(t *testing.T) {
	keys := memSecrets{}
	ss := &pirn.Sessions{Dir: filepath.Join(t.TempDir(), "sessions"), Vault: keys}
	ctx := context.Background()
	if err := ss.Save(ctx, "forms.example.org", []byte(`{"cookies":[{"name":"sid","value":"c00kie-value-77","domain":"forms.example.org"}],"origins":[]}`)); err != nil {
		t.Fatal(err)
	}
	s := &Server{Sessions: ss}
	h := s.Handler()
	call := func(method, path, body, remote string, headers ...string) (int, string) {
		r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, strings.NewReader(body))
		r.RemoteAddr = remote
		r.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			r.Header.Set(headers[i], headers[i+1])
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	const here, there = "127.0.0.1:50000", "100.64.0.7:50000"
	for name, c := range map[string]struct {
		remote  string
		headers []string
	}{
		"another host":    {there, nil},
		"through a proxy": {here, []string{"X-Forwarded-For", "100.64.0.7"}},
		"another site":    {here, []string{"Sec-Fetch-Site", "cross-site"}},
		"another origin":  {here, []string{"Origin", "https://evil.example"}},
	} {
		if code, body := call("GET", "/api/sessions", "", c.remote, c.headers...); code != http.StatusForbidden || strings.Contains(body, "forms.example.org") {
			t.Errorf("list, %s: %d %s", name, code, body)
		}
		if code, _ := call("POST", "/api/sessions/forget", `{"host":"forms.example.org"}`, c.remote, c.headers...); code != http.StatusForbidden {
			t.Errorf("forget, %s: %d", name, code)
		}
	}
	code, body := call("GET", "/api/sessions", "", here)
	if code != 200 || !strings.Contains(body, `"host":"forms.example.org"`) || strings.Contains(body, "c00kie") || strings.Contains(body, "sealed") {
		t.Errorf("list: %d %s", code, body)
	}
	if got := s.signedIn(ctx, []string{"other.example.org", "forms.example.org", "example.org"}); strings.Join(got, " ") != "forms.example.org" {
		t.Errorf("signed in on %v", got)
	}
	if code, _ := call("POST", "/api/sessions/forget", `{"host":"../x"}`, here); code != http.StatusBadRequest {
		t.Errorf("forget a bad host: %d", code)
	}
	if code, _ := call("POST", "/api/sessions/forget", `{"host":"forms.example.org"}`, here); code != http.StatusNoContent {
		t.Errorf("forget: %d", code)
	}
	if _, err := os.Stat(filepath.Join(ss.Dir, "forms.example.org.session")); !os.IsNotExist(err) || len(keys) != 0 {
		t.Errorf("forgotten, still: %v, keys %v", err, keys)
	}
	if got := s.signedIn(ctx, []string{"forms.example.org"}); len(got) != 0 {
		t.Errorf("signed in after forgetting: %v", got)
	}
}
