package drawdown

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
)

// loomWorkflow is a run's workflow ID as loom names it, or a merge's
// re-run of a question (review 19: a re-run's writes couldn't be decided
// here).
var loomWorkflow = regexp.MustCompile(`^loom-[0-9a-f]{40,64}(/rerun-[0-9]+)?$`)

// writes are a running run's queued writes so far, from Temporal; a
// finished run's are in its record.
func (s *Server) writes(w http.ResponseWriter, r *http.Request) {
	wf := r.PathValue("workflow")
	if !loomWorkflow.MatchString(wf) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "not a run's workflow ID"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	ws, err := s.Temporal.Writes(ctx, wf)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	if ws == nil {
		ws = []loom.WriteOutcome{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"writes": ws})
}

// decideWrite approves or declines one write that waits for approval,
// by signalling the run (the page never runs a write itself), then
// answers the run's writes.
func (s *Server) decideWrite(w http.ResponseWriter, r *http.Request) {
	wf := r.PathValue("workflow")
	if !loomWorkflow.MatchString(wf) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "not a run's workflow ID"})
		return
	}
	var d loom.WriteDecision
	if !readJSON(w, r, &d) {
		return
	}
	if d.Node == "" || d.ID == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a decision names the write's node and ID"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	if err := s.Temporal.DecideWrite(ctx, wf, d); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	s.writes(w, r)
}

// decideForm sends or cancels a form an act step waits to send, by
// signalling the run (roadmap 9.7): only one waiting now, so a person
// decides on the form they saw. It answers the run's live frames.
func (s *Server) decideForm(w http.ResponseWriter, r *http.Request) {
	wf := r.PathValue("workflow")
	if !loomWorkflow.MatchString(wf) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "not a run's workflow ID"})
		return
	}
	var d loom.FormDecision
	if !readJSON(w, r, &d) {
		return
	}
	if d.ID == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a decision names the form's ID"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	if !s.mayDecideForm(ctx, r, wf) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "A form a step signed in as you would send is decided only on this machine."})
		return
	}
	switch err := s.Temporal.DecideForm(ctx, wf, d); {
	case errors.Is(err, pirn.ErrInvalid):
		writeJSON(w, http.StatusConflict, apiError{Error: "That form isn't waiting to be sent any more."})
		return
	case err != nil:
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	s.live(w, r)
}

// mayDecideForm says whether this request may send or cancel a form of
// the run wf: sending one a step signed in as the person would send is
// acting as them, so only from this machine; from elsewhere only if the
// run's program has no act step signed in, and a run whose program can't
// be read counts as signed in (review 53, round 4).
func (s *Server) mayDecideForm(ctx context.Context, r *http.Request, wf string) bool {
	if fromThisMachine(r, s.Hosts) && r.Header.Get("Sec-Fetch-Site") != "cross-site" {
		return true
	}
	in, err := s.Temporal.Input(ctx, wf)
	return err == nil && len(loom.ActSignedIn(in.Plan)) == 0
}
