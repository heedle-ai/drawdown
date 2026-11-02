package drawdown_test

import (
	"context"
	"fmt"
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
