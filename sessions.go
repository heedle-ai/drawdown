package drawdown

// Saved sign-ins (roadmap 9.11): the sites where act steps start signed in
// as you, listed and forgotten under You, from this machine only; and the
// card's red note that a program's act steps would start signed in.

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/shuttle/plan"
)

// signedInShown lets a program whose act steps start signed in as the
// person (:signed-in, loom.ActSignedIn) run or be scheduled only from this
// machine (403 elsewhere: a run signed in as you shows the pages it saw to
// whoever started it; review 53), and only if the page showed those hosts,
// exactly (422). It reads the program alone, never which sign-ins are
// kept, so it tells no one which sites you have one on.
func (s *Server) signedInShown(w http.ResponseWriter, r *http.Request, p plan.Plan, shown []string) bool {
	in := loom.ActSignedIn(p)
	if len(in) == 0 {
		return true
	}
	if !fromThisMachine(r, s.Hosts) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "A program whose act steps start signed in as you runs only from this machine."})
		return false
	}
	if slices.Equal(in, shown) {
		return true
	}
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":       "This program's act steps start signed in as you on " + strings.Join(in, ", ") + ". Run it where the page says so.",
		"actSignedIn": in,
	})
	return false
}

// Sessions are the saved sign-ins (pirn.Sessions): their hosts and times,
// never what they hold.
type Sessions interface {
	List(ctx context.Context) ([]pirn.SessionInfo, error)
	Forget(ctx context.Context, host string) error
}

// listSessions lists the saved sign-ins, to this machine only.
func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "Your saved sign-ins are shown only on this machine."})
		return
	}
	if s.Sessions == nil {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": []pirn.SessionInfo{}})
		return
	}
	list, err := s.Sessions.List(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Your saved sign-ins couldn't be read."}) // never the keychain's words (review 53)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": list})
}

// forgetSession forgets one: its file and its key. From this machine only.
func (s *Server) forgetSession(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "Your saved sign-ins are changed only on this machine."})
		return
	}
	var in struct {
		Host string `json:"host"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if s.Sessions == nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no saved sign-ins here"})
		return
	}
	switch err := s.Sessions.Forget(r.Context(), in.Host); {
	case errors.Is(err, pirn.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "That sign-in couldn't be forgotten."}) // never the keychain's words (review 53)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
