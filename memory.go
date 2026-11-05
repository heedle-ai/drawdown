package drawdown

import (
	"errors"
	"net/http"
	"time"

	"github.com/heedle-ai/loom"
)

// Memory you can see (roadmap 10.1): the memory page lists, word for
// word, everything heedle remembers about you and sends to Claude with
// each front-door request; it edits and forgets them. The card's Remember
// adds what Claude suggested, and only then. Every change is loom's
// (ChangeMemory), from this machine only, and one based on a version the
// file no longer has, such as one edited by hand while the page was
// open, is refused rather than overwriting it.

// memoryView is the memory page's answer: everything remembered, the
// version a change must be based on, and the file it's in.
type memoryView struct {
	Memories loom.Memories `json:"memories"`
	Version  string        `json:"version"`
	File     string        `json:"file"`
	// Problems: why a memory edited by hand can't go to Claude, by ID (and
	// a bound the whole list is over, under ""), so it can be seen and
	// forgotten (review 47).
	Problems map[string]string `json:"problems,omitempty"`
}

// memory is GET /api/memory: what heedle remembers about you, from this
// machine only, like every change to it (review 47: with -hosts, anyone
// who could reach the page could read it).
func (s *Server) memory(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "what heedle remembers can be seen only from the machine heedle runs on, at localhost, not through a proxy"})
		return
	}
	if s.MemoryFile == "" {
		writeJSON(w, http.StatusOK, memoryView{Memories: loom.Memories{}})
		return
	}
	ms, err := loom.ReadMemoryAsIs(s.MemoryFile)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "unreadable": true, "file": s.MemoryFile})
		return
	}
	writeJSON(w, http.StatusOK, memoryView{Memories: ms, Version: ms.Version(), File: s.MemoryFile, Problems: ms.Problems()})
}

// changeMemory is POST /api/memory/{add,edit,forget,forget-all}: add
// takes the text (and a version if the page has one); edit the ID, the
// new text and the version; forget the ID and the version; forget-all the
// version. It answers with what's remembered afterwards.
func (s *Server) changeMemory(w http.ResponseWriter, r *http.Request) {
	if !fromThisMachine(r, s.Hosts) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "what heedle remembers can be changed only from the machine heedle runs on, at localhost, not through a proxy"})
		return
	}
	if s.MemoryFile == "" {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server keeps no memory (give it -memory FILE, or -connectors FILE for memory.json beside it)"})
		return
	}
	var req struct {
		ID      string `json:"id,omitempty"`
		Text    string `json:"text,omitempty"`
		Version string `json:"version,omitempty"`
	}
	if !readJSONUpTo(w, r, &req, 8<<10) {
		return
	}
	op := r.PathValue("op")
	want := map[string][2]bool{"add": {false, true}, "edit": {true, true}, "forget": {true, false}, "forget-all": {false, false}} // id, text
	shape, ok := want[op]
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no such change: " + op})
		return
	}
	// Forget everything takes no version only for a file heedle can't read
	// at all, which has none: it must still be possible (review 47).
	_, unreadable := loom.ReadMemoryAsIs(s.MemoryFile)
	anyway := op == "forget-all" && req.Version == "" && unreadable != nil
	if (req.ID != "") != shape[0] || (req.Text != "") != shape[1] || (op != "add" && req.Version == "" && !anyway) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a memory " + op + " takes " + map[string]string{
			"add": "the text", "edit": "the ID, the new text and the version", "forget": "the ID and the version", "forget-all": "the version"}[op]})
		return
	}
	var (
		added loom.Memory
		err   error
	)
	switch op {
	case "add":
		added, err = loom.AddMemory(s.MemoryFile, req.Version, req.Text, time.Now())
	case "edit":
		_, err = loom.EditMemory(s.MemoryFile, req.Version, req.ID, req.Text)
	case "forget":
		_, err = loom.ForgetMemory(s.MemoryFile, req.Version, req.ID)
	case "forget-all":
		_, err = loom.ForgetAllMemory(s.MemoryFile, req.Version)
	}
	switch {
	case errors.Is(err, loom.ErrMemoryInvalid), errors.Is(err, loom.ErrMemoryFile):
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	case errors.Is(err, loom.ErrMemoryChanged):
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
		return
	case errors.Is(err, loom.ErrNoMemory):
		writeJSON(w, http.StatusNotFound, apiError{Error: err.Error()})
		return
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	ms, err := loom.ReadMemoryAsIs(s.MemoryFile)
	if err != nil {
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
		return
	}
	resp := map[string]any{"memories": ms, "version": ms.Version(), "file": s.MemoryFile, "problems": ms.Problems()}
	if op == "add" {
		resp["memory"] = added
	}
	writeJSON(w, http.StatusOK, resp)
}
