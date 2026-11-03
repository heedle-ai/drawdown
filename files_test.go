package drawdown_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/warp"
)

// recordRun records one run of program on the world's store with the
// given n0 output, as loom does.
func (w *world) recordRun(wf, run string, i int, n0 string) {
	w.t.Helper()
	src := `(echo "x")`
	p, err := loom.Compile(context.Background(), draft.DefaultRegistry(), src)
	if err != nil {
		w.t.Fatal(err)
	}
	if _, err := (&loom.Recorder{Store: w.store}).Record(context.Background(), loom.RecordInput{Program: src, Plan: p,
		Result: plan.Result{Outputs: map[string]string{"n0": n0}}, Ref: loom.DefaultRef, WorkflowID: wf, RunID: run,
		At: time.Unix(1700000000+int64(i), 0)}); err != nil {
		w.t.Fatal(err)
	}
}

func filesOutput(files map[string]string) string {
	var fs []map[string]string
	for p, t := range files {
		fs = append(fs, map[string]string{"path": p, "text": t})
	}
	b, _ := json.Marshal(map[string]any{"files": fs})
	return string(b)
}

// TestInv_StepFilesAreComparedWithThePreviousRun: the detail view lists
// each step's recorded files with their sizes, marked added, changed,
// same or deleted against the previous run of the same program, and
// /api/blobdiff shows one file's change.
func TestInv_StepFilesAreComparedWithThePreviousRun(t *testing.T) {
	w := newWorld(t)
	w.recordRun("wf", "r1", 0, filesOutput(map[string]string{"report.txt": "rain\n", "keep.txt": "k", "gone.txt": "bye"}))
	w.recordRun("wf", "r2", 1, filesOutput(map[string]string{"report.txt": "sun!\n", "keep.txt": "k", "dir/new.txt": "hello"}))

	_, first, _ := w.call("GET", "/api/runs/wf/r1", nil)
	if got := fmt.Sprint(first["record"].(map[string]any)["files"]); !strings.Contains(got, "status:added") || strings.Contains(got, "changed") {
		t.Errorf("first run's files: %s", got)
	}
	_, detail, _ := w.call("GET", "/api/runs/wf/r2", nil)
	files := detail["record"].(map[string]any)["files"].(map[string]any)["n0"].([]any)
	got := map[string]map[string]any{}
	var order []string
	for _, f := range files {
		m := f.(map[string]any)
		got[m["path"].(string)] = m
		order = append(order, m["path"].(string))
	}
	want := map[string]string{"dir/new.txt": "added 5", "gone.txt": "deleted 3", "keep.txt": "same 1", "report.txt": "changed 5"}
	for p, sw := range want {
		if f := got[p]; f == nil || fmt.Sprint(f["status"], " ", f["size"]) != sw {
			t.Errorf("%s: %v, want %s", p, f, sw)
		}
	}
	if strings.Join(order, " ") != "dir/new.txt gone.txt keep.txt report.txt" {
		t.Errorf("order %v", order)
	}
	r := got["report.txt"]
	code, _, d := w.call("GET", fmt.Sprintf("/api/blobdiff/%s/%s", r["before"], r["blob"]), nil)
	if code != 200 || !strings.Contains(d, "-rain") || !strings.Contains(d, "+sun!") {
		t.Errorf("blobdiff %d:\n%s", code, d)
	}
	if code, _, _ := w.call("GET", "/api/blobdiff/HEAD/HEAD", nil); code != 400 {
		t.Errorf("blobdiff of revision expressions: %d, want 400", code)
	}
	if code, _, _ := w.call("GET", fmt.Sprintf("/api/blobdiff/%s/%s", detail["record"].(map[string]any)["commit"], r["blob"]), nil); code != 400 {
		t.Errorf("blobdiff of a commit: %d, want 400", code)
	}
}

// TestInv_StepFileListIsBounded: a record holding more than MaxFiles
// files (one not written by loom, which records at most that many) lists
// MaxFiles of them and says there are more.
func TestInv_StepFileListIsBounded(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.recordRun("wf", "r1", 0, "x")
	head, _, _ := w.store.Resolve(ctx, loom.DefaultRef)
	tree, _, _ := w.store.Parents(ctx, head)
	x, _ := w.store.PutBlob(ctx, []byte("x"))
	var fs []warp.Entry
	for i := 0; i < drawdown.MaxFiles+5; i++ {
		fs = append(fs, warp.Entry{Name: fmt.Sprintf("f%04d", i), Kind: warp.KindBlob, ID: x})
	}
	n0, _ := w.store.PutTree(ctx, fs)
	files, _ := w.store.PutTree(ctx, []warp.Entry{{Name: "n0", Kind: warp.KindTree, ID: n0}})
	es, _ := w.store.Tree(ctx, tree)
	big, err := w.store.PutTree(ctx, append(es, warp.Entry{Name: loom.FilesDir, Kind: warp.KindTree, ID: files}))
	if err != nil {
		t.Fatal(err)
	}
	c, err := w.store.Commit(ctx, warp.CommitSpec{Tree: big, Parents: []warp.ID{head}, Message: "run wf",
		Trailers: []warp.Trailer{{Key: loom.TrailerWorkflow, Value: "wf2"}, {Key: loom.TrailerRun, Value: "r2"}},
		Author:   warp.Signature{Name: "t", Email: "t@x", When: time.Unix(1700000001, 0)}})
	if err != nil || w.store.Advance(ctx, loom.DefaultRef, head, c) != nil {
		t.Fatal(err)
	}
	_, detail, _ := w.call("GET", "/api/runs/wf2/r2", nil)
	rec := detail["record"].(map[string]any)
	if n := len(rec["files"].(map[string]any)["n0"].([]any)); n != drawdown.MaxFiles || rec["moreFiles"] != true {
		t.Errorf("%d files listed, more %v", n, rec["moreFiles"])
	}
}

// commitFiles commits a record of workflow wf on the world's ref whose
// files/ tree holds files (node -> path -> contents), built directly with
// warp, as a store not written by loom might hold.
func (w *world) commitFiles(wf, run string, i int, files map[string]map[string]string) {
	w.t.Helper()
	ctx := context.Background()
	w.recordRun(wf+"-base", run+"-base", i, "x")
	head, _, _ := w.store.Resolve(ctx, loom.DefaultRef)
	tree, _, _ := w.store.Parents(ctx, head)
	var nodes []warp.Entry
	for node, fs := range files {
		dirs := map[string][]warp.Entry{}
		for p, c := range fs {
			dir, name := "", p
			if j := strings.LastIndex(p, "/"); j >= 0 {
				dir, name = p[:j], p[j+1:]
			}
			id, _ := w.store.PutBlob(ctx, []byte(c))
			dirs[dir] = append(dirs[dir], warp.Entry{Name: name, Kind: warp.KindBlob, ID: id})
		}
		// Build directories deepest first.
		var keys []string
		for d := range dirs {
			keys = append(keys, d)
		}
		for len(keys) > 0 {
			sort.Slice(keys, func(a, b int) bool {
				return strings.Count(keys[a], "/") > strings.Count(keys[b], "/") || keys[a] > keys[b]
			})
			d := keys[0]
			keys = keys[1:]
			if d == "" {
				continue
			}
			id, err := w.store.PutTree(ctx, dirs[d])
			if err != nil {
				w.t.Fatal(err)
			}
			parent, name := "", d
			if j := strings.LastIndex(d, "/"); j >= 0 {
				parent, name = d[:j], d[j+1:]
			}
			if _, ok := dirs[parent]; !ok {
				keys = append(keys, parent)
			}
			dirs[parent] = append(dirs[parent], warp.Entry{Name: name, Kind: warp.KindTree, ID: id})
		}
		id, err := w.store.PutTree(ctx, dirs[""])
		if err != nil {
			w.t.Fatal(err)
		}
		nodes = append(nodes, warp.Entry{Name: node, Kind: warp.KindTree, ID: id})
	}
	ft, _ := w.store.PutTree(ctx, nodes)
	es, _ := w.store.Tree(ctx, tree)
	var keep []warp.Entry
	for _, e := range es {
		if e.Name != loom.FilesDir {
			keep = append(keep, e)
		}
	}
	root, err := w.store.PutTree(ctx, append(keep, warp.Entry{Name: loom.FilesDir, Kind: warp.KindTree, ID: ft}))
	if err != nil {
		w.t.Fatal(err)
	}
	c, err := w.store.Commit(ctx, warp.CommitSpec{Tree: root, Parents: []warp.ID{head}, Message: "run " + wf,
		Trailers: []warp.Trailer{{Key: loom.TrailerWorkflow, Value: wf}, {Key: loom.TrailerRun, Value: run}},
		Author:   warp.Signature{Name: "t", Email: "t@x", When: time.Unix(1700000100+int64(i), 0)}})
	if err != nil || w.store.Advance(ctx, loom.DefaultRef, head, c) != nil {
		w.t.Fatal(err)
	}
}

// TestInv_StepFileCapNeverInventsDeletions: every file of both runs is
// compared before the list is cut, so a file past the cut is never shown
// as deleted, and at most MaxFiles are listed in all. (Review 9: each run
// was cut separately, so unchanged files showed as deleted and 550 were
// listed.)
func TestInv_StepFileCapNeverInventsDeletions(t *testing.T) {
	w := newWorld(t)
	same := map[string]string{}
	for i := 0; i < drawdown.MaxFiles; i++ {
		same[fmt.Sprintf("f%04d", i)] = "x"
	}
	extra := map[string]string{}
	for i := 0; i < 50; i++ {
		extra[fmt.Sprintf("e%02d", i)] = "y"
	}
	w.commitFiles("wf", "r1", 0, map[string]map[string]string{"n1": same})
	w.commitFiles("wf", "r2", 1, map[string]map[string]string{"a0": extra, "n1": same})
	_, detail, _ := w.call("GET", "/api/runs/wf/r2", nil)
	rec := detail["record"].(map[string]any)
	count := map[string]int{}
	n := 0
	for _, fs := range rec["files"].(map[string]any) {
		for _, f := range fs.([]any) {
			count[f.(map[string]any)["status"].(string)]++
			n++
		}
	}
	if n != drawdown.MaxFiles || rec["moreFiles"] != true || count["deleted"] != 0 || count["added"] != 50 {
		t.Errorf("%d listed, more %v, by status %v", n, rec["moreFiles"], count)
	}
}

// TestInv_StepFilesCostFewGitProcesses: listing a record's files costs
// the same git processes however many directories it has: a record with
// 200 directories costs exactly what one with a single file does.
// (Review 9: two a directory, so 2,000 directories took 19 s.)
func TestInv_StepFilesCostFewGitProcesses(t *testing.T) {
	w := newWorld(t)
	deep := map[string]string{}
	for i := 0; i < 200; i++ {
		deep[fmt.Sprintf("a%d/b/c/f", i)] = fmt.Sprint(i)
	}
	one := map[string]string{"f": "1"}
	w.commitFiles("deep", "deep-r1", 0, map[string]map[string]string{"n0": deep})
	w.commitFiles("deep", "deep-r2", 1, map[string]map[string]string{"n0": deep})
	w.commitFiles("one", "one-r1", 2, map[string]map[string]string{"n0": one})
	w.commitFiles("one", "one-r2", 3, map[string]map[string]string{"n0": one})
	real, _ := exec.LookPath("git")
	bin, log := t.TempDir(), filepath.Join(t.TempDir(), "runs")
	os.WriteFile(filepath.Join(bin, "git"), []byte(fmt.Sprintf("#!/bin/sh\necho run >> %q\nexec %q \"$@\"\n", log, real)), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	runs := func(wf string, files int) int {
		os.Remove(log)
		_, detail, _ := w.call("GET", "/api/runs/"+wf+"/"+wf+"-r2", nil)
		if n := len(detail["record"].(map[string]any)["files"].(map[string]any)["n0"].([]any)); n != files {
			t.Fatalf("%s: %d files", wf, n)
		}
		b, _ := os.ReadFile(log)
		return strings.Count(string(b), "run")
	}
	// Untimed first requests fill the caches (commands, records) that
	// every later request shares.
	runs("one", 1)
	runs("deep", 200)
	if deepRuns, oneRuns := runs("deep", 200), runs("one", 1); deepRuns != oneRuns {
		t.Errorf("200 directories ran git %d times, one file %d", deepRuns, oneRuns)
	}
}

// TestInv_BlobDiffRefusesHugeFiles: /api/blobdiff refuses a file larger
// than MaxDiffBlob (413, naming the git command to use), rather than
// buffering its diff and sending it to a browser. (Review 9.)
func TestInv_BlobDiffRefusesHugeFiles(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	big, _ := w.store.PutBlob(ctx, []byte(strings.Repeat("line\n", drawdown.MaxDiffBlob/5+1)))
	small, _ := w.store.PutBlob(ctx, []byte("line\n"))
	code, body, _ := w.call("GET", fmt.Sprintf("/api/blobdiff/%s/%s", small, big), nil)
	if code != 413 || !strings.Contains(fmt.Sprint(body["error"]), "git diff") {
		t.Errorf("%d %v", code, body)
	}
}
