package drawdown

import (
	"context"
	"time"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/history/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/sdk/converter"

	"github.com/heedle-ai/loom"
)

// Step is one activity of a run, as Temporal's own history records it:
// each plan node's step, then loom's record.
type Step struct {
	Node      string    `json:"node"` // the plan node ID; RecordNode for loom's record
	Activity  string    `json:"activity"`
	Status    string    `json:"status"`   // Scheduled, Running, Completed, Failed, TimedOut, Canceled
	Attempts  int32     `json:"attempts"` // attempts so far; above 1 means Temporal retried it
	Scheduled time.Time `json:"scheduled"`
	Started   time.Time `json:"started,omitzero"` // the last attempt's start
	Closed    time.Time `json:"closed,omitzero"`
	// Failure is the latest failure Temporal recorded for the step: a failed
	// step's own, or, for one that succeeded after retries, the attempt
	// before (at most MaxFailure bytes).
	Failure string `json:"failure,omitempty"`
}

const (
	// RecordNode names loom's record step, which isn't a plan node.
	RecordNode = "record"
	// MaxFailure bounds a step's failure message.
	MaxFailure = 2 << 10
)

// stepReader turns workflow history events into steps. Events must come in
// history order; pending applies the attempts of steps still in flight.
type stepReader struct {
	steps []Step
	byID  map[int64]int  // scheduled event ID -> index
	byAct map[string]int // activity ID -> index
	child [2]string      // the plan workflow's ID and run ID, once started
	ended time.Time      // when the workflow itself closed, if it has
}

func newStepReader() *stepReader {
	return &stepReader{byID: map[int64]int{}, byAct: map[string]int{}}
}

func clip(s string) string {
	if len(s) > MaxFailure {
		return s[:MaxFailure]
	}
	return s
}

// event folds one history event in.
func (r *stepReader) event(e *history.HistoryEvent) {
	at := e.GetEventTime().AsTime()
	switch e.GetEventType() {
	case enums.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED:
		x := e.GetChildWorkflowExecutionStartedEventAttributes().GetWorkflowExecution()
		r.child = [2]string{x.GetWorkflowId(), x.GetRunId()}
	case enums.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
		a := e.GetActivityTaskScheduledEventAttributes()
		s := Step{Activity: a.GetActivityType().GetName(), Status: "Scheduled", Scheduled: at}
		var in struct {
			NodeID string `json:"node_id"` // all a step needs from plan.Input
		}
		switch {
		case s.Activity == loom.RecordName:
			s.Node = RecordNode
		case converter.GetDefaultDataConverter().FromPayloads(a.GetInput(), &in) == nil && in.NodeID != "":
			s.Node = in.NodeID
		default:
			return // not a step drawdown knows
		}
		r.byID[e.GetEventId()] = len(r.steps)
		r.byAct[a.GetActivityId()] = len(r.steps)
		r.steps = append(r.steps, s)
	case enums.EVENT_TYPE_ACTIVITY_TASK_STARTED:
		a := e.GetActivityTaskStartedEventAttributes()
		if i, ok := r.byID[a.GetScheduledEventId()]; ok {
			r.steps[i].Status, r.steps[i].Started, r.steps[i].Attempts = "Running", at, a.GetAttempt()
			if m := a.GetLastFailure().GetMessage(); m != "" {
				r.steps[i].Failure = clip(m)
			}
		}
	case enums.EVENT_TYPE_ACTIVITY_TASK_COMPLETED:
		r.close(e.GetActivityTaskCompletedEventAttributes().GetScheduledEventId(), "Completed", at, "")
	case enums.EVENT_TYPE_ACTIVITY_TASK_FAILED:
		a := e.GetActivityTaskFailedEventAttributes()
		r.close(a.GetScheduledEventId(), "Failed", at, a.GetFailure().GetMessage())
	case enums.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT:
		a := e.GetActivityTaskTimedOutEventAttributes()
		r.close(a.GetScheduledEventId(), "TimedOut", at, a.GetFailure().GetMessage())
	case enums.EVENT_TYPE_ACTIVITY_TASK_CANCELED:
		r.close(e.GetActivityTaskCanceledEventAttributes().GetScheduledEventId(), "Canceled", at, "")
	case enums.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED, enums.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
		enums.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT, enums.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
		enums.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED, enums.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW:
		r.ended = at
	}
}

// finish marks the steps that never closed because their workflow ended
// first (shuttle stops at a plan's first failure, leaving its siblings'
// results unread): they're Abandoned at the workflow's close, never shown
// as still running.
func (r *stepReader) finish() {
	if r.ended.IsZero() {
		return
	}
	for i := range r.steps {
		if s := &r.steps[i]; s.Closed.IsZero() {
			s.Status, s.Closed = "Abandoned", r.ended
		}
	}
}

func (r *stepReader) close(scheduled int64, status string, at time.Time, failure string) {
	i, ok := r.byID[scheduled]
	if !ok {
		return
	}
	r.steps[i].Status, r.steps[i].Closed = status, at
	if failure != "" {
		r.steps[i].Failure = clip(failure)
	}
}

// pending folds in what Temporal knows about steps still in flight: a step
// being retried has no started event until it ends.
func (r *stepReader) pending(ps []*workflow.PendingActivityInfo) {
	for _, p := range ps {
		i, ok := r.byAct[p.GetActivityId()]
		if !ok {
			continue
		}
		s := &r.steps[i]
		s.Attempts = p.GetAttempt()
		if p.GetState() == enums.PENDING_ACTIVITY_STATE_STARTED {
			s.Status = "Running"
		}
		if t := p.GetLastStartedTime(); t != nil {
			s.Started = t.AsTime()
		}
		if m := p.GetLastFailure().GetMessage(); m != "" {
			s.Failure = clip(m)
		}
	}
}

// Steps reads a run's steps from Temporal's history: the plan's activities
// from its child workflow, then loom's record from the run itself.
func (t TemporalClient) Steps(ctx context.Context, workflowID, runID string) ([]Step, error) {
	parent := newStepReader()
	if err := t.read(ctx, parent, workflowID, runID); err != nil {
		return nil, err
	}
	out := []Step{}
	if id := parent.child; id[0] != "" {
		child := newStepReader()
		if err := t.read(ctx, child, id[0], id[1]); err != nil {
			return nil, err
		}
		out = append(out, child.steps...)
	}
	return append(out, parent.steps...), nil
}

func (t TemporalClient) read(ctx context.Context, r *stepReader, workflowID, runID string) error {
	it := t.Client.GetWorkflowHistory(ctx, workflowID, runID, false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	for it.HasNext() {
		e, err := it.Next()
		if err != nil {
			return err
		}
		r.event(e)
	}
	defer r.finish()
	if len(r.byAct) == 0 || !r.ended.IsZero() {
		return nil // nothing in flight to ask about
	}
	d, err := t.Client.DescribeWorkflowExecution(ctx, workflowID, runID)
	if err != nil {
		return err
	}
	r.pending(d.GetPendingActivities())
	return nil
}
