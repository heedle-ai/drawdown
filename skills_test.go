package drawdown_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

func skillFolder(name, body string) map[string][]byte {
	return map[string][]byte{"SKILL.md": []byte("---\nname: " + name + "\ndescription: Says the weather.\n---\n" + body), "scripts/get.sh": []byte("echo sunny")}
}

// TestInv_SkillsPageReadsTheLibrary: the Skills API lists every skill's
// newest version and the skills that can't be used; a skill's versions,
// newest first; and a version's files and SKILL.md, only for a version
// that was added to that skill.
func TestInv_SkillsPageReadsTheLibrary(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	lib := &treadle.Library{Store: w.store}
	v1, _ := lib.Add(ctx, skillFolder("weather", "v1"), time.Unix(1700000000, 0))
	v2, _ := lib.Add(ctx, skillFolder("weather", "v2"), time.Unix(1700000100, 0))
	w.store.Advance(ctx, treadle.RefPrefix+"broken", "", v1.Commit)

	_, list, _ := w.call("GET", "/api/skills", nil)
	skills := list["skills"].([]any)
	if len(skills) != 1 || skills[0].(map[string]any)["version"] != string(v2.Version) || len(list["problems"].([]any)) != 1 {
		t.Errorf("list = %v", list)
	}
	_, one, _ := w.call("GET", "/api/skills/weather", nil)
	if vs := one["versions"].([]any); len(vs) != 2 || vs[1].(map[string]any)["version"] != string(v1.Version) {
		t.Errorf("versions = %v", one)
	}
	_, ver, _ := w.call("GET", fmt.Sprintf("/api/skills/weather/%s", v1.Version), nil)
	if md, _ := ver["skillMD"].(string); !strings.HasSuffix(md, "v1") || len(ver["files"].([]any)) != 2 {
		t.Errorf("version = %v", ver)
	}
	forged, _ := w.store.PutTree(ctx, []warp.Entry{{Name: "SKILL.md", Kind: warp.KindBlob, ID: must(w.store.PutBlob(ctx, skillFolder("weather", "forged")["SKILL.md"]))}})
	for path, want := range map[string]int{
		"/api/skills/weather/" + string(forged): 404, "/api/skills/weather/HEAD": 404, "/api/skills/nope": 404,
		"/api/skills/Bad%20Name": 400, "/api/skills/weather/" + strings.Repeat("ab", 20): 404,
	} {
		if code, _, _ := w.call("GET", path, nil); code != want {
			t.Errorf("%s: %d, want %d", path, code, want)
		}
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// TestInv_SkillsPageServesOnlyWhatCanRun: a version is never served under
// another skill's name; one bad commit in a skill's history doesn't hide
// its other versions; a version over pirn's limits isn't served; and a
// skill's page costs at most a few git processes per version. (Review 15.)
func TestInv_SkillsPageServesOnlyWhatCanRun(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	lib := &treadle.Library{Store: w.store}
	at := time.Unix(1700000000, 0)
	weather := must(lib.Add(ctx, skillFolder("weather", "x"), at))
	w.store.Advance(ctx, treadle.RefPrefix+"other", "", weather.Commit)
	if code, _, _ := w.call("GET", "/api/skills/other/"+string(weather.Version), nil); code != 404 {
		t.Errorf("weather served as other: %d", code)
	}
	bad := must(w.store.PutTree(ctx, []warp.Entry{{Name: "x", Kind: warp.KindBlob, ID: must(w.store.PutBlob(ctx, []byte("x")))}}))
	c := must(w.store.Commit(ctx, warp.CommitSpec{Tree: bad, Message: "bad", Author: warp.Signature{Name: "t", Email: "t@x", When: at}}))
	w.store.Advance(ctx, treadle.RefPrefix+"rain", "", c)
	good := must(lib.Add(ctx, skillFolder("rain", "ok"), at))
	if code, one, _ := w.call("GET", "/api/skills/rain", nil); code != 200 || len(one["versions"].([]any)) != 1 {
		t.Errorf("rain: %d %v", code, one)
	}
	if code, _, _ := w.call("GET", "/api/skills/rain/"+string(good.Version), nil); code != 200 {
		t.Errorf("rain's good version: %d", code)
	}
	huge := skillFolder("huge", "x")
	huge["SKILL.md"] = append(huge["SKILL.md"], make([]byte, 2<<20)...)
	tree := must(w.store.PutTree(ctx, []warp.Entry{{Name: "SKILL.md", Kind: warp.KindBlob, ID: must(w.store.PutBlob(ctx, huge["SKILL.md"]))}}))
	hc := must(w.store.Commit(ctx, warp.CommitSpec{Tree: tree, Message: "huge", Author: warp.Signature{Name: "t", Email: "t@x", When: at}}))
	w.store.Advance(ctx, treadle.RefPrefix+"huge", "", hc)
	if code, _, body := w.call("GET", "/api/skills/huge/"+string(tree), nil); code == 200 || len(body) > 1<<20 {
		t.Errorf("a 2 MiB SKILL.md: %d, %d bytes", code, len(body))
	}
	for i := 0; i < 30; i++ {
		must(lib.Add(ctx, skillFolder("many", fmt.Sprint(i)), at.Add(time.Duration(i)*time.Second)))
	}
	calls := countGit(t)
	w.call("GET", "/api/skills/many", nil)
	if n := calls(); n > 3*30+10 {
		t.Errorf("30 versions cost %d git processes", n)
	}
	oldest := must(lib.Versions(ctx, "many"))[29].Version
	calls = countGit(t)
	w.call("GET", "/api/skills/many/"+string(oldest), nil)
	if n := calls(); n > 12 {
		t.Errorf("one version cost %d git processes", n)
	}
}

// countGit puts a git on PATH that logs each run, and returns how many
// runs there have been since.
func countGit(t *testing.T) func() int {
	real, _ := exec.LookPath("git")
	bin, log := t.TempDir(), filepath.Join(t.TempDir(), "runs")
	os.WriteFile(filepath.Join(bin, "git"), []byte(fmt.Sprintf("#!/bin/sh\necho run >> %q\nexec %q \"$@\"\n", log, real)), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() int { b, _ := os.ReadFile(log); return strings.Count(string(b), "run") }
}
