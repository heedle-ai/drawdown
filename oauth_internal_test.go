package drawdown

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/heedle-ai/pirn"
)

// fakeProvider is an MCP server that wants a token, with its own
// authorization server, as the MCP spec has them: protected resource
// metadata, RFC 8414 metadata, dynamic client registration, and a code
// exchange that checks PKCE and the resource.
type fakeProvider struct {
	srv        *httptest.Server
	mu         sync.Mutex
	challenge  string
	redirects  []string
	refreshes  int
	open       bool // the MCP server needs no token
	exchangeOK bool
}

func newFakeProvider(t *testing.T) *fakeProvider {
	p := &fakeProvider{exchangeOK: true}
	mux := http.NewServeMux()
	base := func() string { return p.srv.URL }
	mux.HandleFunc("POST /mcp", func(w http.ResponseWriter, r *http.Request) {
		if p.open || r.Header.Get("Authorization") == "Bearer good-access" {
			w.Write([]byte(`{}`))
			return
		}
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+base()+`/.well-known/oauth-protected-resource/mcp", scope="read"`)
		w.WriteHeader(401)
	})
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"resource": base() + "/mcp", "authorization_servers": []string{base() + "/as"}})
	})
	mux.HandleFunc("GET /.well-known/oauth-authorization-server/as", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"issuer": base() + "/as", "authorization_endpoint": base() + "/as/authorize",
			"token_endpoint": base() + "/as/token", "registration_endpoint": base() + "/as/register",
			"code_challenge_methods_supported": []string{"S256"}, "response_types_supported": []string{"code"}})
	})
	mux.HandleFunc("POST /as/register", func(w http.ResponseWriter, r *http.Request) {
		var m struct {
			RedirectURIs []string `json:"redirect_uris"`
		}
		json.NewDecoder(r.Body).Decode(&m)
		p.mu.Lock()
		p.redirects = m.RedirectURIs
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"client_id": "cid-1", "token_endpoint_auth_method": "none", "redirect_uris": m.RedirectURIs})
	})
	mux.HandleFunc("GET /as/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("client_id") != "cid-1" || q.Get("code_challenge_method") != "S256" || q.Get("resource") != base()+"/mcp" || q.Get("scope") != "read" {
			http.Error(w, "bad request "+r.URL.RawQuery, 400)
			return
		}
		p.mu.Lock()
		p.challenge = q.Get("code_challenge")
		p.mu.Unlock()
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=code-1&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
	})
	mux.HandleFunc("POST /as/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		p.mu.Lock()
		defer p.mu.Unlock()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if !p.exchangeOK || r.Form.Get("code") != "code-1" || base64.RawURLEncoding.EncodeToString(sum[:]) != p.challenge || r.Form.Get("resource") != base()+"/mcp" {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			w.Write([]byte(`{"access_token":"good-access","refresh_token":"rt-1","expires_in":3600,"token_type":"Bearer"}`))
		case "refresh_token":
			if r.Form.Get("refresh_token") != "rt-1" || r.Form.Get("client_id") != "cid-1" {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			p.refreshes++
			w.Write([]byte(`{"access_token":"fresh-access","refresh_token":"rt-2","expires_in":3600,"token_type":"Bearer"}`))
		}
	})
	p.srv = httptest.NewTLSServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

// TestInv_SignInKeepsTokensInTheKeychain: Connect finds the server's
// sign-in as the MCP spec says, registers heedle with a redirect only to
// this server's callback, and sends you to sign in with PKCE and the
// server as the resource; the callback takes only a state it is waiting
// for, once, on this machine, exchanges the code with the verifier, and
// keeps the token and what refreshes it in the keychain (never the file),
// then adds the connector; a worker's vault refreshes it when it's about
// to expire and keeps the new one. A server that needs no sign-in is
// added without one. (Roadmap 7.2.)
func TestInv_SignInKeepsTokensInTheKeychain(t *testing.T) {
	p := newFakeProvider(t)
	file := filepath.Join(t.TempDir(), "connectors.json")
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
	s := &Server{ConnectorsFile: file, Connectors: read, Secrets: keys, OAuthClient: p.srv.Client()}
	h := s.Handler()
	do := func(method, target, body, remote string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.RemoteAddr = remote
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	const here = "127.0.0.1:5000"
	connect := `{"name":"tracker","url":"` + p.srv.URL + `/mcp"}`
	if w := do("POST", "http://127.0.0.1:8090/api/connectors/connect", connect, "192.168.1.4:5000"); w.Code != http.StatusForbidden {
		t.Errorf("from another machine: %d", w.Code)
	}
	w := do("POST", "http://127.0.0.1:8090/api/connectors/connect", connect, here)
	var m map[string]any
	json.Unmarshal(w.Body.Bytes(), &m)
	authorize, _ := m["authorize"].(string)
	if w.Code != 200 || m["signIn"] != true || !strings.HasPrefix(authorize, p.srv.URL+"/as/authorize?") {
		t.Fatalf("connect: %d %s", w.Code, w.Body)
	}
	if len(p.redirects) != 1 || p.redirects[0] != "http://127.0.0.1:8090/oauth/callback" {
		t.Errorf("registered redirects %v", p.redirects)
	}
	// The browser signs in; the provider sends it back to the callback.
	c := p.srv.Client()
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Get(authorize)
	if err != nil || resp.StatusCode != http.StatusFound {
		t.Fatalf("authorize: %v %v", resp.Status, err)
	}
	back := resp.Header.Get("Location")
	u, _ := url.Parse(back)
	if w := do("GET", back, "", "10.1.2.3:5000"); w.Code != http.StatusForbidden {
		t.Errorf("a callback from another machine: %d", w.Code)
	}
	if w := do("GET", "http://127.0.0.1:8090/oauth/callback?code=code-1&state=guessed", "", here); w.Code != http.StatusBadRequest {
		t.Errorf("a state nobody started: %d", w.Code)
	}
	w = do("GET", back, "", here)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Connected tracker") {
		t.Fatalf("callback: %d %s", w.Code, w.Body)
	}
	if w := do("GET", back, "", here); w.Code != http.StatusBadRequest {
		t.Errorf("the same state twice: %d", w.Code)
	}
	b, _ := os.ReadFile(file)
	if keys["HEEDLE_CONNECTOR_TRACKER_TOKEN"] != "good-access" || strings.Contains(string(b), "good-access") || strings.Contains(string(b), "rt-1") ||
		!strings.Contains(string(b), `"tokenEnv": "HEEDLE_CONNECTOR_TRACKER_TOKEN"`) {
		t.Errorf("file %s, keys %v", b, keys)
	}
	g, err := decodeGrant(keys["HEEDLE_CONNECTOR_TRACKER_OAUTH"])
	if err != nil || g.ClientID != "cid-1" || g.Refresh != "rt-1" || g.Expiry < time.Now().Add(50*time.Minute).Unix() {
		t.Errorf("grant %+v %v", g, err)
	}
	_ = u
	if w := do("GET", "http://127.0.0.1:8090/api/connectors", "", here); !strings.Contains(w.Body.String(), `"signedIn":true`) || strings.Contains(w.Body.String(), "good-access") {
		t.Errorf("the page: %s", w.Body)
	}

	// A worker's vault: a token still good is returned as it is; one about
	// to expire is refreshed, and the new one kept.
	v := &OAuthVault{Keys: keys, Client: p.srv.Client()}
	ctx := context.Background()
	if tok, ok, err := v.Lookup(ctx, "HEEDLE_CONNECTOR_TRACKER_TOKEN"); tok != "good-access" || !ok || err != nil || p.refreshes != 0 {
		t.Errorf("a good token: %q %v %v, %d refreshes", tok, ok, err, p.refreshes)
	}
	g.Expiry = time.Now().Add(30 * time.Second).Unix()
	keys["HEEDLE_CONNECTOR_TRACKER_OAUTH"] = g.encode()
	if tok, ok, err := v.Lookup(ctx, "HEEDLE_CONNECTOR_TRACKER_TOKEN"); tok != "fresh-access" || !ok || err != nil || p.refreshes != 1 {
		t.Errorf("a token about to expire: %q %v %v, %d refreshes", tok, ok, err, p.refreshes)
	}
	if g2, _ := decodeGrant(keys["HEEDLE_CONNECTOR_TRACKER_OAUTH"]); keys["HEEDLE_CONNECTOR_TRACKER_TOKEN"] != "fresh-access" || g2.Refresh != "rt-2" {
		t.Errorf("after refresh: %v %+v", keys["HEEDLE_CONNECTOR_TRACKER_TOKEN"], g2)
	}
	// Expired, and the refresh refused: sign in again.
	g.Expiry, g.Refresh = time.Now().Add(-time.Minute).Unix(), "revoked"
	keys["HEEDLE_CONNECTOR_TRACKER_OAUTH"] = g.encode()
	if _, _, err := v.Lookup(ctx, "HEEDLE_CONNECTOR_TRACKER_TOKEN"); err == nil || !strings.Contains(err.Error(), "sign in again") {
		t.Errorf("a refused refresh: %v", err)
	}
	if tok, ok, _ := v.Lookup(ctx, "OTHER_KEY"); ok || tok != "" {
		t.Error("other names pass through")
	}

	// Removing it removes its token and what refreshed it.
	if w := do("POST", "http://127.0.0.1:8090/api/connectors/remove", `{"name":"tracker"}`, here); w.Code != 200 || len(keys) != 0 {
		t.Errorf("remove: %d %v", w.Code, keys)
	}

	// A server that needs no token is said so, and nothing is added.
	p.open = true
	w = do("POST", "http://127.0.0.1:8090/api/connectors/connect", connect, here)
	if json.Unmarshal(w.Body.Bytes(), &m); w.Code != 200 || m["signIn"] != false {
		t.Errorf("an open server: %d %s", w.Code, w.Body)
	}
	// Signing in at a name that isn't localhost can't come back here.
	p.open = false
	if w := do("POST", "http://heedle.lan:8090/api/connectors/connect", connect, here); w.Code == 200 {
		t.Errorf("a callback to another host: %d", w.Code)
	}
}
