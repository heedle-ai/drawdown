package drawdown

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/heedle-ai/loom"
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
	pending, bad, err := s.Skills.Pending(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	for _, e := range bad {
		problems = append(problems, e.Error())
	}
	out["pending"] = []treadle.Skill{}
	if pending != nil {
		out["pending"] = pending
	}
	out["problems"] = problems
	writeJSON(w, http.StatusOK, out)
}

// MaxReviewDiff is the largest diff the review page shows; a bigger one
// is left out, with the command that prints it.
const MaxReviewDiff = MaxDiffBlob

// skillReview is the import of a skill waiting for review (treadle's
// Library.Review): its files, its SKILL.md, the version it would replace
// and its diff from that version. The page only shows it: approving or
// rejecting is loom's (loom skills -approve or -reject).
func (s *Server) skillReview(w http.ResponseWriter, r *http.Request) {
	if s.Skills == nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no skills here"})
		return
	}
	rv, err := s.Skills.Review(r.Context(), r.PathValue("name"))
	if err != nil {
		writeError(w, err)
		return
	}
	files := []skillFile{}
	for _, f := range rv.Files {
		files = append(files, skillFile{Path: f.Path, Size: f.Size})
	}
	out := map[string]any{"skill": rv.Pending, "files": files, "skillMD": string(rv.SkillMD), "replaces": string(rv.Replaces), "binary": []string{}}
	if rv.Current != nil {
		out["current"] = rv.Current
	}
	if rv.Binary != nil {
		out["binary"] = rv.Binary
	}
	if len(rv.Diff) <= MaxReviewDiff {
		out["diff"] = string(rv.Diff)
	} else {
		out["diffTooLarge"] = len(rv.Diff)
	}
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

// skillsTimeout is how long the page waits for a change: a little longer
// than loom lets the change take, so a change reported as failed is never
// made afterwards.
const skillsTimeout = loom.SkillsTimeout + 30*time.Second

// changeSkills runs one change on a worker and replies with the skill it
// concerns: 400 with the library's reason for a refusal, 502 if Temporal
// or the worker failed.
func (s *Server) changeSkills(w http.ResponseWriter, r *http.Request, in loom.SkillsChange) {
	ctx, cancel := context.WithTimeout(r.Context(), skillsTimeout)
	defer cancel()
	sk, err := s.Temporal.ChangeSkills(ctx, in)
	switch {
	case errors.Is(err, warp.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	case err != nil:
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"skill": sk})
	}
}

// importSkill imports a skill from a GitHub link or a repository URL
// (treadle's SourceFor). Trust rules apply: from an untrusted repository
// it waits for review.
func (s *Server) importSkill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Link   string `json:"link"`
		Path   string `json:"path,omitempty"`
		Branch string `json:"branch,omitempty"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	src, err := treadle.SourceFor(strings.TrimSpace(req.Link), strings.TrimSpace(req.Path), strings.TrimSpace(req.Branch))
	if err != nil {
		writeError(w, err)
		return
	}
	// Only from the network: a file:// source would read the worker's
	// own disk for whoever can reach the page (review 18).
	if !strings.HasPrefix(src.Repo, "https://") {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "the page imports only from https:// repositories; import others with loom skills -import on the worker"})
		return
	}
	s.changeSkills(w, r, loom.SkillsChange{Op: loom.SkillsImport, Source: &src})
}

// addSkill adds a folder given by hand (pasted or uploaded): files by
// path, each base64 in JSON, at most loom.MaxSkillsChangeBytes in all.
// Like loom skills -add, it needs no review.
func (s *Server) addSkill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Files map[string][]byte `json:"files"`
	}
	if !readJSONUpTo(w, r, &req, 2*loom.MaxSkillsChangeBytes) {
		return
	}
	s.changeSkills(w, r, loom.SkillsChange{Op: loom.SkillsAdd, Files: req.Files})
}

// decision is an approval or a rejection of exactly the version a review
// showed, and for an approval the version its diff was from.
type decision struct {
	Version  warp.ID `json:"version"`
	Replaces warp.ID `json:"replaces,omitempty"`
}

func (s *Server) approveSkill(w http.ResponseWriter, r *http.Request) {
	var req decision
	if !readJSON(w, r, &req) {
		return
	}
	s.changeSkills(w, r, loom.SkillsChange{Op: loom.SkillsApprove, Name: r.PathValue("name"), Version: req.Version, Replaces: req.Replaces})
}

func (s *Server) rejectSkill(w http.ResponseWriter, r *http.Request) {
	var req decision
	if !readJSON(w, r, &req) {
		return
	}
	if req.Replaces != "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a rejection takes only the version"})
		return
	}
	s.changeSkills(w, r, loom.SkillsChange{Op: loom.SkillsReject, Name: r.PathValue("name"), Version: req.Version})
}
