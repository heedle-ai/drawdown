package drawdown

import (
	"errors"
	"net/http"

	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

// skillFile is one file of a skill's version, as the Skills page lists it.
type skillFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// skills lists the newest version of every skill, and the skills that
// can't be used, with why.
func (s *Server) skills(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"skills": []treadle.Skill{}, "problems": []string{}}
	if s.Skills == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	list, bad, err := s.Skills.Skills(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	problems := []string{}
	for _, e := range bad {
		problems = append(problems, e.Error())
	}
	if list != nil {
		out["skills"] = list
	}
	out["problems"] = problems
	writeJSON(w, http.StatusOK, out)
}

// skill lists every version of one skill, newest first.
func (s *Server) skill(w http.ResponseWriter, r *http.Request) {
	versions, err := s.versions(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if len(versions) == 0 {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no skill " + r.PathValue("name")})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

// skillVersion is one version of a skill: its files with their sizes, and
// its SKILL.md (treadle's Library.Folder). Only a version that was added
// to that skill, and is within pirn's limits, is served.
func (s *Server) skillVersion(w http.ResponseWriter, r *http.Request) {
	if s.Skills == nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no skills here"})
		return
	}
	sk, list, text, err := s.Skills.Folder(r.Context(), r.PathValue("name"), warp.ID(r.PathValue("version")))
	if err != nil {
		writeError(w, err)
		return
	}
	files := []skillFile{}
	for _, f := range list {
		files = append(files, skillFile{Path: f.Path, Size: f.Size})
	}
	writeJSON(w, http.StatusOK, map[string]any{"skill": sk, "files": files, "skillMD": string(text)})
}

func (s *Server) versions(r *http.Request) ([]treadle.Skill, error) {
	if s.Skills == nil {
		return nil, nil
	}
	return s.Skills.Versions(r.Context(), r.PathValue("name"))
}

// writeError answers 404 for something that isn't there, 400 for a
// request treadle or warp refuses, else 500.
func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, warp.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, warp.ErrInvalid):
		status = http.StatusBadRequest
	}
	writeJSON(w, status, apiError{Error: err.Error()})
}
