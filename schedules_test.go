package drawdown_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestInv_SchedulesAreRunsOnATimer: a schedule is made from a program
// compiled as a run would be, refused before Temporal is asked for a
// program that doesn't compile or a time that makes no sense; it lists
// with its program and when it runs; running it now makes a run recorded
// like any other; it pauses, resumes and is deleted, and nothing else.
// (Roadmap 7.3.)
func TestInv_SchedulesAreRunsOnATimer(t *testing.T) {
	w := newWorld(t)
	prog := `(pipe (echo "weekly digest") echo)`
	for body, want := range map[string]int{
		`{"name":"digest","program":"(pipe (echo","every":"24h"}`:                                422,
		`{"name":"digest","program":"(echo \"x\")","every":"30s"}`:                               400,
		`{"name":"digest","program":"(echo \"x\")","every":"soon"}`:                              400,
		`{"name":"digest","program":"(echo \"x\")"}`:                                             400,
		`{"name":"Digest Daily","program":"(echo \"x\")","every":"1h"}`:                          400,
		`{"name":"digest","program":"(echo \"x\")","cron":"0 9 * * 1-5","timeZone":"Mars/Base"}`: 400,
	} {
		var m map[string]any
		if err := jsonUnmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		if code, _, raw := w.call("POST", "/api/schedules", m); code != want {
			t.Errorf("%s: %d %s", body, code, raw)
		}
	}
	if code, _, raw := w.call("POST", "/api/schedules", map[string]string{"name": "digest", "program": prog, "cron": "0 9 * * 1-5", "timeZone": "Europe/Lisbon"}); code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	_, m, _ := w.call("GET", "/api/schedules", nil)
	ss := m["schedules"].([]any)
	if len(ss) != 1 {
		t.Fatalf("schedules %v", m)
	}
	s := ss[0].(map[string]any)
	if s["name"] != "digest" || s["program"] != prog || s["spec"].(map[string]any)["cron"] != "0 9 * * 1-5" {
		t.Errorf("schedule %v", s)
	}
	if code, _, _ := w.call("POST", "/api/schedules", map[string]string{"name": "digest", "program": prog, "every": "1h"}); code != 409 {
		t.Errorf("a name taken: %d", code)
	}
	for _, path := range []string{"/api/schedules/nothing/run", "/api/schedules/Bad%20Name/run"} {
		if code, _, _ := w.call("POST", path, map[string]any{}); code != 404 {
			t.Errorf("%s: %d", path, code)
		}
	}
	// A run of the program by hand, then two by the schedule: each
	// scheduled run's previous is the run before it, though their
	// workflow IDs differ by the time Temporal adds (review 30).
	w.submit(prog)
	var runs [2]string
	for i := range runs {
		if code, _, raw := w.call("POST", "/api/schedules/digest/run", map[string]any{}); code != 200 {
			t.Fatalf("run now: %d %s", code, raw)
		}
		_, m, _ := w.call("GET", "/api/schedules", nil)
		recent := m["schedules"].([]any)[0].(map[string]any)["recent"].([]any)
		r := recent[len(recent)-1].(map[string]any)
		runs[i] = r["workflowId"].(string) + "/" + r["runId"].(string)
	}
	_, first, _ := w.call("GET", "/api/runs/"+runs[0], nil)
	_, second, _ := w.call("GET", "/api/runs/"+runs[1], nil)
	r1, r2 := first["record"].(map[string]any), second["record"].(map[string]any)
	if r1["previous"] == nil || r2["previous"] != r1["commit"] {
		t.Errorf("previous runs: first %v, second %v (want %v)", r1["previous"], r2["previous"], r1["commit"])
	}
	_, list, _ := w.call("GET", "/api/runs", nil)
	found := false
	for _, r := range list["runs"].([]any) {
		r := r.(map[string]any)
		found = found || r["program"] == prog && r["commit"] != nil
	}
	if !found {
		t.Errorf("the scheduled run wasn't recorded: %v", list)
	}
	for _, a := range []string{"pause", "resume", "delete"} {
		if code, _, raw := w.call("POST", "/api/schedules/digest/"+a, map[string]any{}); code != 200 {
			t.Errorf("%s: %d %s", a, code, raw)
		}
	}
	if code, _, _ := w.call("POST", "/api/schedules/digest/explode", map[string]any{}); code != 404 {
		t.Errorf("an unknown action: %d", code)
	}
	if _, m, _ := w.call("GET", "/api/schedules", nil); len(m["schedules"].([]any)) != 0 {
		t.Errorf("after delete: %v", m)
	}
	if code := w.rawPost("/api/schedules/digest/run", "text/plain", ""); code != 415 {
		t.Errorf("not JSON (another site's form): %d", code)
	}
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }

// rawPost posts body as ctype, as another site's form could.
func (w *world) rawPost(path, ctype, body string) int {
	w.t.Helper()
	res, err := http.Post(w.srv.URL+path, ctype, strings.NewReader(body))
	if err != nil {
		w.t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}
