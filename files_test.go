package drawdown_test

import (
	"context"
	"encoding/json"
	"fmt"
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
