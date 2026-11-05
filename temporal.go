package drawdown

import (
	"context"
	"encoding/base64"
	"fmt"
	"regexp"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/treadle"
)

var queueName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// TemporalClient implements Temporal with the Temporal Go SDK.
type TemporalClient struct {
	Client client.Client
	Queue  string // task queue loom's workers poll
}

// Submit starts a run through loom.Submit.
func (t TemporalClient) Submit(ctx context.Context, in loom.RunInput) (string, string, error) {
	run, err := loom.Submit(ctx, t.Client, t.Queue, in)
	if err != nil {
		return "", "", err
	}
	return run.GetID(), run.GetRunID(), nil
}

// ChangeSkills runs loom's skills workflow and waits for it.
func (t TemporalClient) ChangeSkills(ctx context.Context, in loom.SkillsChange) (treadle.Skill, error) {
	return loom.ChangeSkills(ctx, t.Client, t.Queue, in)
}

// ListSkills lists a repository's skills on a worker.
func (t TemporalClient) ListSkills(ctx context.Context, src treadle.Source) (loom.Catalog, error) {
	return loom.ListSkills(ctx, t.Client, t.Queue, src)
}

// Writes asks a run for its writes so far.
func (t TemporalClient) Writes(ctx context.Context, workflowID string) ([]loom.WriteOutcome, error) {
	return loom.Writes(ctx, t.Client, workflowID)
}

// DecideWrite approves or declines a run's write.
func (t TemporalClient) DecideWrite(ctx context.Context, workflowID string, d loom.WriteDecision) error {
	return loom.DecideWrite(ctx, t.Client, workflowID, d)
}

// Ask has a worker propose what heedle would do for a request.
func (t TemporalClient) Ask(ctx context.Context, in loom.AskRequest) (loom.Proposal, error) {
	return loom.Ask(ctx, t.Client, t.Queue, in)
}

// WriteProgram has a worker write a program for a task.
func (t TemporalClient) WriteProgram(ctx context.Context, description string) (loom.Written, error) {
	return loom.WriteProgram(ctx, t.Client, t.Queue, description)
}

// List returns up to 200 executions of loom's RunWorkflow on this task
// queue, using Temporal's visibility query.
func (t TemporalClient) List(ctx context.Context) ([]Execution, error) {
	if !queueName.MatchString(t.Queue) {
		return nil, fmt.Errorf("task queue %q: use letters, digits, '.', '_' and '-'", t.Queue)
	}
	resp, err := t.Client.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{
		Query:    "WorkflowType = '" + loom.RunWorkflowName + "' AND TaskQueue = '" + t.Queue + "'",
		PageSize: 200,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Execution, 0, len(resp.Executions))
	for _, info := range resp.Executions {
		out = append(out, execution(info))
	}
	return out, nil
}

// Describe returns one execution's status and times.
func (t TemporalClient) Describe(ctx context.Context, workflowID, runID string) (Execution, error) {
	d, err := t.Client.DescribeWorkflowExecution(ctx, workflowID, runID)
	if err != nil {
		return Execution{}, err
	}
	return execution(d.WorkflowExecutionInfo), nil
}

// Live reads the heartbeat of each browsing step running in the run's plan
// (its child workflow, "<workflow ID>/plan"): browse (reed) and act (pirn,
// roadmap 9.5) heartbeat a reed.Frame. A frame with no picture yet (an
// act step before its first action) isn't shown.
func (t TemporalClient) Live(ctx context.Context, workflowID string) ([]LiveFrame, error) {
	d, err := t.Client.DescribeWorkflowExecution(ctx, workflowID+"/plan", "")
	if err != nil {
		return nil, err
	}
	var out []LiveFrame
	for _, a := range d.PendingActivities {
		kind, ok := liveKinds[a.GetActivityType().GetName()]
		if !ok || a.GetHeartbeatDetails() == nil {
			continue
		}
		var f reed.Frame
		if converter.GetDefaultDataConverter().FromPayloads(a.GetHeartbeatDetails(), &f) != nil || len(f.JPEG) == 0 {
			continue
		}
		lf := liveFrame(a.GetActivityId(), a.GetAttempt(), f)
		lf.Kind = kind
		out = append(out, lf)
	}
	return out, nil
}

// liveKinds are the activities whose heartbeats are frames, with their
// commands.
var liveKinds = map[string]string{reed.ActivityName: "browse", pirn.ActActivityName: "act"}

func liveFrame(id string, attempt int32, f reed.Frame) LiveFrame {
	return LiveFrame{Activity: id, Attempt: attempt, URL: f.URL,
		Image: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(f.JPEG)}
}

func execution(info *workflow.WorkflowExecutionInfo) Execution {
	e := Execution{
		WorkflowID: info.GetExecution().GetWorkflowId(),
		RunID:      info.GetExecution().GetRunId(),
		Status:     statusName(info.GetStatus()),
	}
	if ts := info.GetStartTime(); ts != nil {
		e.Start = ts.AsTime()
	}
	if ts := info.GetCloseTime(); ts != nil {
		e.Close = ts.AsTime()
	}
	if p, ok := info.GetMemo().GetFields()[loom.MemoRef]; ok {
		var ref string
		if converter.GetDefaultDataConverter().FromPayload(p, &ref) == nil {
			e.Ref = ref
		}
	}
	if p, ok := info.GetMemo().GetFields()[loom.MemoSkipped]; ok {
		converter.GetDefaultDataConverter().FromPayload(p, &e.Skipped)
	}
	return e
}

func statusName(s enums.WorkflowExecutionStatus) string {
	switch s {
	case enums.WORKFLOW_EXECUTION_STATUS_RUNNING:
		return "Running"
	case enums.WORKFLOW_EXECUTION_STATUS_COMPLETED:
		return "Completed"
	case enums.WORKFLOW_EXECUTION_STATUS_FAILED:
		return "Failed"
	case enums.WORKFLOW_EXECUTION_STATUS_CANCELED:
		return "Canceled"
	case enums.WORKFLOW_EXECUTION_STATUS_TERMINATED:
		return "Terminated"
	case enums.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW:
		return "ContinuedAsNew"
	case enums.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
		return "TimedOut"
	default:
		return "Unknown"
	}
}

// ensure the adapter satisfies the interface.
var _ Temporal = TemporalClient{}

// CreateSchedule creates a loom schedule on this task queue.
func (t TemporalClient) CreateSchedule(ctx context.Context, name string, in loom.RunInput, spec loom.ScheduleSpec) error {
	return loom.CreateSchedule(ctx, t.Client, t.Queue, name, in, spec)
}

// Schedules lists loom's schedules.
func (t TemporalClient) Schedules(ctx context.Context) ([]loom.Schedule, error) {
	return loom.Schedules(ctx, t.Client, t.Queue)
}

// ScheduleAction pauses, resumes, deletes or runs a schedule now.
func (t TemporalClient) ScheduleAction(ctx context.Context, name, action string) error {
	return loom.ScheduleAction(ctx, t.Client, name, action)
}
