// Package drawdown is heedle-ai's web UI: write a draft program, run it on
// Temporal through loom, and browse every run's record in warp.
//
// The server is a small JSON API over existing pieces (draft compiles,
// loom submits, Temporal reports status, warp/Git holds the records) plus
// one static page. The page is React from a CDN, with htm for JSX-style
// markup, mermaid for plan graphs and diff2html for diffs: no build step.
package drawdown

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/draft/sexpr"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/warp"
)

//go:embed static
var static embed.FS

const (
	// ListLimit is how many recent records the runs list reads.
	ListLimit = 200
	// temporalTimeout bounds every call to Temporal, so a slow server can't
	// stall the UI.
	temporalTimeout = 5 * time.Second
)

// Execution is one Temporal workflow execution of loom's RunWorkflow.
type Execution struct {
	WorkflowID string    `json:"workflowId"`
	RunID      string    `json:"runId"`
	Status     string    `json:"status"` // Running, Completed, Failed, …
	Start      time.Time `json:"start"`
	Close      time.Time `json:"close,omitzero"`
}

// Temporal is what the UI needs from Temporal. TemporalClient implements
// it with the Go SDK; tests use a fake.
type Temporal interface {
	Submit(ctx context.Context, in loom.RunInput) (workflowID, runID string, err error)
	List(ctx context.Context) ([]Execution, error)
	Describe(ctx context.Context, workflowID, runID string) (Execution, error)
}

// History is the read-only part of a warp store that the UI uses. A
// *warp.Store satisfies it. The UI never writes: it has no way to commit,
// store objects or move refs (DRAW-8); all writes go through loom.
type History interface {
	Resolve(ctx context.Context, ref string) (warp.ID, bool, error)
	Log(ctx context.Context, from warp.ID, limit int) ([]warp.CommitInfo, error)
	Tree(ctx context.Context, id warp.ID) ([]warp.Entry, error)
	Blob(ctx context.Context, id warp.ID) ([]byte, error)
	Parents(ctx context.Context, commit warp.ID) (tree warp.ID, parents []warp.ID, err error)
	FindByTrailer(ctx context.Context, from warp.ID, key, value string) (warp.ID, bool, error)
	Diff(ctx context.Context, a, b warp.ID) ([]byte, error)
}

// Server serves the UI and its API.
type Server struct {
	Store      History            // read-only; see History
	Ref        string             // warp ref runs are recorded on
	Registry   *registry.Registry // commands programs may use
	Temporal   Temporal
	TemporalUI string            // base URL of Temporal's Web UI, for links
	Namespace  string            // Temporal namespace, for links
	Examples   map[string]string // name -> program, offered in the editor
	// Hosts are the Host header values the server answers to, besides
	// localhost and loopback addresses. Requests for any other host are
	// refused, which defeats DNS rebinding.
	Hosts []string

	programs sync.Map // tree ID -> program text; trees never change
}

// Handler returns the HTTP handler for the UI and API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	page, _ := fs.Sub(static, "static")
	mux.Handle("GET /", http.FileServerFS(page))
	mux.HandleFunc("GET /api/info", s.info)
	mux.HandleFunc("POST /api/compile", s.compile)
	mux.HandleFunc("POST /api/runs", s.submit)
	mux.HandleFunc("GET /api/runs", s.list)
	mux.HandleFunc("GET /api/runs/{workflow}/{run}", s.detail)
	mux.HandleFunc("GET /api/diff/{from}/{to}", s.diff)
	return s.guard(mux)
}

// guard refuses requests that a web page on another site could make: an
// unexpected Host (DNS rebinding) or a cross-origin Origin. drawdown has no
// login, so these checks are what stop other sites from using it.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowedHost(r.Host) {
			writeJSON(w, http.StatusForbidden, apiError{Error: "host not allowed: " + r.Host})
			return
		}
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			if err != nil || u.Host != r.Host {
				writeJSON(w, http.StatusForbidden, apiError{Error: "cross-origin request refused"})
				return
			}
		}
		w.Header().Set("Content-Security-Policy", ContentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// ContentSecurityPolicy is sent with every response. Scripts come only from
// this server and the pinned jsDelivr files (each also checked by its
// integrity hash); the page can talk only to this server, can't be framed,
// and loads no plugins. Inline styles are allowed because mermaid draws
// its diagrams with them.
const ContentSecurityPolicy = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; " +
	"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; font-src 'self' data:; " +
	"connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func (s *Server) allowedHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	for _, h := range s.Hosts {
		if strings.EqualFold(h, host) || strings.EqualFold(h, hostport) {
			return true
		}
	}
	return false
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ref": s.Ref, "temporalUI": s.TemporalUI, "namespace": s.namespace(),
		"commands": s.Registry.Names(), "examples": s.Examples,
	})
}

func (s *Server) namespace() string {
	if s.Namespace == "" {
		return "default"
	}
	return s.Namespace
}

type programRequest struct {
	Program string `json:"program"`
}

// apiError is an error reply; Line and Col are set for syntax errors.
type apiError struct {
	Error string `json:"error"`
	Line  int    `json:"line,omitempty"`
	Col   int    `json:"col,omitempty"`
}

func (s *Server) compileProgram(ctx context.Context, src string) (plan.Plan, *apiError) {
	p, err := draft.Compile(ctx, s.Registry, draft.Source(src))
	if err == nil {
		return p, nil
	}
	ce := &apiError{Error: err.Error()}
	var se sexpr.SyntaxError
	if errors.As(err, &se) {
		ce.Line, ce.Col = se.Pos.Line, se.Pos.Col
	}
	return plan.Plan{}, ce
}

func (s *Server) compile(w http.ResponseWriter, r *http.Request) {
	var req programRequest
	if !readJSON(w, r, &req) {
		return
	}
	// A program with errors is a successful check: report it with 200.
	p, ce := s.compileProgram(r.Context(), req.Program)
	if ce != nil {
		writeJSON(w, http.StatusOK, ce)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	var req programRequest
	if !readJSON(w, r, &req) {
		return
	}
	p, ce := s.compileProgram(r.Context(), req.Program)
	if ce != nil {
		writeJSON(w, http.StatusUnprocessableEntity, ce)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	wf, run, err := s.Temporal.Submit(ctx, loom.RunInput{Program: req.Program, Plan: p, Ref: s.Ref})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"workflowId": wf, "runId": run})
}

// runRow is one row of the runs list: a Temporal execution, joined with
// its warp record when it has one.
type runRow struct {
	Execution
	Commit  warp.ID `json:"commit,omitempty"`
	Program string  `json:"program,omitempty"`
}

func trailer(c warp.CommitInfo, key string) string {
	for _, t := range c.Trailers {
		if t.Key == key {
			return t.Value
		}
	}
	return ""
}

func (s *Server) head(ctx context.Context) (warp.ID, bool, error) {
	return s.Store.Resolve(ctx, s.Ref)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var recs []warp.CommitInfo
	head, ok, err := s.head(ctx)
	if err == nil && ok {
		recs, err = s.Store.Log(ctx, head, ListLimit)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	byRun := map[string]warp.CommitInfo{}
	for _, c := range recs {
		byRun[trailer(c, loom.TrailerRun)] = c
	}

	tctx, cancel := context.WithTimeout(ctx, temporalTimeout)
	execs, terr := s.Temporal.List(tctx)
	cancel()

	rows := []runRow{}
	seen := map[string]bool{}
	for _, e := range execs {
		row := runRow{Execution: e}
		if c, ok := byRun[e.RunID]; ok {
			row.Commit = c.ID
			row.Program = s.program(ctx, c.Tree)
		}
		seen[e.RunID] = true
		rows = append(rows, row)
	}
	// Records Temporal didn't list (retention expired, outside its latest
	// results, or Temporal unreachable) are still history.
	for _, c := range recs {
		if run := trailer(c, loom.TrailerRun); !seen[run] {
			rows = append(rows, runRow{
				Execution: Execution{WorkflowID: trailer(c, loom.TrailerWorkflow), RunID: run, Status: "Recorded", Start: c.Time},
				Commit:    c.ID, Program: s.program(ctx, c.Tree),
			})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Start.After(rows[j].Start) })
	resp := map[string]any{"runs": rows}
	if terr != nil {
		resp["temporalError"] = terr.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// program returns a record tree's program.draft, or "" if unreadable.
// Trees are content-addressed and never change, so results are cached.
func (s *Server) program(ctx context.Context, tree warp.ID) string {
	if v, ok := s.programs.Load(tree); ok {
		return v.(string)
	}
	id, ok := s.entry(ctx, tree, "program.draft")
	if !ok {
		return ""
	}
	b, err := s.Store.Blob(ctx, id)
	if err != nil {
		return ""
	}
	s.programs.Store(tree, string(b))
	return string(b)
}

func (s *Server) entry(ctx context.Context, tree warp.ID, name string) (warp.ID, bool) {
	entries, err := s.Store.Tree(ctx, tree)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if e.Name == name {
			return e.ID, true
		}
	}
	return "", false
}

// record is a run's warp record, as the detail view shows it.
type record struct {
	Commit   warp.ID           `json:"commit"`
	Program  string            `json:"program"`
	Plan     plan.Plan         `json:"plan"`
	Outputs  map[string]string `json:"outputs"`
	Parent   warp.ID           `json:"parent,omitempty"`   // the record before this one
	Previous warp.ID           `json:"previous,omitempty"` // the last earlier run of the same workflow
}

func (s *Server) detail(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	wf, run := r.PathValue("workflow"), r.PathValue("run")
	resp := map[string]any{"temporalUI": s.TemporalUI, "namespace": s.namespace()}

	tctx, cancel := context.WithTimeout(ctx, temporalTimeout)
	exec, terr := s.Temporal.Describe(tctx, wf, run)
	cancel()
	if terr == nil {
		resp["execution"] = exec
	} else {
		resp["temporalError"] = terr.Error()
	}

	rec, found, err := s.findRecord(ctx, wf, run)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	if found {
		resp["record"] = rec
	}
	if !found && terr != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no record of this run, and Temporal: " + terr.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// findRecord finds a run's record by its trailer, letting git search the
// history (git log --grep), and the previous record of the same workflow.
func (s *Server) findRecord(ctx context.Context, wf, run string) (record, bool, error) {
	head, ok, err := s.head(ctx)
	if err != nil || !ok {
		return record{}, false, err
	}
	commit, ok, err := s.Store.FindByTrailer(ctx, head, loom.TrailerRun, run)
	if errors.Is(err, warp.ErrInvalid) {
		return record{}, false, nil // not a value a record could have
	}
	if err != nil || !ok {
		return record{}, false, err
	}
	tree, parents, err := s.Store.Parents(ctx, commit)
	if err != nil {
		return record{}, false, err
	}
	rec, err := s.readRecord(ctx, commit, tree)
	if err != nil {
		return record{}, false, err
	}
	if len(parents) > 0 {
		rec.Parent = parents[0]
		if prev, ok, err := s.Store.FindByTrailer(ctx, parents[0], loom.TrailerWorkflow, wf); err == nil && ok {
			rec.Previous = prev
		}
	}
	return rec, true, nil
}

func (s *Server) readRecord(ctx context.Context, commit, tree warp.ID) (record, error) {
	rec := record{Commit: commit, Program: s.program(ctx, tree), Outputs: map[string]string{}}
	if id, ok := s.entry(ctx, tree, "plan.json"); ok {
		b, err := s.Store.Blob(ctx, id)
		if err != nil {
			return rec, err
		}
		if err := json.Unmarshal(b, &rec.Plan); err != nil {
			return rec, err
		}
	}
	if outs, ok := s.entry(ctx, tree, "outputs"); ok {
		entries, err := s.Store.Tree(ctx, outs)
		if err != nil {
			return rec, err
		}
		for _, e := range entries {
			b, err := s.Store.Blob(ctx, e.ID)
			if err != nil {
				return rec, err
			}
			rec.Outputs[e.Name] = string(b)
		}
	}
	return rec, nil
}

func (s *Server) diff(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Diff(r.Context(), warp.ID(r.PathValue("from")), warp.ID(r.PathValue("to")))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, warp.ErrInvalid) || errors.Is(err, warp.ErrNotFound) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, apiError{Error: err.Error()})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(d)
}

// readJSON accepts only an application/json body holding exactly one JSON
// value with known fields, up to 1 MB. Requiring the content type means a
// plain HTML form on another site can't post to the API.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, apiError{Error: "Content-Type must be application/json"})
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	err := dec.Decode(v)
	if err == nil && dec.More() {
		err = errors.New("trailing data after the JSON value")
	}
	if err == nil {
		var rest bytes.Buffer
		rest.ReadFrom(dec.Buffered())
		if strings.TrimSpace(rest.String()) != "" {
			err = errors.New("trailing data after the JSON value")
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "bad request: " + strings.TrimSpace(err.Error())})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
