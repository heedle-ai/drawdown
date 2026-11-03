package drawdown

import (
	"context"
	"net/http"
	"time"

	"github.com/heedle-ai/loom"
)

// schedules lists loom's schedules.
func (s *Server) schedules(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	ss, err := s.Temporal.Schedules(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	if ss == nil {
		ss = []loom.Schedule{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedules": ss})
}

// scheduleRequest makes a schedule: a program, compiled now and run as
// compiled, every so often or at cron times.
type scheduleRequest struct {
	Name     string `json:"name"`
	Program  string `json:"program"`
	Ref      string `json:"ref,omitempty"`
	Every    string `json:"every,omitempty"` // a Go duration, such as 1h
	Cron     string `json:"cron,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

// createSchedule compiles the program as a run would be, and has Temporal
// run it on the schedule: through loom, as runs are.
func (s *Server) createSchedule(w http.ResponseWriter, r *http.Request) {
	var req scheduleRequest
	if !readJSON(w, r, &req) {
		return
	}
	spec := loom.ScheduleSpec{Cron: req.Cron, TimeZone: req.TimeZone}
	if req.Every != "" {
		d, err := time.ParseDuration(req.Every)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "every: " + err.Error()})
			return
		}
		spec.Every = d
	}
	p, ce := s.compileProgram(r.Context(), req.Program)
	if ce != nil {
		writeJSON(w, http.StatusUnprocessableEntity, ce)
		return
	}
	ref, err := s.ref(r.Context(), req.Ref)
	if badRef(w, err) {
		return
	}
	in := loom.RunInput{Program: req.Program, Plan: p, Ref: ref}
	if _, err := loom.ScheduleOptions(r.Context(), "check", req.Name, in, spec); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	if err := s.Temporal.CreateSchedule(ctx, req.Name, in, spec); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": req.Name})
}

// scheduleAction pauses, resumes, deletes or runs a schedule now.
func (s *Server) scheduleAction(w http.ResponseWriter, r *http.Request) {
	name, action := r.PathValue("name"), r.PathValue("action")
	switch action {
	case "pause", "resume", "delete", "run":
	default:
		writeJSON(w, http.StatusNotFound, apiError{Error: "a schedule can pause, resume, delete or run"})
		return
	}
	// Like any POST here, it must be JSON, so no other site can send it.
	var none struct{}
	if !readJSONUpTo(w, r, &none, 64) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	if err := s.Temporal.ScheduleAction(ctx, name, action); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name, "done": action})
}
