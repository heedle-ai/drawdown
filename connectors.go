package drawdown

import (
	"context"
	"net"
	"net/http"
	"os"
	"slices"

	"github.com/heedle-ai/pirn"
)

// Secrets is where the Connectors page keeps keys: the worker's own
// keychain (pirn.Keychain), never Temporal, Git or a log.
type Secrets interface {
	pirn.Vault
	Store(ctx context.Context, name, value string) error
	Delete(ctx context.Context, name string) error
}

// AnthropicKey is the one secret the page sets that no connector names.
const AnthropicKey = "ANTHROPIC_API_KEY"

// connectorView is a connector as the Connectors page shows it: what it
// is and where each of its secrets is found. A secret's value never
// leaves the server.
type connectorView struct {
	Name    string       `json:"name"`
	URL     string       `json:"url,omitempty"`
	Image   string       `json:"image,omitempty"`
	Command []string     `json:"command,omitempty"`
	Tools   []string     `json:"tools,omitempty"`
	Writes  []string     `json:"writes,omitempty"`
	Approve bool         `json:"approve,omitempty"`
	Secrets []secretView `json:"secrets"`
}

type secretView struct {
	Name string `json:"name"`
	// From is "environment", "keychain" or "missing"; Error says why the
	// keychain couldn't be read.
	From  string `json:"from"`
	Error string `json:"error,omitempty"`
}

// secretNames are the names c's credentials are found by.
func secretNames(c pirn.Connector) []string {
	var out []string
	if c.TokenEnv != "" {
		out = append(out, c.TokenEnv)
	}
	for _, from := range c.Secrets {
		if !slices.Contains(out, from) {
			out = append(out, from)
		}
	}
	slices.Sort(out)
	return out
}

func (s *Server) secretView(ctx context.Context, name string) secretView {
	v := secretView{Name: name, From: "missing"}
	if os.Getenv(name) != "" {
		v.From = "environment"
		return v
	}
	if s.Secrets == nil {
		return v
	}
	if _, ok, err := s.Secrets.Lookup(ctx, name); err != nil {
		v.Error = err.Error()
	} else if ok {
		v.From = "keychain"
	}
	return v
}

// connectors lists the worker's connectors, as its connectors file has
// them now, with where each secret is found.
func (s *Server) connectors(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{"file": s.ConnectorsFile, "anthropic": s.secretView(r.Context(), AnthropicKey), "keychain": s.Secrets != nil}
	views := []connectorView{}
	if s.Connectors != nil {
		cs, err := s.Connectors()
		if err != nil {
			resp["error"] = err.Error()
		}
		for _, c := range cs {
			v := connectorView{Name: c.Name, URL: c.URL, Image: c.Image, Command: c.Command, Tools: c.Tools, Writes: c.Writes, Approve: c.Approve, Secrets: []secretView{}}
			for _, n := range secretNames(c) {
				v.Secrets = append(v.Secrets, s.secretView(r.Context(), n))
			}
			views = append(views, v)
		}
	}
	resp["connectors"] = views
	writeJSON(w, http.StatusOK, resp)
}

// secretRequest sets (with a value) or deletes (without) one secret.
type secretRequest struct {
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
}

// setSecret stores or deletes a secret in the keychain: only from this
// machine (a loopback address), only a name a connector uses or the
// Anthropic key, and never through Temporal, which would keep it in the
// run's history. The value is never written back, logged or kept.
func (s *Server) setSecret(w http.ResponseWriter, r *http.Request) {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err != nil || !net.ParseIP(host).IsLoopback() {
		writeJSON(w, http.StatusForbidden, apiError{Error: "keys can be set only from the machine heedle runs on"})
		return
	}
	if s.Secrets == nil {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server has no keychain"})
		return
	}
	var req secretRequest
	if !readJSONUpTo(w, r, &req, 16<<10) {
		return
	}
	if !s.secretKnown(req.Name) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "no connector uses a key named " + req.Name})
		return
	}
	var err error
	if r.URL.Path == "/api/secrets/delete" {
		err = s.Secrets.Delete(r.Context(), req.Name)
	} else {
		err = s.Secrets.Store(r.Context(), req.Name, req.Value)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.secretView(r.Context(), req.Name))
}

// secretKnown reports whether name is the Anthropic key or a name a
// connector uses.
func (s *Server) secretKnown(name string) bool {
	if name == AnthropicKey {
		return true
	}
	if s.Connectors == nil {
		return false
	}
	cs, _ := s.Connectors()
	for _, c := range cs {
		if slices.Contains(secretNames(c), name) {
			return true
		}
	}
	return false
}
