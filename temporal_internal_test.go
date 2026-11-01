package drawdown

import (
	"testing"

	"go.temporal.io/api/common/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/sdk/converter"

	"github.com/heedle-ai/loom"
)

// TestExecutionReadsTheRefMemo: the ref loom.Submit stores in the memo is
// what puts a running execution on the right ref's list.
func TestExecutionReadsTheRefMemo(t *testing.T) {
	p, err := converter.GetDefaultDataConverter().ToPayload("refs/loom/what-if")
	if err != nil {
		t.Fatal(err)
	}
	info := &workflow.WorkflowExecutionInfo{
		Execution: &common.WorkflowExecution{WorkflowId: "wf", RunId: "run"},
		Memo:      &common.Memo{Fields: map[string]*common.Payload{loom.MemoRef: p}},
	}
	if e := execution(info); e.Ref != "refs/loom/what-if" || e.WorkflowID != "wf" {
		t.Errorf("execution = %+v", e)
	}
	if e := execution(&workflow.WorkflowExecutionInfo{}); e.Ref != "" {
		t.Errorf("no memo: ref %q", e.Ref)
	}
}
