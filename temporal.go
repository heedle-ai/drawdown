package drawdown

import (
	"context"
	"fmt"
	"regexp"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"

	"github.com/heedle-ai/loom"
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
