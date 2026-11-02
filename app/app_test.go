package app

import (
	"bytes"
	"context"
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
}
