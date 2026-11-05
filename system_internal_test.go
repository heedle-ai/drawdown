package drawdown

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/bobbin"
	"github.com/heedle-ai/loom"
)

// fakeSystem records what it was asked to do.
type fakeSystem struct {
	asked     []string
	cancelErr error
	cancelRun string
	machine   *bobbin.Machine
	podmanErr error
}

func (f *fakeSystem) Containers(context.Context) ([]loom.Container, error) {
	f.asked = append(f.asked, "containers")
	if f.podmanErr != nil {
		return nil, f.podmanErr
	}
	return []loom.Container{{Container: bobbin.Container{ID: strings.Repeat("a", 64), Name: "bobbin-session-1", Image: "ghcr.io/heedle-ai/pirn-agent@sha256:x",
		Labels: bobbin.Labels{Kind: "agent", Workflow: "loom-a/plan", Run: "p1", Step: "n2"}, Created: time.Unix(1793876600, 0).UTC(), State: "running", CPU: "12.5%", Memory: "90MB / 512MB"},
		Workflow: "loom-a", Run: "r1", Status: "running"}}, nil
}

func (f *fakeSystem) Images(context.Context) ([]bobbin.Image, error) {
	f.asked = append(f.asked, "images")
	if f.podmanErr != nil {
		return nil, f.podmanErr
	}
	return []bobbin.Image{{ID: "1", Names: []string{"ghcr.io/heedle-ai/pirn-agent@sha256:new"}, Size: 300e6, Pinned: true}}, nil
}

func (f *fakeSystem) Machine(context.Context) (*bobbin.Machine, error) {
	f.asked = append(f.asked, "machine")
	return f.machine, nil
}

func (f *fakeSystem) Cancel(_ context.Context, wf, run string) (string, error) {
	f.asked = append(f.asked, "cancel "+wf+" "+run)
	return f.cancelRun, f.cancelErr
}

func (f *fakeSystem) Prune(context.Context) ([]string, error) {
	f.asked = append(f.asked, "prune")
	return []string{"ghcr.io/heedle-ai/pirn-agent@sha256:old"}, nil
}

func (f *fakeSystem) Keep() []string { return []string{"ghcr.io/heedle-ai/pirn-agent@sha256:new"} }

func systemCall(h http.Handler, method, path, body, remote string, header ...string) (int, map[string]any) {
	r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, strings.NewReader(body))
	r.RemoteAddr = remote
	if method == "POST" {
		r.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var m map[string]any
	json.Unmarshal(w.Body.Bytes(), &m)
	return w.Code, m
}

const here = "127.0.0.1:50000"

// TestInv_SystemActsOnlyFromThisMachine: the System API, reading or
// acting, answers only a request straight from this machine (a loopback
// address, no proxy's forwarding headers, a server answering no other
// host name), as keys are set; anything else is 403 before the system is
// asked anything (DRAW-500).
func TestInv_SystemActsOnlyFromThisMachine(t *testing.T) {
	for _, c := range []struct {
		method, path, body string
	}{{"GET", "/api/system", ""}, {"POST", "/api/system/stop", `{"workflow":"loom-a","run":"r1"}`}, {"POST", "/api/system/prune", `{}`}} {
		f := &fakeSystem{cancelRun: "r1"}
		h := (&Server{System: f}).Handler()
		for _, away := range []struct {
			remote string
			header []string
		}{{"192.168.1.20:4000", nil}, {"10.0.0.2:1", nil}, {here, []string{"X-Forwarded-For", "203.0.113.9"}}, {here, []string{"Forwarded", "for=203.0.113.9"}}} {
			if code, _ := systemCall(h, c.method, c.path, c.body, away.remote, away.header...); code != http.StatusForbidden {
				t.Errorf("%s %s from %s %v: %d, want 403", c.method, c.path, away.remote, away.header, code)
			}
		}
		hosts := (&Server{System: f, Hosts: []string{"heedle.lan"}}).Handler()
		if code, _ := systemCall(hosts, c.method, c.path, c.body, here); code != http.StatusForbidden {
			t.Errorf("%s %s to a server with -hosts: %d", c.method, c.path, code)
		}
		if len(f.asked) != 0 {
			t.Errorf("%s %s refused, but the system was asked %q", c.method, c.path, f.asked)
		}
		if code, _ := systemCall(h, c.method, c.path, c.body, "[::1]:4000"); code != http.StatusOK {
			t.Errorf("%s %s from this machine: %d", c.method, c.path, code)
		}
		if code, _ := systemCall((&Server{}).Handler(), c.method, c.path, c.body, here); code != http.StatusNotImplemented {
			t.Errorf("%s %s with no system: %d", c.method, c.path, code)
		}
	}
}

// TestInv_SystemShowsWhatItSees: GET /api/system shows heedle's
// containers with their runs, its images and what's kept, and on a Mac the
// machine with a note for each thing browser agents lack; what Podman
// couldn't say is said, not hidden (DRAW-501).
func TestInv_SystemShowsWhatItSees(t *testing.T) {
	f := &fakeSystem{machine: &bobbin.Machine{Name: "podman-machine-default", Running: true, CPUs: 1, Memory: 2 << 30, Disk: 100 << 30}}
	code, m := systemCall((&Server{System: f}).Handler(), "GET", "/api/system", "", here)
	if code != 200 {
		t.Fatal(code, m)
	}
	c := m["containers"].([]any)[0].(map[string]any)
	if c["workflow"] != "loom-a" || c["run"] != "r1" || c["status"] != "running" || c["labels"].(map[string]any)["step"] != "n2" || c["cpu"] != "12.5%" {
		t.Errorf("container %v", c)
	}
	if im := m["images"].([]any)[0].(map[string]any); im["pinned"] != true || m["keep"].([]any)[0] != "ghcr.io/heedle-ai/pirn-agent@sha256:new" {
		t.Errorf("images %v, keep %v", m["images"], m["keep"])
	}
	notes := fmt.Sprint(m["notes"])
	if m["machine"].(map[string]any)["cpus"] != float64(1) || !strings.Contains(notes, "at least 4 GiB") || !strings.Contains(notes, "podman machine set --memory 4096") || !strings.Contains(notes, "at least 2") {
		t.Errorf("machine %v, notes %v", m["machine"], notes)
	}
	// A machine that has what browser agents need gets no note; Linux has
	// no machine, and no notes.
	if n := machineNotes(&bobbin.Machine{Name: "m", Running: true, CPUs: 4, Memory: 4 << 30}); len(n) != 0 {
		t.Errorf("notes for a big enough machine: %q", n)
	}
	if n := machineNotes(&bobbin.Machine{Name: "m", CPUs: 4, Memory: 8 << 30}); len(n) != 1 || !strings.Contains(n[0], "isn't running") {
		t.Errorf("notes for a stopped machine: %q", n)
	}
	f = &fakeSystem{podmanErr: errors.New("podman ps: podman isn't on the PATH")}
	_, m = systemCall((&Server{System: f}).Handler(), "GET", "/api/system", "", here)
	if errs := m["errors"].(map[string]any); errs["containers"] == nil || errs["images"] == nil || m["machine"] != nil || len(m["containers"].([]any)) != 0 {
		t.Errorf("with podman failing: %v", m)
	}
}

// TestInv_StoppingIsOnlyCancellingARun: POST /api/system/stop asks the
// system to cancel exactly the run named, by workflow ID and run ID,
// through Temporal (loom.Cancel), and nothing else: it never lists or
// removes a container; a name that isn't one, or a missing run ID, is
// refused before it's asked; a workflow that isn't a run is 400, one that
// has ended 409, Temporal failing 502 (DRAW-502, DRAW-506).
func TestInv_StoppingIsOnlyCancellingARun(t *testing.T) {
	f := &fakeSystem{cancelRun: "r1"}
	h := (&Server{System: f}).Handler()
	code, m := systemCall(h, "POST", "/api/system/stop", `{"workflow":"loom-a","run":"r1"}`, here)
	if code != 200 || m["run"] != "r1" || strings.Join(f.asked, ",") != "cancel loom-a r1" {
		t.Errorf("stop: %d %v, asked %q", code, m, f.asked)
	}
	// Review 50: a stop named only the workflow, so a page showing an old
	// run could cancel a newer run of the same workflow ID.
	for _, body := range []string{`{}`, `{"workflow":""}`, `{"workflow":"a b","run":"r"}`, `{"workflow":"a\nb","run":"r"}`, `{"workflow":"` + strings.Repeat("w", 1001) + `","run":"r"}`,
		`{"workflow":"x","run":"r","kill":true}`, `{"workflow":"loom-a"}`, `{"workflow":"loom-a","run":""}`, `{"workflow":"loom-a","run":"r 1"}`} {
		f.asked = nil
		if code, _ := systemCall(h, "POST", "/api/system/stop", body, here); code != http.StatusBadRequest || len(f.asked) != 0 {
			t.Errorf("stop %s: %d, asked %q", body, code, f.asked)
		}
	}
	for _, c := range []struct {
		run  string
		err  error
		code int
	}{{"", fmt.Errorf("%w: merge-x is a LoomMerge workflow", loom.ErrNotARun), 400}, {"r2", errors.New("run loom-b has already ended (completed)"), 409}, {"", errors.New("connection refused"), 502}} {
		f := &fakeSystem{cancelRun: c.run, cancelErr: c.err}
		if code, m := systemCall((&Server{System: f}).Handler(), "POST", "/api/system/stop", `{"workflow":"w","run":"r"}`, here); code != c.code || m["error"] == nil {
			t.Errorf("Cancel %v: %d %v, want %d", c.err, code, m, c.code)
		}
	}
	code, m = systemCall(h, "POST", "/api/system/prune", `{}`, here)
	if code != 200 || fmt.Sprint(m["removed"]) != "[ghcr.io/heedle-ai/pirn-agent@sha256:old]" {
		t.Errorf("prune: %d %v", code, m)
	}
}

// TestInv_EveryStepIsLabelledHere: the UI's worker registers every
// command, and its skills, through loom.Labelled, so every step's
// containers carry its run and step; and the System page keeps the images
// heedle pins and the worker's own (DRAW-505).
func TestInv_EveryStepIsLabelledHere(t *testing.T) {
	src, err := os.ReadFile("app/app.go")
	if err != nil {
		t.Fatal(err)
	}
	cmds := regexp.MustCompile(`\b(?:bobbin|reed|pirn|treadle)\.Register\w*\((?:ctx, )?reg, (\w+)`).FindAllStringSubmatch(string(src), -1)
	if len(cmds) < 6 {
		t.Fatalf("found %d command registrations in app.go", len(cmds))
	}
	for _, m := range cmds {
		if m[1] != "steps" {
			t.Errorf("app.go: %s registers with %s, not steps", m[0], m[1])
		}
	}
	if !strings.Contains(string(src), "steps := loom.Labelled(w)") {
		t.Error("app.go doesn't make steps with loom.Labelled")
	}
	if !strings.Contains(string(src), `Pins: kept(*keepImages), Kept: kept("", *browserImage, *agentImage, *browserAgentImage)`) {
		t.Error("the System page doesn't keep heedle's pins and the worker's images")
	}
}

// TestInv_NoPruneWithoutTheReleasesPins: the System page removes old
// images only when it knows the images the release pins (heedle up gives
// them): without them, the worker's own images aren't enough to keep, so
// a prune is refused (409) before Podman is asked, and the page is told
// nothing is kept (DRAW-507).
func TestInv_NoPruneWithoutTheReleasesPins(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no podman: a prune that got as far as Podman would fail otherwise
	worker := PodmanSystem{Kept: []string{"ghcr.io/heedle-ai/pirn-agent@sha256:mine"}}
	// Review 50: heedle ui, with no pins, could prune the release's images.
	if removed, err := worker.Prune(context.Background()); !errors.Is(err, ErrNoPins) || len(removed) != 0 {
		t.Errorf("Prune with no pins: %v, %v", removed, err)
	}
	if k := worker.Keep(); len(k) != 0 {
		t.Errorf("Keep with no pins: %q", k)
	}
	code, m := systemCall((&Server{System: worker}).Handler(), "POST", "/api/system/prune", `{}`, here)
	if code != http.StatusConflict || !strings.Contains(fmt.Sprint(m["error"]), "pins") {
		t.Errorf("prune with no pins: %d %v", code, m)
	}
	pinned := PodmanSystem{Pins: []string{"ghcr.io/heedle-ai/pirn-agent@sha256:release"}, Kept: worker.Kept}
	if k := pinned.Keep(); strings.Join(k, ",") != "ghcr.io/heedle-ai/pirn-agent@sha256:release,ghcr.io/heedle-ai/pirn-agent@sha256:mine" {
		t.Errorf("Keep with pins: %q", k)
	}
	if _, err := pinned.Prune(context.Background()); errors.Is(err, ErrNoPins) || err == nil {
		t.Errorf("Prune with pins and no podman: %v", err)
	}
}

// TestInv_TheUIsWorkerSaysItsHome: the UI's worker, the only one app.go
// makes, starts every activity from loom.WorkerContext of its store, so
// every container its steps start says this home (DRAW-520, roadmap
// 9.2.1).
func TestInv_TheUIsWorkerSaysItsHome(t *testing.T) {
	src, err := os.ReadFile("app/app.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(src), "worker.New(") != 1 || !strings.Contains(string(src), "worker.New(c, *queue, reed.WorkerOptions(worker.Options{BackgroundActivityContext: loom.WorkerContext(*store)}))") {
		t.Error("app.go's worker doesn't start its activities from loom.WorkerContext(*store)")
	}
}
