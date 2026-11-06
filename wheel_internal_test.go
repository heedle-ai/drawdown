package drawdown

import (
	"bytes"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
)

// fakeWheel is a step's browser a person drives, keeping what reached it.
type fakeWheel struct {
	keys    []string
	clicks  [][2]int
	handed  bool
	keep    bool
	waiting bool
}

func (f *fakeWheel) Click(x, y int) error {
	if !f.waiting {
		return pirn.ErrNotWaiting
	}
	if _, err := reed.ClickJS(x, y); err != nil {
		return err
	}
	f.clicks = append(f.clicks, [2]int{x, y})
	return nil
}
func (f *fakeWheel) Key(k string) error {
	if !f.waiting {
		return pirn.ErrNotWaiting
	}
	if !reed.IsKey(k) {
		return reed.ErrInvalid
	}
	f.keys = append(f.keys, k)
	return nil
}
func (f *fakeWheel) Frame() reed.Frame {
	return reed.Frame{URL: "https://forms.example.org/x", JPEG: []byte{0xff, 0xd8, 0xff}}
}
func (f *fakeWheel) HandBack(keep bool) { f.handed, f.keep, f.waiting = true, keep, false }

type fakeWheels map[string]*fakeWheel

func (m fakeWheels) Wheel(id string) (Wheel, bool) {
	w, ok := m[id]
	if !ok || !w.waiting {
		return nil, false
	}
	return w, true
}

// TestInv_WheelOnlyFromHereWhileWaiting: a person's clicks and keys reach
// a step's browser only from a request on this machine (not one another
// host or a proxy passes on, nor one another site makes), only while that
// step waits for a person here, and only as one click or one key; and
// what they typed is in no answer and no log (roadmap 9.10).
func TestInv_WheelOnlyFromHereWhileWaiting(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	fw := &fakeWheel{waiting: true}
	s := &Server{Wheels: fakeWheels{id: fw}}
	h := s.Handler()
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	var answers strings.Builder
	call := func(method, path, body, remote string, headers ...string) int {
		r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, strings.NewReader(body))
		r.RemoteAddr = remote
		r.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			if headers[i] == "Host" {
				r.Host = headers[i+1]
			}
			r.Header.Set(headers[i], headers[i+1])
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		answers.WriteString(w.Body.String())
		return w.Code
	}
	const here, there = "127.0.0.1:50000", "100.64.0.7:50000"
	in := "/api/wheel/" + id + "/input"
	for name, c := range map[string]struct {
		remote  string
		headers []string
	}{
		"another host":     {there, nil},
		"through a proxy":  {here, []string{"X-Forwarded-For", "100.64.0.7"}},
		"another site":     {here, []string{"Sec-Fetch-Site", "cross-site"}},
		"another origin":   {here, []string{"Origin", "https://evil.example"}},
		"forwarded header": {here, []string{"Forwarded", "for=100.64.0.7"}},
	} {
		if code := call("POST", in, `{"key":"s"}`, c.remote, c.headers...); code != 403 {
			t.Errorf("%s: %d", name, code)
		}
	}
	if code := call("GET", "/api/wheel/"+id+"/frame", "", there); code != 403 {
		t.Errorf("a frame to another host: %d", code)
	}
	// Review 52: a page on another port of this machine, or a name
	// rebound to it, is another site.
	for name, c := range map[string]struct {
		remote  string
		headers []string
	}{
		"another port":            {here, []string{"Origin", "http://127.0.0.1:9999", "Sec-Fetch-Site", "same-site"}},
		"localhost, another port": {"[::1]:50000", []string{"Origin", "http://localhost:9999"}},
		"a rebound name":          {here, []string{"Host", "evil.example:8090"}},
	} {
		if code := call("POST", in, `{"key":"s"}`, c.remote, c.headers...); code < 400 {
			t.Errorf("%s: %d", name, code)
		}
	}
	if len(fw.keys) != 0 {
		t.Fatalf("a key from another site reached the browser: %v", fw.keys)
	}
	for _, remote := range []string{"[::1]:50000", "[::ffff:127.0.0.1]:50000"} {
		if code := call("POST", in, `{"key":"s"}`, remote); code != 204 {
			t.Errorf("a key from this machine, %s: %d", remote, code)
		}
	}
	fw.keys = nil
	for _, k := range strings.Split("hunter2", "") {
		if code := call("POST", in, `{"key":"`+k+`"}`, here); code != 204 {
			t.Fatalf("a key from here: %d", code)
		}
	}
	if code := call("POST", in, `{"x":10,"y":20}`, here); code != 204 || len(fw.clicks) != 1 {
		t.Errorf("a click: %d %v", code, fw.clicks)
	}
	for _, bad := range []string{`{"x":10}`, `{"x":1,"y":2,"key":"a"}`, `{}`, `{"key":"Control+a"}`, `{"x":99999,"y":1}`, `{"key":"a","extra":1}`} {
		if code := call("POST", in, bad, here); code != 400 {
			t.Errorf("%s: %d", bad, code)
		}
	}
	if code := call("GET", "/api/wheel/"+id+"/frame", "", here); code != 200 {
		t.Errorf("frame: %d", code)
	}
	if code := call("POST", "/api/wheel/"+strings.Repeat("f", 32)+"/input", `{"key":"a"}`, here); code != 409 {
		t.Errorf("a step not waiting: %d", code)
	}
	if code := call("POST", "/api/wheel/"+id+"/handback", `{"keep":true}`, here); code != 204 || !fw.handed || !fw.keep {
		t.Errorf("hand back: %d", code)
	}
	if code := call("POST", in, `{"key":"x"}`, here); code != 409 {
		t.Errorf("a key after hand back: %d", code)
	}
	if strings.Join(fw.keys, "") != "hunter2" {
		t.Errorf("keys %v", fw.keys)
	}
	if strings.Contains(answers.String(), "hunter2") || strings.Contains(logs.String(), "hunter") || strings.Contains(answers.String(), `"h"`) {
		t.Errorf("what was typed came back:\n%s\n%s", answers.String(), logs.String())
	}
}
