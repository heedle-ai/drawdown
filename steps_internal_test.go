package drawdown

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/api/common/v1"
	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/failure/v1"
	"go.temporal.io/api/history/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/mocks"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/shuttle/plan"
)

type events struct{ es []*history.HistoryEvent }

func (e *events) HasNext() bool { return len(e.es) > 0 }
func (e *events) Next() (*history.HistoryEvent, error) {
	x := e.es[0]
	e.es = e.es[1:]
	return x, nil
}

var t0 = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func at(ms int) *timestamppb.Timestamp {
	return timestamppb.New(t0.Add(time.Duration(ms) * time.Millisecond))
}

func scheduled(t *testing.T, id int64, act, activity string, input any, ms int) *history.HistoryEvent {
	p, err := converter.GetDefaultDataConverter().ToPayloads(input)
	if err != nil {
		t.Fatal(err)
	}
	return &history.HistoryEvent{EventId: id, EventTime: at(ms), EventType: enums.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
		Attributes: &history.HistoryEvent_ActivityTaskScheduledEventAttributes{ActivityTaskScheduledEventAttributes: &history.ActivityTaskScheduledEventAttributes{
			ActivityId: act, ActivityType: &common.ActivityType{Name: activity}, Input: p}}}
}

func started(sched int64, attempt int32, lastFailure string, ms int) *history.HistoryEvent {
	a := &history.ActivityTaskStartedEventAttributes{ScheduledEventId: sched, Attempt: attempt}
	if lastFailure != "" {
		a.LastFailure = &failure.Failure{Message: lastFailure}
	}
	return &history.HistoryEvent{EventTime: at(ms), EventType: enums.EVENT_TYPE_ACTIVITY_TASK_STARTED,
		Attributes: &history.HistoryEvent_ActivityTaskStartedEventAttributes{ActivityTaskStartedEventAttributes: a}}
}

func completed(sched int64, ms int) *history.HistoryEvent {
	return &history.HistoryEvent{EventTime: at(ms), EventType: enums.EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
		Attributes: &history.HistoryEvent_ActivityTaskCompletedEventAttributes{ActivityTaskCompletedEventAttributes: &history.ActivityTaskCompletedEventAttributes{ScheduledEventId: sched}}}
}

func failed(sched int64, msg string, ms int) *history.HistoryEvent {
	return &history.HistoryEvent{EventTime: at(ms), EventType: enums.EVENT_TYPE_ACTIVITY_TASK_FAILED,
		Attributes: &history.HistoryEvent_ActivityTaskFailedEventAttributes{ActivityTaskFailedEventAttributes: &history.ActivityTaskFailedEventAttributes{ScheduledEventId: sched, Failure: &failure.Failure{Message: msg}}}}
}

// TestInv_StepsComeFromTemporalHistory: a run's steps are read from
// Temporal's own history: the plan's activities from its child workflow,
// each named by the node ID in its input, then loom's record from the run.
// Attempts, the last failure, failures and steps still being retried
// (known only from the pending activities) are all reported; activities
// that aren't plan steps are skipped; failure messages are bounded.
func TestInv_StepsComeFromTemporalHistory(t *testing.T) {
	parent := &events{[]*history.HistoryEvent{
		{EventTime: at(0), EventType: enums.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED,
			Attributes: &history.HistoryEvent_ChildWorkflowExecutionStartedEventAttributes{ChildWorkflowExecutionStartedEventAttributes: &history.ChildWorkflowExecutionStartedEventAttributes{
				WorkflowExecution: &common.WorkflowExecution{WorkflowId: "wf/plan", RunId: "child-run"}}}},
		scheduled(t, 50, "50", loom.RecordName, loom.RecordInput{}, 9000),
		started(50, 1, "", 9010),
		completed(50, 9100),
	}}
	long := strings.Repeat("x", MaxFailure+100)
	child := &events{[]*history.HistoryEvent{
		scheduled(t, 5, "5", "Echo", plan.Input{NodeID: "n0"}, 10),
		scheduled(t, 6, "6", "Browse", plan.Input{NodeID: "n1"}, 10),
		scheduled(t, 7, "7", "Ask", plan.Input{NodeID: "n2"}, 20),
		scheduled(t, 8, "8", "SomethingElse", "not a plan input", 20),
		started(5, 2, "429 Too Many Requests", 30),
		completed(5, 80),
		started(6, 3, "", 40),
		failed(6, long, 900),
	}}
	c := &mocks.Client{}
	c.On("GetWorkflowHistory", mock.Anything, "wf", "run", false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT).Return(parent)
	c.On("GetWorkflowHistory", mock.Anything, "wf/plan", "child-run", false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT).Return(child)
	c.On("DescribeWorkflowExecution", mock.Anything, "wf", "run").Return(&workflowservice.DescribeWorkflowExecutionResponse{}, nil)
	c.On("DescribeWorkflowExecution", mock.Anything, "wf/plan", "child-run").Return(&workflowservice.DescribeWorkflowExecutionResponse{
		PendingActivities: []*workflow.PendingActivityInfo{{ActivityId: "7", Attempt: 4, State: enums.PENDING_ACTIVITY_STATE_STARTED,
			LastStartedTime: at(500), LastFailure: &failure.Failure{Message: "overloaded"}}},
	}, nil)

	steps, err := TemporalClient{Client: c}.Steps(context.Background(), "wf", "run")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Step{}
	var order []string
	for _, s := range steps {
		got[s.Node] = s
		order = append(order, s.Node)
	}
	if strings.Join(order, ",") != "n0,n1,n2,record" {
		t.Fatalf("steps %v, want the plan's in history order, then the record", order)
	}
	if s := got["n0"]; s.Status != "Completed" || s.Attempts != 2 || s.Failure != "429 Too Many Requests" ||
		!s.Scheduled.Equal(at(10).AsTime()) || !s.Started.Equal(at(30).AsTime()) || !s.Closed.Equal(at(80).AsTime()) {
		t.Errorf("retried step = %+v", s)
	}
	if s := got["n1"]; s.Status != "Failed" || s.Attempts != 3 || len(s.Failure) != MaxFailure {
		t.Errorf("failed step = %+v (failure %d bytes)", s, len(s.Failure))
	}
	if s := got["n2"]; s.Status != "Running" || s.Attempts != 4 || s.Failure != "overloaded" || !s.Started.Equal(at(500).AsTime()) || !s.Closed.IsZero() {
		t.Errorf("step being retried = %+v", s)
	}
	if s := got["record"]; s.Activity != loom.RecordName || s.Status != "Completed" {
		t.Errorf("record = %+v", s)
	}
}

// TestInv_StepsOfAnEndedRunAreAbandoned: when a plan fails, shuttle stops
// at the first failure and its other steps never close. Once the workflow
// has ended they're Abandoned at its close time, never shown as running,
// and Temporal isn't asked about activities in flight.
func TestInv_StepsOfAnEndedRunAreAbandoned(t *testing.T) {
	child := &events{[]*history.HistoryEvent{
		scheduled(t, 5, "5", "Browse", plan.Input{NodeID: "n0"}, 10),
		scheduled(t, 6, "6", "Browse", plan.Input{NodeID: "n1"}, 10),
		started(5, 1, "", 20),
		failed(5, "blocked", 300),
		{EventTime: at(310), EventType: enums.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED},
	}}
	c := &mocks.Client{}
	c.On("GetWorkflowHistory", mock.Anything, "wf", "run", false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT).Return(&events{[]*history.HistoryEvent{
		{EventTime: at(0), EventType: enums.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED,
			Attributes: &history.HistoryEvent_ChildWorkflowExecutionStartedEventAttributes{ChildWorkflowExecutionStartedEventAttributes: &history.ChildWorkflowExecutionStartedEventAttributes{
				WorkflowExecution: &common.WorkflowExecution{WorkflowId: "wf/plan", RunId: "child-run"}}}},
		{EventTime: at(320), EventType: enums.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED},
	}})
	c.On("GetWorkflowHistory", mock.Anything, "wf/plan", "child-run", false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT).Return(child)
	steps, err := TemporalClient{Client: c}.Steps(context.Background(), "wf", "run")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].Status != "Failed" || steps[1].Status != "Abandoned" || !steps[1].Closed.Equal(at(310).AsTime()) {
		t.Errorf("steps = %+v", steps)
	}
	c.AssertNotCalled(t, "DescribeWorkflowExecution", mock.Anything, mock.Anything, mock.Anything)
}
