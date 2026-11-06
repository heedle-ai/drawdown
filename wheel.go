package drawdown

// Take the wheel (roadmap 9.10): a person drives an act step's browser
// while the step waits for them. Their clicks and keys come here and go
// straight to the step's browser in this process (pirn's Wheels): never
// through Temporal, a record or a log. Only a request from this machine
// may drive it, and only while the step waits.

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
)

// Wheel is an act step's browser while a person may drive it (pirn.Wheel).
type Wheel interface {
	Click(x, y int) error
	Key(key string) error
	Frame() reed.Frame
	HandBack()
}

// Wheels finds the steps of this process waiting for a person.
type Wheels interface {
	Wheel(id string) (Wheel, bool)
}

// PirnWheels is pirn's registry as Wheels: give the same one to the
// worker's act steps.
type PirnWheels struct{ *pirn.Wheels }

// Wheel is the step waiting with that ID, if one is.
func (p PirnWheels) Wheel(id string) (Wheel, bool) {
	w, ok := p.Wheels.Wheel(id)
	if !ok {
		return nil, false
	}
	return w, true
}

var wheelID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// wheel is the step a driving request names, after checking the request
// may drive: from this machine, not from another site, and the step
// waiting for a person here now. It has answered when ok is false.
func (s *Server) wheel(w http.ResponseWriter, r *http.Request) (Wheel, bool) {
	if !fromThisMachine(r, s.Hosts) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, http.StatusForbidden, apiError{Error: "Only a request from this machine can drive a step's browser."})
		return nil, false
	}
	id := r.PathValue("id")
	var wh Wheel
	ok := false
	if s.Wheels != nil && wheelID.MatchString(id) {
		wh, ok = s.Wheels.Wheel(id)
	}
	if !ok {
		writeJSON(w, http.StatusConflict, apiError{Error: "That step isn't waiting for you here, or not any more."})
		return nil, false
	}
	return wh, true
}

// wheelFrame is the latest frame of the browser being driven, as JPEG:
// password fields and what was typed masked; never stored.
func (s *Server) wheelFrame(w http.ResponseWriter, r *http.Request) {
	wh, ok := s.wheel(w, r)
	if !ok {
		return
	}
	f := wh.Frame()
	if len(f.JPEG) == 0 {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "no frame yet"})
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(f.JPEG)
}

// wheelInput is one click or key of the person's (WheelInput). What was
// typed is never logged, echoed or kept here.
func (s *Server) wheelInput(w http.ResponseWriter, r *http.Request) {
	wh, ok := s.wheel(w, r)
	if !ok {
		return
	}
	var in WheelInput
	if !readJSONUpTo(w, r, &in, 1<<10) {
		return
	}
	var err error
	switch {
	case in.Key != nil && in.X == nil && in.Y == nil:
		err = wh.Key(*in.Key)
	case in.Key == nil && in.X != nil && in.Y != nil:
		err = wh.Click(*in.X, *in.Y)
	default:
		writeJSON(w, http.StatusBadRequest, apiError{Error: "an input is a key, or a click's x and y"})
		return
	}
	switch {
	case errors.Is(err, pirn.ErrNotWaiting):
		writeJSON(w, http.StatusConflict, apiError{Error: "That step isn't waiting for you any more."})
	case errors.Is(err, reed.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, apiError{Error: "That isn't a key or click a person can send here."})
	case err != nil:
		writeJSON(w, http.StatusBadGateway, apiError{Error: "The browser didn't take it."})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// WheelInput is a click at (X, Y) in the page's CSS pixels, or a Key.
type WheelInput struct {
	X   *int    `json:"x,omitempty"`
	Y   *int    `json:"y,omitempty"`
	Key *string `json:"key,omitempty"`
}

// wheelHandBack gives the browser back to Claude.
func (s *Server) wheelHandBack(w http.ResponseWriter, r *http.Request) {
	wh, ok := s.wheel(w, r)
	if !ok {
		return
	}
	wh.HandBack()
	w.WriteHeader(http.StatusNoContent)
}
