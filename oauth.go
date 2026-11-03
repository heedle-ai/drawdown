package drawdown

// Connect by signing in: the MCP authorization flow (OAuth 2.1 with PKCE,
// protected resource metadata, authorization server metadata and dynamic
// client registration), from the MCP Go SDK's oauthex for discovery and
// registration, and golang.org/x/oauth2 for the code exchange and refresh.
// Nothing here implements OAuth itself.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/heedle-ai/pirn"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
	"golang.org/x/oauth2"
)

// SignInTimeout is how long a sign-in may take, from Connect to the
// provider sending the browser back.
const SignInTimeout = 10 * time.Minute

// oauthName is the keychain name of what refreshes a connector's token:
// HEEDLE_CONNECTOR_<NAME>_OAUTH, beside its _TOKEN.
func oauthName(tokenName string) string {
	return strings.TrimSuffix(tokenName, "_TOKEN") + "_OAUTH"
}

// grant is what the keychain keeps to refresh a token: the client heedle
// registered, the token endpoint, and the refresh token. It's kept as
// base64url JSON, one line a keychain takes.
type grant struct {
	ClientID     string           `json:"cid"`
	ClientSecret string           `json:"cs,omitempty"`
	TokenURL     string           `json:"tu"`
	AuthStyle    oauth2.AuthStyle `json:"as,omitempty"`
	Refresh      string           `json:"rt,omitempty"`
	Expiry       int64            `json:"exp,omitempty"` // unix seconds; 0: doesn't expire
}

func (g grant) encode() string {
	b, _ := json.Marshal(g)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeGrant(s string) (grant, error) {
	var g grant
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err == nil {
		err = json.Unmarshal(b, &g)
	}
	if err == nil && (g.ClientID == "" || !plainHTTPS(g.TokenURL) && !loopbackURL(g.TokenURL)) {
		err = errors.New("incomplete")
	}
	return g, err
}

func loopbackURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

func (g grant) config() *oauth2.Config {
	return &oauth2.Config{ClientID: g.ClientID, ClientSecret: g.ClientSecret, Endpoint: oauth2.Endpoint{TokenURL: g.TokenURL, AuthStyle: g.AuthStyle}}
}

// signIn is one sign-in waiting for the provider to send the browser
// back, by its state.
type signIn struct {
	name, url, resource, tokenName string
	cfg                            *oauth2.Config
	verifier                       string
	expires                        time.Time
}

// oauthClient reaches MCP and authorization servers.
func (s *Server) oauthClient() *http.Client {
	if s.OAuthClient != nil {
		return s.OAuthClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// connectConnector starts adding a remote connector by signing in. It
// asks the server, without a token, whether it needs one: if not, the
// connector is added at once. If it does (401, as the MCP spec has it),
// it finds the server's authorization server, registers heedle there as a
// public client whose only redirect is this server's /oauth/callback, and
// answers with the address to sign in at, with PKCE and the server as the
// resource. From this machine only, like keys.
func (s *Server) connectConnector(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "connectors can be changed only from the machine heedle runs on, at localhost, not through a proxy"})
		return
	}
	if s.ConnectorsFile == "" || s.Connectors == nil || s.Secrets == nil {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server has no connectors file or keychain"})
		return
	}
	var req struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if !readJSONUpTo(w, r, &req, 4<<10) {
		return
	}
	cs, err := s.Connectors()
	if err != nil {
		writeJSON(w, http.StatusConflict, apiError{Error: "the connectors file has a problem to fix first: " + err.Error()})
		return
	}
	tokenName := TokenName(req.Name)
	if msg := s.nameFree(r.Context(), cs, req.Name, tokenName); msg != "" {
		writeJSON(w, http.StatusConflict, apiError{Error: msg})
		return
	}
	if err := append(slices.Clone(cs), pirn.Connector{Name: req.Name, URL: req.URL, TokenEnv: tokenName}).Check(); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	callback, ok := callbackURL(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "open heedle at 127.0.0.1 or localhost to sign in"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	c := s.oauthClient()
	challenges, needs, err := probe(ctx, c, req.URL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	if !needs {
		writeJSON(w, http.StatusOK, map[string]any{"signIn": false})
		return
	}
	prm, err := resourceMeta(ctx, c, challenges, req.URL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "the server asks you to sign in, but doesn't say where: " + err.Error()})
		return
	}
	asm, err := authServerMeta(ctx, c, prm)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	if asm.RegistrationEndpoint == "" {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "its sign-in doesn't let heedle register itself; paste a token from its settings instead"})
		return
	}
	reg, err := oauthex.RegisterClient(ctx, asm.RegistrationEndpoint, &oauthex.ClientRegistrationMetadata{
		ClientName: "heedle", RedirectURIs: []string{callback}, TokenEndpointAuthMethod: "none",
		GrantTypes: []string{"authorization_code", "refresh_token"}, ResponseTypes: []string{"code"},
	}, c)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "registering heedle with its sign-in failed: " + err.Error()})
		return
	}
	scopes := scopesOf(challenges)
	if len(scopes) == 0 {
		scopes = prm.ScopesSupported
	}
	cfg := &oauth2.Config{ClientID: reg.ClientID, ClientSecret: reg.ClientSecret, RedirectURL: callback, Scopes: scopes,
		Endpoint: oauth2.Endpoint{AuthURL: asm.AuthorizationEndpoint, TokenURL: asm.TokenEndpoint, AuthStyle: authStyle(reg.TokenEndpointAuthMethod)}}
	if !plainHTTPS(cfg.Endpoint.AuthURL) && !loopbackURL(cfg.Endpoint.AuthURL) {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "its sign-in page isn't https://"})
		return
	}
	state, verifier := rand.Text(), oauth2.GenerateVerifier()
	s.signInsMu.Lock()
	if s.signIns == nil {
		s.signIns = map[string]signIn{}
	}
	for k, v := range s.signIns {
		if time.Now().After(v.expires) || v.name == req.Name {
			delete(s.signIns, k)
		}
	}
	if len(s.signIns) >= 20 {
		s.signInsMu.Unlock()
		writeJSON(w, http.StatusTooManyRequests, apiError{Error: "too many sign-ins waiting; finish or wait for one"})
		return
	}
	s.signIns[state] = signIn{name: req.Name, url: req.URL, resource: prm.Resource, tokenName: tokenName, cfg: cfg, verifier: verifier, expires: time.Now().Add(SignInTimeout)}
	s.signInsMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"signIn": true, "authorize": cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("resource", prm.Resource))})
}

// nameFree says why name, or its token's name, is taken, or "".
func (s *Server) nameFree(ctx context.Context, cs pirn.Connectors, name, tokenName string) string {
	if slices.ContainsFunc(cs, func(c pirn.Connector) bool { return c.Name == name }) {
		return "there is already a connector " + name
	}
	for _, n := range []string{tokenName, oauthName(tokenName)} {
		if os.Getenv(n) != "" || slices.ContainsFunc(cs, func(o pirn.Connector) bool { return slices.Contains(secretNames(o), n) }) {
			return n + " is already in use; choose another name"
		}
		if _, ok, err := s.Secrets.Lookup(ctx, n); err != nil || ok {
			return n + " is already in your keychain (or it can't be read); remove it first, or choose another name"
		}
	}
	return ""
}

// callbackURL is where the provider sends the browser back: this server,
// as the browser reached it, if that was a loopback address or localhost.
func callbackURL(r *http.Request) (string, bool) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		return "", false
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", false
	}
	return "http://" + r.Host + "/oauth/callback", true
}

// probe asks an MCP server to start a session, with no token: it needs
// one if it answers 401, and none if it answers 2xx.
func probe(ctx context.Context, c *http.Client, server string) ([]oauthex.Challenge, bool, error) {
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"heedle","version":"1"}}}`
	req, err := http.NewRequestWithContext(ctx, "POST", server, strings.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := c.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("the server didn't answer: %v", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		ch, err := oauthex.ParseWWWAuthenticate(resp.Header.Values("WWW-Authenticate"))
		return ch, true, err
	case resp.StatusCode/100 == 2:
		return nil, false, nil
	}
	return nil, false, fmt.Errorf("the server answered %s", resp.Status)
}

// resourceMeta finds the server's protected resource metadata where the
// MCP spec says to look: the challenge's resource_metadata, then the
// well-known places at its path and at its root.
func resourceMeta(ctx context.Context, c *http.Client, challenges []oauthex.Challenge, server string) (*oauthex.ProtectedResourceMetadata, error) {
	type try struct{ meta, resource string }
	var tries []try
	for _, ch := range challenges {
		if m := ch.Params["resource_metadata"]; m != "" {
			tries = append(tries, try{m, server})
		}
	}
	u, err := url.Parse(server)
	if err != nil {
		return nil, err
	}
	at := *u
	at.Path = "/.well-known/oauth-protected-resource/" + strings.TrimLeft(u.Path, "/")
	root := *u
	root.Path, root.RawQuery = "/.well-known/oauth-protected-resource", ""
	base := *u
	base.Path, base.RawQuery = "", ""
	tries = append(tries, try{at.String(), server}, try{root.String(), base.String()})
	var errs []error
	seen := map[try]bool{}
	for _, t := range tries {
		if seen[t] {
			continue
		}
		seen[t] = true
		prm, err := oauthex.GetProtectedResourceMetadata(ctx, t.meta, t.resource, c)
		if err == nil && prm != nil {
			return prm, nil
		}
		errs = append(errs, err)
	}
	return nil, errors.Join(errs...)
}

// authServerMeta finds the first authorization server's metadata, at the
// well-known places RFC 8414 and OpenID Connect Discovery name.
func authServerMeta(ctx context.Context, c *http.Client, prm *oauthex.ProtectedResourceMetadata) (*oauthex.AuthServerMeta, error) {
	if len(prm.AuthorizationServers) == 0 {
		return nil, errors.New("the server names no authorization server")
	}
	issuer := prm.AuthorizationServers[0]
	u, err := url.Parse(issuer)
	if err != nil {
		return nil, err
	}
	p := strings.Trim(u.Path, "/")
	var places []string
	for _, wk := range []string{"/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"} {
		v := *u
		v.Path = wk
		if p != "" {
			v.Path += "/" + p
		}
		places = append(places, v.String())
	}
	if p != "" {
		v := *u
		v.Path = "/" + p + "/.well-known/openid-configuration"
		places = append(places, v.String())
	}
	for _, m := range places {
		asm, err := oauthex.GetAuthServerMeta(ctx, m, issuer, c)
		if err != nil {
			return nil, fmt.Errorf("its sign-in's metadata: %v", err)
		}
		if asm != nil {
			return asm, nil
		}
	}
	return nil, errors.New("its sign-in publishes no metadata heedle can use")
}

func scopesOf(challenges []oauthex.Challenge) []string {
	for _, c := range challenges {
		if c.Scheme == "bearer" && c.Params["scope"] != "" {
			return strings.Fields(c.Params["scope"])
		}
	}
	return nil
}

func authStyle(method string) oauth2.AuthStyle {
	if method == "client_secret_basic" {
		return oauth2.AuthStyleInHeader
	}
	return oauth2.AuthStyleInParams
}

// oauthCallback is where the provider sends the browser back. With the
// state of a sign-in this server started, it exchanges the code (with
// PKCE's verifier, for the server as the resource), keeps the token and
// what refreshes it in the keychain, and adds the connector.
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	page := func(status int, msg string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>heedle</title><body style="font:16px system-ui;margin:48px"><p>%s</p><p><a href="/#/connectors">Back to connectors</a></p>`, html.EscapeString(msg))
	}
	if !fromThisMachine(r, s.Hosts) {
		page(http.StatusForbidden, "Sign-ins finish only on the machine heedle runs on.")
		return
	}
	q := r.URL.Query()
	s.signInsMu.Lock()
	in, ok := s.signIns[q.Get("state")]
	delete(s.signIns, q.Get("state"))
	s.signInsMu.Unlock()
	if !ok || q.Get("state") == "" || time.Now().After(in.expires) {
		page(http.StatusBadRequest, "This sign-in isn't one heedle is waiting for (or it took over 10 minutes). Start again from the connectors page.")
		return
	}
	if e := q.Get("error"); e != "" {
		page(http.StatusBadRequest, "The sign-in didn't finish: "+e+" "+q.Get("error_description"))
		return
	}
	ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), oauth2.HTTPClient, s.oauthClient()), 30*time.Second)
	defer cancel()
	tok, err := in.cfg.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(in.verifier), oauth2.SetAuthURLParam("resource", in.resource))
	if err != nil {
		page(http.StatusBadGateway, "The sign-in didn't give heedle a token: "+err.Error())
		return
	}
	g := grant{ClientID: in.cfg.ClientID, ClientSecret: in.cfg.ClientSecret, TokenURL: in.cfg.Endpoint.TokenURL, AuthStyle: in.cfg.Endpoint.AuthStyle, Refresh: tok.RefreshToken}
	if !tok.Expiry.IsZero() {
		g.Expiry = tok.Expiry.Unix()
	}
	if err := s.finishConnect(r.Context(), in, tok.AccessToken, g); err != nil {
		page(http.StatusConflict, "Signed in, but the connector wasn't added: "+err.Error())
		return
	}
	page(http.StatusOK, "Connected "+in.name+". You can close this tab; the connectors page shows it.")
}

// finishConnect keeps the token and grant in the keychain, then adds the
// connector to the file; if the file can't take it, the keys go again.
func (s *Server) finishConnect(ctx context.Context, in signIn, access string, g grant) error {
	ctx = context.WithoutCancel(ctx)
	if err := pirn.CheckSecret(in.tokenName, access); err != nil {
		return fmt.Errorf("its token can't be kept: %v", err)
	}
	if err := pirn.CheckSecret(oauthName(in.tokenName), g.encode()); err != nil {
		return fmt.Errorf("what refreshes its token can't be kept: %v", err)
	}
	s.connectorsMu.Lock()
	defer s.connectorsMu.Unlock()
	before, err := os.ReadFile(s.ConnectorsFile)
	if err != nil {
		before = []byte{}
	}
	cs, err := s.Connectors()
	if err != nil {
		return err
	}
	if msg := s.nameFree(ctx, cs, in.name, in.tokenName); msg != "" {
		return errors.New(msg)
	}
	next := append(slices.Clone(cs), pirn.Connector{Name: in.name, URL: in.url, TokenEnv: in.tokenName})
	if err := next.Check(); err != nil {
		return err
	}
	if err := s.Secrets.Store(ctx, in.tokenName, access); err != nil {
		return err
	}
	if err := s.Secrets.Store(ctx, oauthName(in.tokenName), g.encode()); err != nil {
		s.Secrets.Delete(ctx, in.tokenName)
		return err
	}
	if err := s.replaceConnectors(before, next); err != nil {
		s.Secrets.Delete(ctx, in.tokenName)
		s.Secrets.Delete(ctx, oauthName(in.tokenName))
		return err
	}
	return nil
}

// OAuthVault is the keychain as a worker reads it, refreshing a signed-in
// connector's token (HEEDLE_CONNECTOR_<NAME>_TOKEN with an _OAUTH beside
// it) when it has expired or is about to, and keeping the new one.
type OAuthVault struct {
	Keys   Secrets
	Client *http.Client // reaches token endpoints; a 15-second one if nil
	mu     sync.Mutex
}

// RefreshEarly is how long before it expires a token is refreshed.
const RefreshEarly = 2 * time.Minute

// Lookup is the keychain's, with a fresh token for a signed-in connector.
func (v *OAuthVault) Lookup(ctx context.Context, name string) (string, bool, error) {
	if !strings.HasPrefix(name, TokenPrefix) || !strings.HasSuffix(name, "_TOKEN") {
		return v.Keys.Lookup(ctx, name)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	tok, ok, err := v.Keys.Lookup(ctx, name)
	if err != nil || !ok {
		return tok, ok, err
	}
	raw, has, err := v.Keys.Lookup(ctx, oauthName(name))
	if err != nil || !has {
		return tok, true, err
	}
	g, err := decodeGrant(raw)
	if err != nil {
		return "", false, fmt.Errorf("what refreshes %s can't be read (%v): sign in again from the connectors page", name, err)
	}
	if g.Expiry == 0 || time.Until(time.Unix(g.Expiry, 0)) > RefreshEarly {
		return tok, true, nil
	}
	if g.Refresh == "" {
		return "", false, fmt.Errorf("%s has expired and can't be refreshed: sign in again from the connectors page", name)
	}
	c := v.Client
	if c == nil {
		c = &http.Client{Timeout: 15 * time.Second}
	}
	rctx := context.WithValue(ctx, oauth2.HTTPClient, c)
	fresh, err := g.config().TokenSource(rctx, &oauth2.Token{RefreshToken: g.Refresh, Expiry: time.Unix(1, 0)}).Token()
	if err != nil {
		if time.Now().Before(time.Unix(g.Expiry, 0)) {
			return tok, true, nil // not expired yet: try again next time
		}
		return "", false, fmt.Errorf("refreshing %s failed (%v): sign in again from the connectors page", name, err)
	}
	if fresh.RefreshToken != "" {
		g.Refresh = fresh.RefreshToken
	}
	g.Expiry = 0
	if !fresh.Expiry.IsZero() {
		g.Expiry = fresh.Expiry.Unix()
	}
	if err := pirn.CheckSecret(name, fresh.AccessToken); err != nil {
		return "", false, err
	}
	sctx := context.WithoutCancel(ctx)
	if err := v.Keys.Store(sctx, name, fresh.AccessToken); err != nil {
		return "", false, err
	}
	if err := v.Keys.Store(sctx, oauthName(name), g.encode()); err != nil {
		return "", false, err
	}
	return fresh.AccessToken, true, nil
}
