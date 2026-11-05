package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
)

// TestAskExampleCompiles: the "ask" example on the new-run page compiles
// with the commands the built-in worker registers: three sources side by
// side, then one ask that depends on all of them.
func TestAskExampleCompiles(t *testing.T) {
	reg := shipment.Registry()
	reg.MustRegister(pirn.BuiltinSpec())
	p, err := draft.Compile(context.Background(), reg, draft.Source(AskExample))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Nodes) != 4 || p.Nodes[3].Activity != pirn.ActivityName || len(p.Nodes[3].Requires) != 3 ||
		!strings.HasPrefix(p.Nodes[3].Args[0], "Will the shipment be late?") {
		t.Errorf("plan = %+v", p.Nodes)
	}
}

// syncBuffer is a bytes.Buffer safe to write and read at once.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// TestInv_RunServesUntilItsContextEnds: Run serves the UI on the address
// it says, with Temporal down, and returns nil once its context ends, so
// heedle can run it beside Temporal and stop both.
func TestInv_RunServesUntilItsContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var out syncBuffer
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, []string{"-store", t.TempDir() + "/s.git", "-listen", "127.0.0.1:0", "-worker=false", "-address", "127.0.0.1:1"}, &out)
	}()
	addr := regexp.MustCompile(`http://(\S+) `)
	var url string
	for i := 0; i < 100 && url == ""; i++ {
		time.Sleep(50 * time.Millisecond)
		if m := addr.FindStringSubmatch(out.String()); m != nil {
			url = "http://" + m[1]
		}
	}
	res, err := http.Get(url + "/api/info")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/info: %v %v (%s)", res, err, out.String())
	}
	res.Body.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run after its context ended: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run kept serving after its context ended")
	}
	if err := Run(context.Background(), []string{}, io.Discard); err == nil || !strings.Contains(err.Error(), "-store") {
		t.Errorf("no store: %v", err)
	}
	// Review 21: help goes where Run writes, as the error flag.ErrHelp
	// (which drawdown and heedle exit 0 on).
	var help bytes.Buffer
	if err := Run(context.Background(), []string{"-h"}, &help); !errors.Is(err, flag.ErrHelp) || !strings.Contains(help.String(), "-store") {
		t.Errorf("-h: %v\n%s", err, help.String())
	}
}

// TestInv_MemoryIsBesideTheConnectors: the memory file is -memory FILE,
// or memory.json beside the -connectors file (so heedle up's is
// ~/.heedle/memory.json, as loom memory's is), or none: the memory page
// and the front door's worker use the same one. (Roadmap 10.1.)
func TestInv_MemoryIsBesideTheConnectors(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"-connectors", dir + "/connectors.json"}, dir + "/memory.json"},
		{[]string{"-connectors", dir + "/connectors.json", "-memory", dir + "/elsewhere.json"}, dir + "/elsewhere.json"},
		{nil, ""},
	} {
		ctx, cancel := context.WithCancel(context.Background())
		var out syncBuffer
		done := make(chan error, 1)
		go func() {
			done <- Run(ctx, append([]string{"-store", t.TempDir() + "/s.git", "-listen", "127.0.0.1:0", "-worker=false", "-address", "127.0.0.1:1"}, c.args...), &out)
		}()
		addr := regexp.MustCompile(`http://(\S+) `)
		url := ""
		for i := 0; i < 100 && url == ""; i++ {
			time.Sleep(50 * time.Millisecond)
			if m := addr.FindStringSubmatch(out.String()); m != nil {
				url = "http://" + m[1]
			}
		}
		res, err := http.Get(url + "/api/memory")
		if err != nil {
			t.Fatal(err)
		}
		var v struct{ File string }
		json.NewDecoder(res.Body).Decode(&v)
		res.Body.Close()
		if v.File != c.want {
			t.Errorf("%q: the memory file is %q, want %q", c.args, v.File, c.want)
		}
		cancel()
		<-done
	}
}

// TestInv_PricesAreBesideTheConnectors: without -prices, your prices file
// is prices.json beside the connectors file, as heedle up keeps both in
// its home; with neither, the built-in prices. (Roadmap 10.4.)
func TestInv_PricesAreBesideTheConnectors(t *testing.T) {
	for _, c := range [][3]string{
		{"", "/home/me/.heedle/connectors.json", "/home/me/.heedle/prices.json"},
		{"/etc/p.json", "/home/me/.heedle/connectors.json", "/etc/p.json"},
		{"", "", ""},
	} {
		if got := pricesPath(c[0], c[1]); got != c[2] {
			t.Errorf("pricesPath(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}
