package drawdown

import (
	"context"
	"testing"

	"github.com/heedle-ai/draft"
	"github.com/heedle-ai/shuttle/plan"
)

// TestInv_ShapesMatchTheirPlans: the page draws a program's composition
// only if it names exactly the plan's nodes, in order, and implies exactly
// what each requires; any other shape (a step missing, extra, moved or
// with other waits, an unknown kind, an empty group) is refused, and the
// page draws the plan from its requires alone.
func TestInv_ShapesMatchTheirPlans(t *testing.T) {
	ctx := context.Background()
	reg := draft.DefaultRegistry()
	src := `(pipe (par (echo "a") (echo "b")) echo)`
	p, err := draft.Compile(ctx, reg, draft.Source(src))
	if err != nil {
		t.Fatal(err)
	}
	sh, err := draft.Composition(ctx, reg, draft.Source(src))
	if err != nil || !shapeMatches(sh, p) {
		t.Fatalf("the program's own shape: %v", err)
	}
	step := func(id string) draft.Shape { return draft.Shape{Kind: "step", Node: plan.NodeID(id)} }
	for name, bad := range map[string]draft.Shape{
		"a step missing":  {Kind: "pipe", Parts: []draft.Shape{step("n0"), step("n2")}},
		"steps moved":     {Kind: "pipe", Parts: []draft.Shape{{Kind: "par", Parts: []draft.Shape{step("n1"), step("n0")}}, step("n2")}},
		"other waits":     {Kind: "pipe", Parts: []draft.Shape{step("n0"), step("n1"), step("n2")}},
		"all parallel":    {Kind: "par", Parts: []draft.Shape{step("n0"), step("n1"), step("n2")}},
		"an extra step":   {Kind: "pipe", Parts: []draft.Shape{{Kind: "par", Parts: []draft.Shape{step("n0"), step("n1")}}, step("n2"), step("n3")}},
		"an unknown kind": {Kind: "loop", Parts: []draft.Shape{step("n0"), step("n1"), step("n2")}},
		"an empty group":  {Kind: "pipe", Parts: []draft.Shape{{Kind: "par", Parts: []draft.Shape{step("n0"), step("n1")}}, step("n2"), {Kind: "par"}}},
	} {
		if shapeMatches(bad, p) {
			t.Errorf("%s: accepted", name)
		}
	}
}
