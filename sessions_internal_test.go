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
	"github.com/heedle-ai/shuttle/plan"
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
			if headers[i] == "Host" {
				r.Host = headers[i+1]
			}
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
		// Review 53: as the wheel's endpoints refuse them (DRAW-624).
		"another port":   {here, []string{"Origin", "http://127.0.0.1:9999", "Sec-Fetch-Site", "same-site"}},
		"a rebound name": {here, []string{"Host", "evil.example:8090"}},
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
	if code, _ := call("POST", "/api/sessions/forget", `{"host":"../x"}`, here); code != http.StatusBadRequest {
		t.Errorf("forget a bad host: %d", code)
	}
	if code, _ := call("POST", "/api/sessions/forget", `{"host":"forms.example.org"}`, here); code != http.StatusNoContent {
		t.Errorf("forget: %d", code)
	}
	if _, err := os.Stat(filepath.Join(ss.Dir, "forms.example.org.session")); !os.IsNotExist(err) || len(keys) != 0 {
		t.Errorf("forgotten, still: %v, keys %v", err, keys)
	}
	for _, remote := range []string{"[::1]:50000", "[::ffff:127.0.0.1]:50000"} {
		if code, _ := call("GET", "/api/sessions", "", remote); code != 200 {
			t.Errorf("list from this machine, %s: %d", remote, code)
		}
	}
}

// TestInv_SignedInRunsOnlyHere: a program whose act steps start signed in
// as you (:signed-in) runs or is scheduled only from this machine, and
// only as shown; whether it does is read from the program alone, never
// from which sign-ins are kept, so no caller learns which sites you have
// one on (review 53).
func TestInv_SignedInRunsOnlyHere(t *testing.T) {
	s := &Server{}
	p := plan.Plan{Nodes: []plan.Node{{ID: "n0", Activity: pirn.ActActivityName, Args: []string{"x", "https://forms.example.org/", pirn.SignedIn, "forms.example.org"}}}}
	check := func(remote string, shown []string, headers ...string) (bool, int, string) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/runs", nil)
		r.RemoteAddr = remote
		for i := 0; i+1 < len(headers); i += 2 {
			r.Header.Set(headers[i], headers[i+1])
		}
		w := httptest.NewRecorder()
		ok := s.signedInShown(w, r, p, shown)
		return ok, w.Code, w.Body.String()
	}
	for name, c := range map[string]struct {
		remote  string
		headers []string
	}{
		"another host":    {"100.64.0.7:50000", nil},
		"through a proxy": {"127.0.0.1:50000", []string{"X-Forwarded-For", "100.64.0.7"}},
		"another site":    {"127.0.0.1:50000", []string{"Sec-Fetch-Site", "cross-site"}},
	} {
		if ok, code, body := check(c.remote, []string{"forms.example.org"}, c.headers...); ok || code != http.StatusForbidden || strings.Contains(body, "forms.example.org") {
			t.Errorf("%s: %v %d %s", name, ok, code, body)
		}
	}
	if ok, code, _ := check("127.0.0.1:50000", nil); ok || code != http.StatusUnprocessableEntity {
		t.Errorf("not shown: %v %d", ok, code)
	}
	if ok, _, _ := check("127.0.0.1:50000", []string{"forms.example.org"}); !ok {
		t.Error("shown, from here, refused")
	}
	// A program without :signed-in runs from anywhere, whatever is kept.
	p.Nodes[0].Args = []string{"x", "https://forms.example.org/"}
	if ok, _, _ := check("100.64.0.7:50000", nil); !ok {
		t.Error("a program not signed in refused")
	}
}
