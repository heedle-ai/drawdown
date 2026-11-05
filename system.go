package drawdown

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"go.temporal.io/sdk/client"

	"github.com/heedle-ai/bobbin"
	"github.com/heedle-ai/loom"
)

// System is what the System page sees and does (roadmap 9.2): heedle's
// containers with their runs, its images, Podman's machine, stopping a run
// through Temporal and removing old images. PodmanSystem is the real one.
type System interface {
	Containers(ctx context.Context) ([]loom.Container, error)
	Images(ctx context.Context) ([]bobbin.Image, error)
	// Machine is Podman's virtual machine, on macOS; nil elsewhere.
	Machine(ctx context.Context) (*bobbin.Machine, error)
	// Cancel stops a run through Temporal (loom.Cancel): exactly the run
	// runID of workflowID, never a later one, returning its run ID.
	Cancel(ctx context.Context, workflowID, runID string) (string, error)
	// Prune removes heedle's images that aren't kept and that no
	// container uses, returning the names removed.
	Prune(ctx context.Context) ([]string, error)
	// Keep is the images Prune never removes; empty when Prune would
	// refuse, not knowing the release's.
	Keep() []string
}

// PodmanSystem is System on this machine: Podman, through bobbin, and
// Temporal, through loom.
type PodmanSystem struct {
	Temporal client.Client
	// Pins are the release's images (heedle up passes them, -keep-images),
	// and Kept the worker's own: neither is ever removed. Without Pins,
	// nothing is: the worker's images alone don't say which of heedle's
	// images the release still needs (DRAW-507).
	Pins, Kept []string
	// Mac is whether Podman runs in a virtual machine (macOS).
	Mac bool
	// Homes is the folder where each running heedle home says it runs
	// (heedle up gives it, -homes), and Home this worker's home label
	// (bobbin.HomeOf its store). While another home is named there, its
	// images aren't known here, so Prune refuses (roadmap 9.2.1, review
	// 55): heedle images -prune keeps every running home's.
	Homes, Home string
}

// ErrOtherHomes is a prune refused because another heedle home runs.
var ErrOtherHomes = errors.New("another heedle home is running, and this page doesn't know which images it keeps: remove old images with heedle images -prune, which keeps every running home's")

// otherHome is another home Homes names, if any.
func (p PodmanSystem) otherHome() (string, bool) {
	if p.Homes == "" {
		return "", false
	}
	es, err := os.ReadDir(p.Homes)
	if err != nil {
		return "", !errors.Is(err, os.ErrNotExist) // can't tell: assume one
	}
	for _, e := range es {
		if e.Name() != p.Home && bobbin.ValidHome(e.Name()) {
			b, _ := os.ReadFile(filepath.Join(p.Homes, e.Name()))
			return strings.TrimSpace(string(b)), true
		}
	}
	return "", false
}

func (p PodmanSystem) Containers(ctx context.Context) ([]loom.Container, error) {
	return loom.Containers(ctx, p.Temporal, bobbin.Runner{})
}

func (p PodmanSystem) Images(ctx context.Context) ([]bobbin.Image, error) {
	return bobbin.Runner{}.Images(ctx, bobbin.HeedleRepo, p.keep())
}

// keep is every image never removed: the release's and the worker's.
func (p PodmanSystem) keep() []string { return append(append([]string{}, p.Pins...), p.Kept...) }

func (p PodmanSystem) Machine(ctx context.Context) (*bobbin.Machine, error) {
	if !p.Mac {
		return nil, nil
	}
	return bobbin.Runner{}.Machine(ctx)
}

func (p PodmanSystem) Cancel(ctx context.Context, workflowID, runID string) (string, error) {
	return loom.Cancel(ctx, p.Temporal, workflowID, runID)
}

// ErrNoPins is a prune refused because the server doesn't know the
// release's images.
var ErrNoPins = errors.New("old images can be removed only when the worker knows which images its release pins (heedle up tells it, with -keep-images)")

func (p PodmanSystem) Prune(ctx context.Context) ([]string, error) {
	if len(p.Pins) == 0 {
		return nil, ErrNoPins
	}
	if home, ok := p.otherHome(); ok {
		return nil, fmt.Errorf("%w (%s)", ErrOtherHomes, home)
	}
	return bobbin.Runner{}.PruneImages(ctx, bobbin.HeedleRepo, p.keep())
}

func (p PodmanSystem) Keep() []string {
	if len(p.Pins) == 0 {
		return nil
	}
	return p.keep()
}

// What browser agents need of Podman's machine: reed gives each browser 1
// GB, an agent's workspace takes 512 MB, and Podman and the machine need
// their own.
const (
	MinMachineMemory = 4 << 30
	MinMachineCPUs   = 2
)

// machineNotes say what about the machine falls short of what browser
// agents need, and how to change it.
func machineNotes(m *bobbin.Machine) []string {
	if m == nil {
		return []string{}
	}
	notes := []string{}
	if !m.Running {
		notes = append(notes, fmt.Sprintf("Podman's machine %s isn't running: start it with podman machine start (heedle up does).", m.Name))
	}
	if m.Memory > 0 && m.Memory < MinMachineMemory {
		notes = append(notes, fmt.Sprintf("Podman's machine has %.1f GiB of memory; browser agents need at least 4 GiB. Give it more with: podman machine stop; podman machine set --memory 4096; podman machine start", float64(m.Memory)/(1<<30)))
	}
	if m.CPUs > 0 && m.CPUs < MinMachineCPUs {
		notes = append(notes, fmt.Sprintf("Podman's machine has %d CPU; browser agents need at least 2. Give it more with: podman machine stop; podman machine set --cpus 2; podman machine start", m.CPUs))
	}
	return notes
}

// systemView is GET /api/system's answer. A part Podman or Temporal
// couldn't give is left empty, with why in Errors.
type systemView struct {
	Containers []loom.Container  `json:"containers"`
	Images     []bobbin.Image    `json:"images"`
	Keep       []string          `json:"keep"`
	Machine    *bobbin.Machine   `json:"machine"`
	Notes      []string          `json:"notes"`
	Errors     map[string]string `json:"errors"`
}

// onlyHere answers 403 unless r came straight from this machine, as keys
// are set (fromThisMachine), and says so; it reports whether r may go on.
func (s *Server) onlyHere(w http.ResponseWriter, r *http.Request) bool {
	if !fromThisMachine(r, s.Hosts) {
		writeJSON(w, http.StatusForbidden, apiError{Error: "the System page works only on the machine heedle runs on, at localhost, not through a proxy"})
		return false
	}
	if s.System == nil {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server doesn't see its machine's containers"})
		return false
	}
	return true
}

func (s *Server) system(w http.ResponseWriter, r *http.Request) {
	if !s.onlyHere(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	v := systemView{Containers: []loom.Container{}, Images: []bobbin.Image{}, Keep: s.System.Keep(), Notes: []string{}, Errors: map[string]string{}}
	if v.Keep == nil {
		v.Keep = []string{}
	}
	if cs, err := s.System.Containers(ctx); err != nil {
		v.Errors["containers"] = err.Error()
	} else if cs != nil {
		v.Containers = cs
	}
	if ims, err := s.System.Images(ctx); err != nil {
		v.Errors["images"] = err.Error()
	} else if ims != nil {
		v.Images = ims
	}
	m, err := s.System.Machine(ctx)
	if err != nil {
		v.Errors["machine"] = err.Error()
	}
	v.Machine, v.Notes = m, machineNotes(m)
	writeJSON(w, http.StatusOK, v)
}

// stopRequest names the run to stop: its workflow ID and run ID. The run
// ID is needed, so a page showing an old run never stops a newer run of
// the same workflow ID (DRAW-506).
type stopRequest struct {
	Workflow string `json:"workflow"`
	Run      string `json:"run"`
}

// systemStop stops a run through Temporal (loom.Cancel): never anything
// but a run, and never by touching a container.
func (s *Server) systemStop(w http.ResponseWriter, r *http.Request) {
	if !s.onlyHere(w, r) {
		return
	}
	var req stopRequest
	if !readJSONUpTo(w, r, &req, 4<<10) {
		return
	}
	bad := func(id string) bool {
		return id == "" || len(id) > 1000 || strings.IndexFunc(id, func(c rune) bool { return !unicode.IsPrint(c) || c == ' ' }) >= 0
	}
	if bad(req.Workflow) || bad(req.Run) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "name the run to stop by its workflow ID and run ID"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	run, err := s.System.Cancel(ctx, req.Workflow, req.Run)
	switch {
	case errors.Is(err, loom.ErrNotARun):
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	case err != nil && run != "":
		writeJSON(w, http.StatusConflict, apiError{Error: err.Error()}) // it has already ended
	case err != nil:
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
	default:
		writeJSON(w, http.StatusOK, map[string]string{"workflow": req.Workflow, "run": run})
	}
}

// systemPrune removes heedle's old images (bobbin.PruneImages, keeping
// System.Keep).
func (s *Server) systemPrune(w http.ResponseWriter, r *http.Request) {
	if !s.onlyHere(w, r) {
		return
	}
	var req struct{}
	if !readJSONUpTo(w, r, &req, 1<<10) {
		return
	}
	removed, err := s.System.Prune(r.Context())
	if removed == nil {
		removed = []string{}
	}
	if errors.Is(err, ErrNoPins) || errors.Is(err, ErrOtherHomes) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "removed": removed})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "removed": removed})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}
