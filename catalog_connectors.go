package drawdown

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/heedle-ai/pirn"
)

// DefaultMCPRegistry is the official MCP Registry, where the Connectors
// page finds servers to add.
const DefaultMCPRegistry = "https://registry.modelcontextprotocol.io"

// Registry replies are bounded: one page of at most MaxRegistryServers
// servers, MaxRegistryBytes of JSON, in RegistryTimeout.
const (
	MaxRegistryServers = 30
	MaxRegistryBytes   = 2 << 20
	RegistryTimeout    = 10 * time.Second
)

// registryServer is the part of a registry entry (server.json) the page
// uses.
type registryServer struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description"`
	Version     string `json:"version"`
	WebsiteURL  string `json:"websiteUrl,omitempty"`
	Repository  *struct {
		URL string `json:"url"`
	} `json:"repository,omitempty"`
	Remotes []struct {
		Type      string                     `json:"type"`
		URL       string                     `json:"url"`
		Headers   []registryInput            `json:"headers,omitempty"`
		Variables map[string]json.RawMessage `json:"variables,omitempty"`
	} `json:"remotes,omitempty"`
	Packages []struct {
		RegistryType string `json:"registryType"`
		Identifier   string `json:"identifier"`
	} `json:"packages,omitempty"`
}

type registryInput struct {
	Name       string `json:"name"`
	IsRequired bool   `json:"isRequired,omitempty"`
	IsSecret   bool   `json:"isSecret,omitempty"`
}

// catalogEntry is one server as the page offers it. Fit says what adding
// it takes: "ready" (a remote server heedle can reach as it is, perhaps
// with a token), or "no", with Why.
type catalogEntry struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description"`
	Version     string `json:"version"`
	Link        string `json:"link,omitempty"`
	URL         string `json:"url,omitempty"`
	// Token: the server takes an Authorization header, so a token is
	// required to add it; otherwise one may still be given, for servers
	// that sign you in (OAuth) without saying so in the registry.
	Token   bool   `json:"token,omitempty"`
	Fit     string `json:"fit"`
	Why     string `json:"why,omitempty"`
	Suggest string `json:"suggest"` // a connector name for it
}

// assess decides how heedle can use a registry server. Remote servers go
// through Anthropic's MCP connector, which sends only an Authorization
// bearer token, over https; so a server needing another header, a URL
// variable, or a package run on this machine can't be added from here.
func assess(s registryServer) catalogEntry {
	e := catalogEntry{Name: s.Name, Title: s.Title, Description: s.Description, Version: s.Version, Fit: "no", Suggest: suggestName(s.Name)}
	if s.WebsiteURL != "" {
		e.Link = s.WebsiteURL
	} else if s.Repository != nil {
		e.Link = s.Repository.URL
	}
	if !plainHTTPS(e.Link) {
		e.Link = ""
	}
	why := "it runs as a package on your machine, which needs a container image of it"
	for _, r := range s.Remotes {
		if r.Type != "streamable-http" {
			why = "it offers only the older SSE transport"
			continue
		}
		if len(r.Variables) > 0 || strings.Contains(r.URL, "{") {
			why = "its address needs values filled in"
			continue
		}
		if !plainHTTPS(r.URL) {
			why = "its address isn't a plain https:// one"
			continue
		}
		token, other := false, ""
		for _, h := range r.Headers {
			switch {
			case strings.EqualFold(h.Name, "Authorization"):
				token = token || h.IsRequired
			case h.IsRequired:
				other = h.Name
			}
		}
		if other != "" {
			why = fmt.Sprintf("it needs the header %s, and heedle can send a remote server only a token", other)
			continue
		}
		e.URL, e.Token, e.Fit, e.Why = r.URL, token, "ready", ""
		return e
	}
	if len(s.Remotes) == 0 && len(s.Packages) == 0 {
		why = "the registry lists no way to reach it"
	}
	e.Why = "Can't be added here: " + why + "."
	return e
}

// plainHTTPS reports whether s is an https:// address, spelled that way
// (the page checks the same), with a host and no credentials or spaces.
func plainHTTPS(s string) bool {
	u, err := url.Parse(s)
	return err == nil && strings.HasPrefix(s, "https://") && u.Host != "" && u.User == nil && !strings.ContainsAny(s, " \t\r\n")
}

var notName = regexp.MustCompile(`[^a-z0-9-]+`)

// suggestName makes a connector name from a registry name such as
// io.github.acme/maps-server: its last part, as the names grants use.
func suggestName(full string) string {
	n := full[strings.LastIndex(full, "/")+1:]
	n = strings.Trim(notName.ReplaceAllString(strings.ToLower(n), "-"), "-")
	n = strings.TrimSuffix(strings.TrimSuffix(n, "-mcp"), "-server")
	if len(n) > 24 {
		n = strings.Trim(n[:24], "-")
	}
	if n == "" {
		n = "server"
	}
	return n
}

// connectorCatalog searches the MCP Registry, a page at a time.
func (s *Server) connectorCatalog(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Search string `json:"search"`
		Cursor string `json:"cursor,omitempty"`
	}
	if !readJSONUpTo(w, r, &req, 4<<10) {
		return
	}
	base := s.MCPRegistry
	if base == "" {
		base = DefaultMCPRegistry
	}
	q := url.Values{"limit": {fmt.Sprint(MaxRegistryServers)}, "version": {"latest"}}
	if t := strings.TrimSpace(req.Search); t != "" {
		q.Set("search", t)
	}
	if req.Cursor != "" {
		q.Set("cursor", req.Cursor)
	}
	ctx, cancel := context.WithTimeout(r.Context(), RegistryTimeout)
	defer cancel()
	hreq, err := http.NewRequestWithContext(ctx, "GET", strings.TrimSuffix(base, "/")+"/v0/servers?"+q.Encode(), nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	hreq.Header.Set("Accept", "application/json")
	resp, err := s.registryClient().Do(hreq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "the MCP Registry didn't answer: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, apiError{Error: fmt.Sprintf("the MCP Registry answered %s", resp.Status)})
		return
	}
	var page struct {
		Servers []struct {
			Server registryServer             `json:"server"`
			Meta   map[string]json.RawMessage `json:"_meta"`
		} `json:"servers"`
		Metadata struct {
			NextCursor string `json:"nextCursor"`
		} `json:"metadata"`
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, MaxRegistryBytes+1))
	if err == nil && len(b) > MaxRegistryBytes {
		err = fmt.Errorf("more than %d bytes", MaxRegistryBytes)
	}
	if err == nil {
		err = json.Unmarshal(b, &page)
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "the MCP Registry's answer wasn't understood: " + err.Error()})
		return
	}
	entries := []catalogEntry{}
	for i, sv := range page.Servers {
		if i == MaxRegistryServers {
			break
		}
		if sv.Server.Name == "" || !latest(sv.Meta) {
			continue
		}
		entries = append(entries, clipEntry(assess(sv.Server)))
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": entries, "next": page.Metadata.NextCursor, "registry": base})
}

// latest reports whether an entry's registry metadata, if any, marks it
// as its server's latest version.
func latest(meta map[string]json.RawMessage) bool {
	raw, ok := meta["io.modelcontextprotocol.registry/official"]
	if !ok {
		return true
	}
	var m struct {
		IsLatest *bool `json:"isLatest"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return false // metadata that can't be read keeps no entry (review 28)
	}
	return m.IsLatest == nil || *m.IsLatest
}

// clipEntry bounds what the registry's publishers wrote.
func clipEntry(e catalogEntry) catalogEntry {
	cut := func(s string, n int) string {
		if len(s) > n {
			return strings.ToValidUTF8(s[:n], "") + "…"
		}
		return s
	}
	e.Name, e.Title, e.Description, e.Version = cut(e.Name, 200), cut(e.Title, 200), cut(e.Description, 600), cut(e.Version, 60)
	if len(e.Link) > 500 {
		e.Link = ""
	}
	if len(e.URL) > 500 {
		e.URL, e.Fit, e.Why = "", "no", "Can't be added here: its address is too long."
	}
	return e
}

func (s *Server) registryClient() *http.Client {
	if s.RegistryClient != nil {
		return s.RegistryClient
	}
	// Follow no redirect: the registry's API answers where it's asked, and
	// a redirect could leave its host or https (review 28).
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// TokenPrefix begins the name of every token the Connectors page keeps
// for a connector it added: HEEDLE_CONNECTOR_<NAME>_TOKEN. No tool sets a
// name like it, so a connector a stranger published can't be handed a
// token from the worker's environment (such as GITHUB_TOKEN, which the
// environment would give before the keychain), and removing one deletes
// only keys the page made (review 28).
const TokenPrefix = "HEEDLE_CONNECTOR_"

// TokenName is the keychain name of the token for the connector name.
func TokenName(name string) string {
	return TokenPrefix + strings.ToUpper(strings.ReplaceAll(name, "-", "_")) + "_TOKEN"
}

// addConnector adds a remote connector to the worker's connectors file,
// or removes one: from this machine only, like keys. A token given with
// it goes to the keychain, under TokenName, never into the file.
func (s *Server) addConnector(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "connectors can be changed only from the machine heedle runs on, at localhost, not through a proxy"})
		return
	}
	if s.ConnectorsFile == "" || s.Connectors == nil {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server has no connectors file (give it -connectors FILE)"})
		return
	}
	var req struct {
		Name  string `json:"name"`
		URL   string `json:"url,omitempty"`
		Token string `json:"token,omitempty"`
	}
	if !readJSONUpTo(w, r, &req, 16<<10) {
		return
	}
	removing := r.URL.Path == "/api/connectors/remove"
	if removing && (req.URL != "" || req.Token != "") {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a remove takes only the connector's name"})
		return
	}
	s.connectorsMu.Lock()
	defer s.connectorsMu.Unlock()
	before, err := os.ReadFile(s.ConnectorsFile)
	if err != nil {
		before = []byte{} // not there yet: it must still not be there
	}
	cs, err := s.Connectors()
	if err != nil {
		writeJSON(w, http.StatusConflict, apiError{Error: "the connectors file has a problem to fix first: " + err.Error()})
		return
	}
	i := slices.IndexFunc(cs, func(c pirn.Connector) bool { return c.Name == req.Name })
	ctx := context.WithoutCancel(r.Context())
	switch {
	case removing && i < 0:
		writeJSON(w, http.StatusNotFound, apiError{Error: "no connector " + req.Name})
		return
	case removing:
		gone := cs[i]
		cs = slices.Delete(slices.Clone(cs), i, i+1)
		if err := s.replaceConnectors(before, cs); err != nil {
			writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
			return
		}
		// Only now that the file no longer names it: its token, if the
		// page made it and nothing else names it (review 28).
		for _, n := range secretNames(gone) {
			used := slices.ContainsFunc(cs, func(c pirn.Connector) bool { return slices.Contains(secretNames(c), n) })
			if strings.HasPrefix(n, TokenPrefix) && !used && s.Secrets != nil {
				s.Secrets.Delete(ctx, n)
				s.Secrets.Delete(ctx, oauthName(n)) // what refreshed it, if it was signed in
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"name": req.Name, "removed": true})
		return
	case i >= 0:
		writeJSON(w, http.StatusConflict, apiError{Error: "there is already a connector " + req.Name})
		return
	}
	c := pirn.Connector{Name: req.Name, URL: req.URL}
	if req.Token != "" {
		c.TokenEnv = TokenName(req.Name)
		if err := pirn.CheckSecret(c.TokenEnv, req.Token); err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
			return
		}
		if s.Secrets == nil {
			writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server has no keychain for the token"})
			return
		}
		// Never another's key: not one the environment holds (it would
		// win), one another connector names, or one already kept.
		if os.Getenv(c.TokenEnv) != "" || slices.ContainsFunc(cs, func(o pirn.Connector) bool { return slices.Contains(secretNames(o), c.TokenEnv) }) {
			writeJSON(w, http.StatusConflict, apiError{Error: c.TokenEnv + " is already in use; choose another name"})
			return
		}
		if _, ok, err := s.Secrets.Lookup(r.Context(), c.TokenEnv); err != nil || ok {
			writeJSON(w, http.StatusConflict, apiError{Error: c.TokenEnv + " is already in your keychain (or it can't be read); remove it first, or choose another name"})
			return
		}
	}
	next := append(slices.Clone(cs), c)
	if err := next.Check(); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	if err := s.replaceConnectors(before, next); err != nil {
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
		return
	}
	if c.TokenEnv != "" {
		if err := s.Secrets.Store(ctx, c.TokenEnv, req.Token); err != nil {
			// Put the file back: a connector without its token isn't added.
			s.replaceConnectors(nil, cs)
			writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": req.Name, "removed": false, "token": c.TokenEnv})
}

// replaceConnectors writes cs as the connectors file, if the file still
// holds before (nil: whatever it holds): a hand edit made meanwhile is
// never silently lost.
func (s *Server) replaceConnectors(before []byte, cs pirn.Connectors) error {
	return writeConnectorsFile(s.ConnectorsFile, cs, before)
}

// writeConnectorsFile replaces path with cs, all at once: a new file,
// written and synced, renamed over it, so a worker reading it sees the
// old file or the new one, never half of either. It keeps the file's
// mode, and writes through a symbolic link to the file it names. If
// before isn't nil and the file no longer holds it, nothing is written.
func writeConnectorsFile(path string, cs pirn.Connectors, before []byte) error {
	if cs == nil {
		cs = pirn.Connectors{}
	}
	b, err := json.MarshalIndent(map[string]pirn.Connectors{"connectors": cs}, "", "  ")
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	mode := os.FileMode(0o600)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".connectors-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(append(b, '\n'))
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if before != nil {
		if now, _ := os.ReadFile(path); string(now) != string(before) {
			return errors.New("the connectors file changed meanwhile; look again, and try again")
		}
	}
	return os.Rename(f.Name(), path)
}
