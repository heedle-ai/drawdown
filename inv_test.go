package drawdown_test

import (
	"os/exec"
	"strings"
	"testing"
)

// TestInv_OnlyWarpRunsGit: no package here runs programs itself; all Git
// work goes through warp, the single writer.
func TestInv_OnlyWarpRunsGit(t *testing.T) {
	out, err := exec.Command("go", "list", "-f", "{{.ImportPath}}: {{join .Imports \" \"}}", "./...").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		pkg, imports, _ := strings.Cut(line, ": ")
		for _, imp := range strings.Fields(imports) {
			if imp == "os/exec" {
				t.Errorf("%s imports os/exec; run git only through warp", pkg)
			}
		}
	}
}
