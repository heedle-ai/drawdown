package main

import (
	"context"
	"strings"
	"testing"

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
