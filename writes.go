package drawdown

import (
	"context"
	"net/http"
	"regexp"

	"github.com/heedle-ai/loom"
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
