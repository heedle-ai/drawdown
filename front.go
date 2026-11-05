package drawdown

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

// The front door: "Ask heedle" on the home page. A request (with the
// conversation so far) goes to a worker's Claude (loom.Ask), which
// proposes a program, a schedule if asked for, or a skill to create; the
// worker says whether it can run now. Nothing runs until Run or Schedule,
// which are the ordinary submit and schedule.

// maxAskBody bounds an ask's request body: the request, and the earlier
// turns, each with its program.
const maxAskBody = loom.MaxRequest + loom.MaxTurns*(loom.MaxRequest+loom.MaxSummary+loom.MaxTurnProgram) + 4<<10

func (s *Server) ask(w http.ResponseWriter, r *http.Request) {
	var req loom.AskRequest
	if !readJSONUpTo(w, r, &req, maxAskBody) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), loom.AskTimeout+90*time.Second)
	defer cancel()
	out, err := s.Temporal.Ask(ctx, req)
	var hosts []string
	if out.Plan != nil {
		hosts = loom.ActHosts(*out.Plan)
	}
	switch {
	case errors.Is(err, warp.ErrInvalid) || errors.Is(err, pirn.ErrInvalid) || errors.Is(err, loom.ErrNoProgram):
		writeJSON(w, http.StatusUnprocessableEntity, apiError{Error: err.Error()})
	case err != nil:
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
	default:
		writeJSON(w, http.StatusOK, proposal{Proposal: out, ActHosts: hosts})
	}
}

// proposal is a proposal as the page gets it: with the hosts its act steps
// may click, type and submit forms on without asking again (loom.ActHosts),
// for the card to disclose before Run (roadmap 9.5).
type proposal struct {
	loom.Proposal
	ActHosts []string `json:"actHosts,omitempty"`
}

// ready says whether a program can run now, as loom.CheckReady does on a
// worker: for a proposal's card to check again after something is
// connected. It compiles the program as a run would.
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	var req programRequest
	if !readJSON(w, r, &req) {
		return
	}
	p, ce := s.compileProgram(r.Context(), req.Program)
	if ce != nil {
		writeJSON(w, http.StatusUnprocessableEntity, ce)
		return
	}
	var cs pirn.Connectors
	if s.Connectors != nil {
		var err error
		if cs, err = s.Connectors(); err != nil {
			writeJSON(w, http.StatusOK, loom.Readiness{Needs: []pirn.Need{}, Error: err.Error()})
			return
		}
	}
	var v pirn.Vault = s.StepKeys
	if v == nil && s.Secrets != nil {
		v = s.Secrets
	}
	skills, _ := s.Skills.(loom.SkillGrants)
	if skills == nil {
		skills = noSkills{}
	}
	out, err := loom.CheckReady(r.Context(), p, skills, loom.Worker{Connectors: cs, Keys: v, Agents: s.Agents, Browsers: s.Browsers, BrowserAgents: s.BrowserAgents})
	if err != nil {
		out = loom.Readiness{Needs: []pirn.Need{}, Error: err.Error()}
	}
	writeJSON(w, http.StatusOK, out)
}

// noSkills is a library with no skill versions.
type noSkills struct{}

func (noSkills) StepGrant(context.Context, string, warp.ID) (pirn.Grant, error) {
	return nil, fmt.Errorf("%w: this server has no skills", treadle.ErrInvalid)
}
