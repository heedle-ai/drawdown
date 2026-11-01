package drawdown

import (
	"context"
	"testing"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/mocks"

	"go.temporal.io/api/common/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/sdk/converter"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/reed"
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

// TestLiveReadsBrowseHeartbeats: Live describes the run's plan workflow
// and decodes each pending browse step's heartbeat into a frame; other
// activities are skipped.
func TestLiveReadsBrowseHeartbeats(t *testing.T) {
	dc := converter.GetDefaultDataConverter()
	beat, err := dc.ToPayloads(reed.Frame{URL: "https://a.example/", JPEG: []byte{0xff, 0xd8, 0xff}})
	if err != nil {
		t.Fatal(err)
	}
	c := &mocks.Client{}
	c.On("DescribeWorkflowExecution", mock.Anything, "wf-1/plan", "").Return(&workflowservice.DescribeWorkflowExecutionResponse{
		PendingActivities: []*workflow.PendingActivityInfo{
			{ActivityId: "5", ActivityType: &common.ActivityType{Name: reed.ActivityName}, Attempt: 2, HeartbeatDetails: beat},
			{ActivityId: "6", ActivityType: &common.ActivityType{Name: "Echo"}, HeartbeatDetails: beat},
			{ActivityId: "7", ActivityType: &common.ActivityType{Name: reed.ActivityName}},
		},
	}, nil)
	frames, err := TemporalClient{Client: c}.Live(context.Background(), "wf-1")
	if err != nil || len(frames) != 1 || frames[0].URL != "https://a.example/" || frames[0].Attempt != 2 ||
		frames[0].Image != "data:image/jpeg;base64,/9j/" {
		t.Fatalf("frames = %+v, %v", frames, err)
	}
}
