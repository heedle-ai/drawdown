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
// its SKILL.md. Only a version that was added to that skill is served.
func (s *Server) skillVersion(w http.ResponseWriter, r *http.Request) {
	versions, err := s.versions(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var v *treadle.Skill
	for i := range versions {
		if string(versions[i].Version) == r.PathValue("version") {
			v = &versions[i]
		}
	}
	if v == nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no such version of " + r.PathValue("name")})
		return
	}
	list, err := s.Skills.Store.Files(r.Context(), v.Version)
	if err != nil {
		writeError(w, err)
		return
	}
	files := []skillFile{}
	var md warp.ID
	for _, f := range list {
		files = append(files, skillFile{Path: f.Path, Size: f.Size})
		if f.Path == treadle.SkillFile {
			md = f.ID
		}
	}
	text, err := s.Skills.Store.Blob(r.Context(), md)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skill": v, "files": files, "skillMD": string(text)})
}

func (s *Server) versions(r *http.Request) ([]treadle.Skill, error) {
	if s.Skills == nil {
		return nil, nil
	}
	return s.Skills.Versions(r.Context(), r.PathValue("name"))
}

// writeError answers 400 for a request treadle or warp refuses, else 500.
func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, warp.ErrInvalid) || errors.Is(err, warp.ErrNotFound) {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, apiError{Error: err.Error()})
}
