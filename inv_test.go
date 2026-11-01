package drawdown_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/warp"
)

// TestInv_OnlyWarpRunsGit: no package here starts processes itself; all
// Git work goes through warp, the single writer. Every way the standard
// library offers to start a process is banned: os/exec, syscall,
// golang.org/x/sys, and os.StartProcess.
func TestInv_OnlyWarpRunsGit(t *testing.T) {
	out, err := exec.Command("go", "list", "-f", "{{.Dir}}|{{.ImportPath}}|{{join .Imports \" \"}}|{{join .GoFiles \" \"}}", "./...").Output()
	if err != nil {
		t.Fatal(err)
	}
	banned := map[string]bool{"os/exec": true, "syscall": true, "golang.org/x/sys/unix": true, "golang.org/x/sys/execabs": true}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "|")
		dir, pkg, imports, files := f[0], f[1], strings.Fields(f[2]), strings.Fields(f[3])
		for _, imp := range imports {
			if banned[imp] || strings.HasPrefix(imp, "golang.org/x/sys") {
				t.Errorf("%s imports %s; run git only through warp", pkg, imp)
			}
		}
		for _, name := range files {
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			if regexp.MustCompile(`\bos\.StartProcess\b`).Match(b) {
				t.Errorf("%s/%s calls os.StartProcess; run git only through warp", pkg, name)
			}
		}
	}
}

// TestInv_UIOnlyReadsHistory: the server's view of warp has no method that
// writes, so the UI can't edit history even by mistake (DRAW-8).
func TestInv_UIOnlyReadsHistory(t *testing.T) {
	writes := map[string]bool{"Commit": true, "PutBlob": true, "PutTree": true, "Advance": true}
	h := reflect.TypeOf((*drawdown.History)(nil)).Elem()
	for i := 0; i < h.NumMethod(); i++ {
		if writes[h.Method(i).Name] {
			t.Errorf("History has %s, which writes", h.Method(i).Name)
		}
	}
	if f, _ := reflect.TypeOf(drawdown.Server{}).FieldByName("Store"); f.Type != h {
		t.Errorf("Server.Store is %v, want the read-only drawdown.History", f.Type)
	}
	var _ drawdown.History = (*warp.Store)(nil) // a real store still fits
}
