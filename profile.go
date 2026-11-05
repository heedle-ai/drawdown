package drawdown

import (
	"errors"
	"net/http"

	"github.com/heedle-ai/pirn"
)

// The person's details (roadmap 9.8): the Connectors page's You section.
// They live in this machine's keychain (pirn.StoreProfile), are read and
// changed only from this machine, as keys are set, and never go through
// Temporal, Git or a log.

// profileField is one detail as the page gets it.
type profileField struct {
	Field string `json:"field"`
	Label string `json:"label"`
	Set   bool   `json:"set"`
	Value string `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

// profile answers the person's details, to this machine only.
func (s *Server) profile(w http.ResponseWriter, r *http.Request) {
	if !s.profileHere(w, r) {
		return
	}
	out := []profileField{}
	for _, f := range pirn.ProfileFields {
		v, ok, err := pirn.LookupProfile(r.Context(), s.Secrets, f)
		p := profileField{Field: f, Label: pirn.ProfileLabels[f], Set: ok, Value: v}
		if err != nil {
			p.Error = err.Error()
		}
		out = append(out, p)
	}
	w.Header().Set("Cache-Control", "no-store") // the values stay out of caches
	writeJSON(w, http.StatusOK, map[string]any{"fields": out})
}

// profileRequest sets (with a value) or forgets (without) one detail.
type profileRequest struct {
	Field string `json:"field"`
	Value string `json:"value,omitempty"`
}

// setProfile keeps or forgets one detail in the keychain, from this
// machine only, then answers the details.
func (s *Server) setProfile(w http.ResponseWriter, r *http.Request) {
	if !s.profileHere(w, r) {
		return
	}
	var req profileRequest
	if !readJSONUpTo(w, r, &req, 4<<10) {
		return
	}
	var err error
	if r.URL.Path == "/api/profile/delete" {
		if req.Value != "" {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "forgetting a detail takes only its field"})
			return
		}
		err = pirn.DeleteProfile(r.Context(), s.Secrets, req.Field)
	} else {
		err = pirn.StoreProfile(r.Context(), s.Secrets, req.Field, req.Value)
	}
	switch {
	case errors.Is(err, pirn.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	case err != nil:
		// The keychain's error, never the value (pirn's errors don't hold it).
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.profile(w, r)
}

// profileHere refuses, with 403, a request that isn't straight from this
// machine, and, with 501, a server without a keychain.
func (s *Server) profileHere(w http.ResponseWriter, r *http.Request) bool {
	// A page on another site can't read or change them, even if a browser
	// would send the request (review 42); the Host and Origin checks every
	// request gets stop DNS rebinding and cross-site posts.
	if !fromThisMachine(r, s.Hosts) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "your details are shown and changed only on the machine heedle runs on, at localhost, not through a proxy"})
		return false
	}
	if s.Secrets == nil {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server has no keychain"})
		return false
	}
	return true
}
