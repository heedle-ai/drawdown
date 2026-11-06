package drawdown

// Saved sign-ins (roadmap 9.11): the sites where act steps start signed in
// as you, listed and forgotten under You, from this machine only; and the
// card's red note that a program's act steps would start signed in.

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/shuttle/plan"
)

// signedInShown says whether the person was shown, exactly, the hosts
// where p's act steps would start signed in as them now, answering 422
// with them if not: no run starts signed in unannounced (roadmap 9.11).
func (s *Server) signedInShown(w http.ResponseWriter, ctx context.Context, p plan.Plan, shown []string) bool {
	in := s.signedIn(ctx, loom.ActHosts(p))
	if slices.Equal(in, shown) || len(in) == 0 && len(shown) == 0 {
		return true
	}
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":       "This program's act steps would start signed in as you on " + strings.Join(in, ", ") + ". Run it where the page says so.",
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

// signedIn are the hosts of hosts with a saved sign-in, sorted: where a
// program's act steps would start signed in as you.
func (s *Server) signedIn(ctx context.Context, hosts []string) []string {
	if s.Sessions == nil || len(hosts) == 0 {
		return nil
	}
	list, err := s.Sessions.List(ctx)
	if err != nil {
		return nil
	}
	kept := map[string]bool{}
	for _, l := range list {
		kept[l.Host] = true
	}
	var out []string
	for _, h := range hosts {
		if kept[h] {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
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
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
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
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
