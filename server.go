// Package drawdown is heedle-ai's web UI: write a draft program, run it on
// Temporal through loom, and browse every run's record in warp.
//
// The server is a small JSON API over existing pieces (draft compiles,
// loom submits, Temporal reports status, warp/Git holds the records) plus
// one static page. The page is React from a CDN, with htm for JSX-style
// markup and diff2html for diffs: no build step.
package drawdown

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/heedle-ai/pirn"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/draft/sexpr"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/treadle"
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
	Ref        string    `json:"ref,omitempty"` // the ref it records on (loom.MemoRef), if known
}

// Temporal is what the UI needs from Temporal. TemporalClient implements
// it with the Go SDK; tests use a fake.
type Temporal interface {
	Submit(ctx context.Context, in loom.RunInput) (workflowID, runID string, err error)
	List(ctx context.Context) ([]Execution, error)
	Describe(ctx context.Context, workflowID, runID string) (Execution, error)
	// Steps is each activity of a run as Temporal's history records it.
	Steps(ctx context.Context, workflowID, runID string) ([]Step, error)
	// Live returns the latest live frame of each browsing step a run is
	// executing now: reed heartbeats them to Temporal.
	Live(ctx context.Context, workflowID string) ([]LiveFrame, error)
	// ChangeSkills runs loom's skills workflow on a worker and waits for
	// it: the only way the UI changes skills.
	ChangeSkills(ctx context.Context, in loom.SkillsChange) (treadle.Skill, error)
	// Writes are a running run's queued writes so far (loom.Writes), and
	// DecideWrite approves or declines one that waits (loom.DecideWrite).
	Writes(ctx context.Context, workflowID string) ([]loom.WriteOutcome, error)
	DecideWrite(ctx context.Context, workflowID string, d loom.WriteDecision) error
	// DecideForm sends or cancels a form an act step waits to send
	// (loom.DecideForm; roadmap 9.7): only one waiting now.
	DecideForm(ctx context.Context, workflowID string, d loom.FormDecision) error
	// WriteProgram has a worker's Claude write a program for a task
	// (loom.WriteProgram); nothing runs.
	WriteProgram(ctx context.Context, description string) (loom.Written, error)
	// Ask has a worker's Claude propose what heedle would do for a request
	// (loom.Ask); nothing runs.
	Ask(ctx context.Context, in loom.AskRequest) (loom.Proposal, error)
	// ListSkills lists a repository's skills on a worker
	// (loom.ListSkills); nothing changes.
	ListSkills(ctx context.Context, src treadle.Source) (loom.Catalog, error)
	// Schedules: loom's (loom.CreateSchedule, loom.Schedules and
	// loom.ScheduleAction), each run recorded like any other.
	CreateSchedule(ctx context.Context, name string, in loom.RunInput, spec loom.ScheduleSpec) error
	Schedules(ctx context.Context) ([]loom.Schedule, error)
	ScheduleAction(ctx context.Context, name, action string) error
}

// LiveFrame is what a browsing step last showed.
type LiveFrame struct {
	Activity string `json:"activity"` // Temporal activity ID
	Kind     string `json:"kind"`     // the step's command: browse or act
	Attempt  int32  `json:"attempt"`
	URL      string `json:"url"`
	Image    string `json:"image"` // data:image/jpeg;base64,…
	// Pending is the form an act step waits to send, filled as Image
	// shows it, for a person to send or cancel (roadmap 9.7).
	Pending *pirn.ActPending `json:"pending,omitempty"`
}

// History is the read-only part of a warp store that the UI uses. A
// *warp.Store satisfies it. The UI never writes: it has no way to commit,
// store objects or move refs (DRAW-8); all writes go through loom.
type History interface {
	Resolve(ctx context.Context, ref string) (warp.ID, bool, error)
	Log(ctx context.Context, from warp.ID, limit int) ([]warp.CommitInfo, error)
	Tree(ctx context.Context, id warp.ID) ([]warp.Entry, error)
	Blob(ctx context.Context, id warp.ID) ([]byte, error)
	Blobs(ctx context.Context, ids []warp.ID) ([][]byte, error)
	Parents(ctx context.Context, commit warp.ID) (tree warp.ID, parents []warp.ID, err error)
	FindByTrailer(ctx context.Context, from warp.ID, key, value string) (warp.ID, bool, error)
	Diff(ctx context.Context, a, b warp.ID) ([]byte, error)
	DiffBlobs(ctx context.Context, a, b warp.ID) ([]byte, error)
	Files(ctx context.Context, tree warp.ID) ([]warp.File, error)
	BlobSize(ctx context.Context, id warp.ID) (int64, error)
	Refs(ctx context.Context, prefix string) ([]warp.RefInfo, error)
}

// Library is the read-only part of a treadle library that the UI uses. A
// *treadle.Library satisfies it. Like History, it can't write: skills
// change only through loom's skills workflow on a worker (DRAW-8).
type Library interface {
	Skills(ctx context.Context) ([]treadle.Skill, []error, error)
	Pending(ctx context.Context) ([]treadle.Skill, []error, error)
	Versions(ctx context.Context, name string) ([]treadle.Skill, error)
	Folder(ctx context.Context, name string, version warp.ID) (treadle.Skill, []warp.File, []byte, error)
	Review(ctx context.Context, name string) (treadle.Review, error)
	AddTo(ctx context.Context, reg *registry.Registry) ([]error, error)
}

// Server serves the UI and its API.
type Server struct {
	Store      History            // read-only; see History
	Ref        string             // the default ref: runs are recorded on it unless a request names another
	Registry   *registry.Registry // commands programs may use
	Temporal   Temporal
	TemporalUI string            // base URL of Temporal's Web UI, for links
	Namespace  string            // Temporal namespace, for links
	Examples   map[string]string // name -> program, offered in the editor
	// Skills, if set, are the skills the Skills page shows: the store's
	// own, read only. Changes go to a worker (Temporal.ChangeSkills).
	Skills Library
	// Commands, if set with Skills, makes a fresh registry of the commands
	// that aren't skills; each compile adds the store's newest skills to
	// it, so a skill added or approved is usable at once. Without it,
	// Registry is used as it is.
	Commands func() *registry.Registry
	// Hosts are the Host header values the server answers to, besides
	// localhost and loopback addresses. Requests for any other host are
	// refused, which defeats DNS rebinding.
	Hosts []string
	// Connectors, if set, reads the worker's connectors as they are now
	// (its connectors file, ConnectorsFile), for the Connectors page.
	Connectors     func() (pirn.Connectors, error)
	ConnectorsFile string
	// Secrets, if set, is the keychain the Connectors page keeps keys in.
	Secrets Secrets
	// StepKeys, if set, is the vault steps read keys through (Secrets
	// if not), and Agents whether the worker has an agent image: the
	// front door's ready check reads them as a run would.
	StepKeys pirn.Vault
	Agents   bool
	Browsers bool // has a browser image for browse steps
	// BrowserAgents: has a browser-agent image for act steps (roadmap 9.5).
	BrowserAgents bool
	// MCPRegistry is the MCP Registry the page adds connectors from
	// (DefaultMCPRegistry if empty); RegistryClient, if set, reaches it.
	MCPRegistry    string
	RegistryClient *http.Client
	// OAuthClient, if set, reaches MCP and authorization servers when a
	// connector is added by signing in.
	OAuthClient *http.Client

	programs sync.Map // tree ID -> program text; trees never change

	connectorsMu sync.Mutex // one change to the connectors file at a time
	signInsMu    sync.Mutex
	signIns      map[string]signIn // sign-ins waiting, by state

	mu          sync.Mutex
	commands    *registry.Registry // Commands with the skills, as of commandsKey
	commandsKey string             // the skills' refs and heads it was built at
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
	mux.HandleFunc("GET /api/blobdiff/{from}/{to}", s.blobDiff)
	mux.HandleFunc("GET /api/refs", s.refs)
	mux.HandleFunc("GET /api/beliefs", s.beliefs)
	mux.HandleFunc("GET /api/live/{workflow}", s.live)
	mux.HandleFunc("GET /api/steps/{workflow}/{run}", s.steps)
	mux.HandleFunc("GET /api/skills", s.skills)
	mux.HandleFunc("GET /api/skills/{name}", s.skill)
	mux.HandleFunc("GET /api/skills/{name}/{version}", s.skillVersion)
	mux.HandleFunc("GET /api/skills/{name}/review", s.skillReview)
	mux.HandleFunc("GET /api/writes/{workflow...}", s.writes)
	mux.HandleFunc("POST /api/writes/{workflow...}", s.decideWrite)
	mux.HandleFunc("POST /api/forms/{workflow...}", s.decideForm)
	mux.HandleFunc("POST /api/write", s.writeProgram)
	mux.HandleFunc("POST /api/ask", s.ask)
	mux.HandleFunc("POST /api/ready", s.ready)
	mux.HandleFunc("POST /api/skills/create", s.createSkill)
	mux.HandleFunc("POST /api/skills/import", s.importSkill)
	mux.HandleFunc("POST /api/skills/catalog", s.catalog)
	mux.HandleFunc("POST /api/skills/add", s.addSkill)
	mux.HandleFunc("POST /api/skills/{name}/approve", s.approveSkill)
	mux.HandleFunc("POST /api/skills/{name}/reject", s.rejectSkill)
	mux.HandleFunc("GET /api/schedules", s.schedules)
	mux.HandleFunc("POST /api/schedules", s.createSchedule)
	mux.HandleFunc("POST /api/schedules/{name}/{action}", s.scheduleAction)
	mux.HandleFunc("GET /api/connectors", s.connectors)
	mux.HandleFunc("POST /api/secrets", s.setSecret)
	mux.HandleFunc("POST /api/secrets/delete", s.setSecret)
	mux.HandleFunc("GET /api/profile", s.profile)
	mux.HandleFunc("POST /api/profile", s.setProfile)
	mux.HandleFunc("POST /api/profile/delete", s.setProfile)
	mux.HandleFunc("POST /api/connectors/catalog", s.connectorCatalog)
	mux.HandleFunc("POST /api/connectors/add", s.addConnector)
	mux.HandleFunc("POST /api/connectors/remove", s.addConnector)
	mux.HandleFunc("POST /api/connectors/connect", s.connectConnector)
	mux.HandleFunc("GET /oauth/callback", s.oauthCallback)
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
// and loads no plugins. Inline styles are allowed for the page's own
// style sheet, in index.html.
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

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	reg, err := s.registry(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	// Skills are the commands treadle added; every other command is built
	// in, and says what it does in a line as loom's program writer tells
	// Claude (loom.BuiltinCommands). A skill's own description is on
	// /api/skills.
	skills, about := []string{}, map[string]string{}
	for _, name := range reg.Names() {
		spec, _ := reg.Lookup(name)
		if spec.AgentID == treadle.ActivityName {
			skills = append(skills, name)
		} else if c, ok := loom.BuiltinCommands[name]; ok {
			about[name] = c.About
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ref": s.Ref, "temporalUI": s.TemporalUI, "namespace": s.namespace(),
		"commands": reg.Names(), "skills": skills, "about": about, "examples": s.Examples,
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
	Ref     string `json:"ref,omitempty"` // submit only; default Server.Ref
	// ActHosts (submit only) are the hosts the page showed, in red, that
	// the program's act steps may act on: a run with act steps starts only
	// if they are exactly loom.ActHosts of its plan (review 39).
	ActHosts []string `json:"actHosts,omitempty"`
	// ActSendsFreely (submit only) are the hosts the page showed, in red,
	// whose act steps send forms without asking (loom.ActSendsFreely;
	// roadmap 9.7).
	ActSendsFreely []string `json:"actSendsFreely,omitempty"`
	// ActUses (submit only) are the person's details the page showed the
	// program's act steps may use (loom.ActUses; roadmap 9.8).
	ActUses []string `json:"actUses,omitempty"`
}

// actShown says whether the person was shown where p's act steps may
// act (loom.ActHosts, exactly) and where they send forms without asking
// (loom.ActSendsFreely, exactly), answering 422 with both if not: every
// way to run or schedule a program goes through it, not only the front
// door's card (review 39, roadmap 9.7).
func actShown(w http.ResponseWriter, p plan.Plan, shown, shownFreely, shownUses []string) bool {
	hosts, freely, uses := loom.ActHosts(p), loom.ActSendsFreely(p), loom.ActUses(p)
	if slices.Equal(hosts, shown) && slices.Equal(freely, shownFreely) && slices.Equal(uses, shownUses) || len(hosts) == 0 && len(freely) == 0 && len(uses) == 0 {
		return true
	}
	msg := "This program's act steps can click and type on " + strings.Join(hosts, ", ") + ", and stop before sending and ask you."
	if len(freely) > 0 {
		msg = "This program's act steps can click, type and submit forms on " + strings.Join(freely, ", ") + " without asking again."
	}
	if len(uses) > 0 {
		msg += " They may use your " + strings.Join(uses, ", ") + "."
	}
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":    msg + " Run it where the page says so.",
		"actHosts": hosts, "actSendsFreely": freely, "actUses": uses,
	})
	return false
}

// RefPrefix is where the refs the UI offers live: loom's default ref and
// branches made next to it.
const RefPrefix = "refs/loom/"

// ref is the ref a request is about: its "ref" query parameter, or the
// server's default. It must be a valid ref under RefPrefix.
func (s *Server) ref(ctx context.Context, name string) (string, error) {
	if name == "" {
		return s.Ref, nil
	}
	if !strings.HasPrefix(name, RefPrefix) && name != s.Ref {
		return "", fmt.Errorf("%w: ref %q isn't under %s", warp.ErrInvalid, name, RefPrefix)
	}
	if err := warp.CheckRef(ctx, name); err != nil {
		return "", err
	}
	return name, nil
}

// badRef replies 400 for an unusable ref and reports whether it did.
func badRef(w http.ResponseWriter, err error) bool {
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
	return err != nil
}

// apiError is an error reply; Line and Col are set for syntax errors.
type apiError struct {
	Error string `json:"error"`
	Line  int    `json:"line,omitempty"`
	Col   int    `json:"col,omitempty"`
}

// registry is the commands a program may use now: Registry, or, with
// Commands and Skills set, the commands with the store's newest skills.
// It is rebuilt only when a skill's ref has moved (one git process to
// tell), so compiling doesn't cost a read of every skill (review 18).
func (s *Server) registry(ctx context.Context) (*registry.Registry, error) {
	if s.Commands == nil || s.Skills == nil {
		return s.Registry, nil
	}
	refs, err := s.Store.Refs(ctx, treadle.RefPrefix)
	if err != nil {
		return nil, err
	}
	var key strings.Builder
	for _, r := range refs {
		fmt.Fprintf(&key, "%s %s\n", r.Name, r.Commit)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.commands != nil && s.commandsKey == key.String() {
		return s.commands, nil
	}
	reg := s.Commands()
	if _, err := s.Skills.AddTo(ctx, reg); err != nil {
		return nil, err
	}
	s.commands, s.commandsKey = reg, key.String()
	return reg, nil
}

func (s *Server) compileProgram(ctx context.Context, src string) (plan.Plan, *apiError) {
	p, _, ce := s.compileWith(ctx, src)
	return p, ce
}

// compileWith is compileProgram, also giving the registry it compiled
// with, so the composition can be had without listing refs again.
func (s *Server) compileWith(ctx context.Context, src string) (plan.Plan, *registry.Registry, *apiError) {
	reg, err := s.registry(ctx)
	if err != nil {
		return plan.Plan{}, nil, &apiError{Error: err.Error()}
	}
	p, err := draft.Compile(ctx, reg, draft.Source(src))
	if err == nil {
		return p, reg, nil
	}
	ce := &apiError{Error: err.Error()}
	var se sexpr.SyntaxError
	if errors.As(err, &se) {
		ce.Line, ce.Col = se.Pos.Line, se.Pos.Col
	}
	return plan.Plan{}, nil, ce
}

func (s *Server) compile(w http.ResponseWriter, r *http.Request) {
	var req programRequest
	if !readJSON(w, r, &req) {
		return
	}
	// A program with errors is a successful check: report it with 200.
	p, reg, ce := s.compileWith(r.Context(), req.Program)
	if ce != nil {
		writeJSON(w, http.StatusOK, ce)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p, "shape": shapeWith(r.Context(), reg, req.Program, p), "actHosts": loom.ActHosts(p), "actSendsFreely": loom.ActSendsFreely(p), "actUses": loom.ActUses(p)})
}

// shapeOf is a program's composition (draft.Composition), for drawing its
// plan as it was written, or nil when it can't be had (a program the
// commands no longer resolve, such as one using a removed skill) or
// doesn't match plan exactly: the page then draws the plan from its
// requires alone.
func (s *Server) shapeOf(ctx context.Context, src string, p plan.Plan) *draft.Shape {
	reg, err := s.registry(ctx)
	if err != nil {
		return nil
	}
	return shapeWith(ctx, reg, src, p)
}

// shapeWith is shapeOf with the registry already in hand.
func shapeWith(ctx context.Context, reg *registry.Registry, src string, p plan.Plan) *draft.Shape {
	sh, err := draft.Composition(ctx, reg, draft.Source(src))
	if err != nil || !shapeMatches(sh, p) {
		return nil
	}
	return &sh
}

// shapeMatches reports whether a shape names exactly p's nodes, in order,
// and implies exactly what each requires.
func shapeMatches(sh draft.Shape, p plan.Plan) bool {
	waits := map[plan.NodeID][]plan.NodeID{}
	var walk func(draft.Shape) (steps, entries, exits []plan.NodeID, ok bool)
	walk = func(s draft.Shape) (steps, entries, exits []plan.NodeID, ok bool) {
		switch s.Kind {
		case "step":
			return []plan.NodeID{s.Node}, []plan.NodeID{s.Node}, []plan.NodeID{s.Node}, true
		case "pipe", "par":
			var prev []plan.NodeID
			for i, part := range s.Parts {
				st, en, ex, ok := walk(part)
				if !ok {
					return nil, nil, nil, false
				}
				steps = append(steps, st...)
				if s.Kind == "par" {
					entries, exits = append(entries, en...), append(exits, ex...)
					continue
				}
				if i == 0 {
					entries = en
				} else {
					for _, e := range en {
						waits[e] = append(waits[e], prev...)
					}
				}
				prev, exits = ex, ex
			}
			// draft never makes a group of fewer than two parts; the page
			// refuses one too (lib.js asShape).
			return steps, entries, exits, len(s.Parts) > 1
		}
		return nil, nil, nil, false
	}
	steps, _, _, ok := walk(sh)
	if !ok || len(steps) != len(p.Nodes) {
		return false
	}
	for i, n := range p.Nodes {
		if steps[i] != n.ID || !sameIDs(waits[n.ID], n.Requires) {
			return false
		}
	}
	return true
}

func sameIDs(a, b []plan.NodeID) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[plan.NodeID]int{}
	for _, x := range a {
		seen[x]++
	}
	for _, x := range b {
		if seen[x]--; seen[x] < 0 {
			return false
		}
	}
	return true
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
	if !actShown(w, p, req.ActHosts, req.ActSendsFreely, req.ActUses) {
		return
	}
	ref, err := s.ref(r.Context(), req.Ref)
	if badRef(w, err) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	wf, run, err := s.Temporal.Submit(ctx, loom.RunInput{Program: req.Program, Plan: p, Ref: ref})
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
	// Merge rows: the commit merged in, the first parent, and how many
	// conflicting questions were resolved.
	Merged   warp.ID `json:"merged,omitempty"`
	Parent   warp.ID `json:"parent,omitempty"`
	Resolved int     `json:"resolved,omitempty"`
}

func trailer(c warp.CommitInfo, key string) string {
	for _, t := range c.Trailers {
		if t.Key == key {
			return t.Value
		}
	}
	return ""
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ref, err := s.ref(ctx, r.URL.Query().Get("ref"))
	if badRef(w, err) {
		return
	}
	var recs []warp.CommitInfo
	head, ok, err := s.Store.Resolve(ctx, ref)
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
		// Executions for other refs belong to those refs' lists. One
		// without a ref memo is shown on the default ref.
		if e.Ref != ref && !(e.Ref == "" && ref == s.Ref) {
			continue
		}
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
		if merged := trailer(c, loom.TrailerMerge); merged != "" && len(c.Parents) == 2 {
			n := 0
			for _, t := range c.Trailers {
				if t.Key == loom.TrailerResolve {
					n++
				}
			}
			rows = append(rows, runRow{
				Execution: Execution{WorkflowID: trailer(c, loom.TrailerWorkflow), RunID: trailer(c, loom.TrailerRun), Status: "Merged", Start: c.Time},
				Commit:    c.ID, Merged: warp.ID(merged), Parent: c.Parents[0], Resolved: n,
			})
			continue
		}
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
	// Files are the files each step left (files/<node>/), compared with
	// Previous's; MoreFiles says some weren't listed (MaxFiles).
	Files     map[string][]stepFile `json:"files"`
	MoreFiles bool                  `json:"moreFiles,omitempty"`
	// Writes are the run's queued writes and what came of each.
	Writes []loom.WriteOutcome `json:"writes,omitempty"`
	// Shape is the program's composition, if it can be had (shapeOf).
	Shape *draft.Shape `json:"shape,omitempty"`
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

	ref, err := s.ref(ctx, r.URL.Query().Get("ref"))
	if badRef(w, err) {
		return
	}
	rec, found, err := s.findRecord(ctx, ref, wf, run)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	if found {
		rec.Shape = s.shapeOf(ctx, rec.Program, rec.Plan)
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
func (s *Server) findRecord(ctx context.Context, ref, wf, run string) (record, bool, error) {
	head, ok, err := s.Store.Resolve(ctx, ref)
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
		// The previous run of the same program: by its program ID, which a
		// scheduled run shares though its workflow ID has the time added,
		// or, for records from before that trailer, by workflow ID; the
		// nearer of the two (review 30).
		byWF, okW, _ := s.Store.FindByTrailer(ctx, parents[0], loom.TrailerWorkflow, wf)
		var byProg warp.ID
		okP := false
		if id, err := loom.WorkflowID(ctx, loom.RunInput{Program: rec.Program, Plan: rec.Plan, Ref: ref}); err == nil {
			byProg, okP, _ = s.Store.FindByTrailer(ctx, parents[0], loom.TrailerProgram, id)
		}
		switch {
		case okW && okP && byWF != byProg:
			// byWF is the nearer unless it's an ancestor of byProg.
			if older, ok, _ := s.Store.FindByTrailer(ctx, byProg, loom.TrailerWorkflow, wf); ok && older == byWF {
				rec.Previous = byProg
			} else {
				rec.Previous = byWF
			}
		case okW:
			rec.Previous = byWF
		case okP:
			rec.Previous = byProg
		}
	}
	if rec.Files, rec.MoreFiles, err = s.stepFiles(ctx, tree, rec.Previous); err != nil {
		return record{}, false, err
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
	if id, ok := s.entry(ctx, tree, loom.WritesFile); ok {
		if n, err := s.Store.BlobSize(ctx, id); err != nil || n > MaxDiffBlob*2 {
			return rec, fmt.Errorf("%s: too large or unreadable", loom.WritesFile)
		}
		b, err := s.Store.Blob(ctx, id)
		if err != nil {
			return rec, err
		}
		if err := json.Unmarshal(b, &rec.Writes); err != nil {
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

// refs lists the refs the UI offers: every ref under RefPrefix, and the
// default ref even before it exists.
func (s *Server) refs(w http.ResponseWriter, r *http.Request) {
	refs, err := s.Store.Refs(r.Context(), RefPrefix)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	names := []string{}
	heads := map[string]warp.ID{}
	hasDefault := false
	for _, ref := range refs {
		names = append(names, ref.Name)
		heads[ref.Name] = ref.Commit
		hasDefault = hasDefault || ref.Name == s.Ref
	}
	if !hasDefault {
		names = append([]string{s.Ref}, names...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"refs": names, "default": s.Ref, "heads": heads})
}

// beliefs returns a ref's beliefs index: the latest run of every question
// asked on its history (loom.Beliefs).
func (s *Server) beliefs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ref, err := s.ref(ctx, r.URL.Query().Get("ref"))
	if badRef(w, err) {
		return
	}
	head, ok, err := s.Store.Resolve(ctx, ref)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	bs := []loom.Belief{}
	if ok {
		if bs, err = loom.Beliefs(ctx, s.Store, head); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
			return
		}
		if bs == nil {
			bs = []loom.Belief{}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ref": ref, "beliefs": bs})
}

// live returns the live frames of a run's browsing steps, from Temporal.
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	frames, err := s.Temporal.Live(ctx, r.PathValue("workflow"))
	if frames == nil {
		frames = []LiveFrame{}
	}
	resp := map[string]any{"frames": frames}
	if err != nil {
		resp["temporalError"] = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// readJSON accepts only an application/json body holding exactly one JSON
// value with known fields, up to 1 MB. Requiring the content type means a
// plain HTML form on another site can't post to the API.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return readJSONUpTo(w, r, v, 1<<20)
}

// readJSONUpTo is readJSON with a body of at most limit bytes.
func readJSONUpTo(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, apiError{Error: "Content-Type must be application/json"})
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
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

// steps returns a run's steps from Temporal's history, for the timeline.
// Temporal being unreachable is reported, not an error: the run's record
// is still there.
func (s *Server) steps(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	steps, err := s.Temporal.Steps(ctx, r.PathValue("workflow"), r.PathValue("run"))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"steps": []Step{}, "temporalError": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": steps})
}
