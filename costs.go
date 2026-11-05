package drawdown

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"go.temporal.io/api/serviceerror"

	"github.com/heedle-ai/loom"
)

// Costs (roadmap 10.4): what runs used of Claude, as their records say
// (loom.UsageOf), and estimates in dollars (loom.Cost) with the worker's
// prices. Nothing here asks Anthropic, and a step with no price gets no
// dollar figure: a cost is null, never 0, unless every step was priced.

// Budgeter sets a schedule's monthly budget (loom.SetBudget):
// TemporalClient does.
type Budgeter interface {
	SetBudget(ctx context.Context, name string, b loom.Budget) error
}

// SetBudget sets a schedule's monthly budget.
func (t TemporalClient) SetBudget(ctx context.Context, name string, b loom.Budget) error {
	return loom.SetBudget(ctx, t.Client, name, b)
}

// CostMonths is how many months the Costs page shows: this one and the
// six before it.
const CostMonths = 7

// spent is tokens and their estimate: USD is nil unless every step was
// priced (Priced holds the part that was).
type spent struct {
	Runs     int             `json:"runs"`
	Tokens   loom.Tokens     `json:"tokens"`
	USD      *float64        `json:"usd"`
	Priced   float64         `json:"priced"`
	Unpriced []loom.Unpriced `json:"unpriced"`
}

func spentOf(runs int, u loom.Usage, p loom.Prices) spent {
	c := loom.Cost(u, p)
	s := spent{Runs: runs, Tokens: u.Total(), Priced: c.USD, Unpriced: c.Unpriced}
	if c.Complete {
		s.USD = &c.USD
	}
	return s
}

// usageOf is a run's usage and cost, for its page.
func (s *Server) usageOf(rec record) map[string]any {
	prices, perr := loom.ReadPrices(s.PricesFile)
	u := loom.UsageOf(rec.Plan, rec.Outputs)
	c := loom.Cost(u, prices)
	out := map[string]any{"steps": u.Steps, "cost": c, "total": u.Total()}
	if perr != nil {
		out["pricesError"] = perr.Error()
	}
	return out
}

// costLocation is the time zone a request asks months in (tz), UTC by
// default.
func costLocation(tz string) (*time.Location, bool) {
	if tz == "" {
		return time.UTC, true
	}
	loc, err := time.LoadLocation(tz)
	return loc, err == nil && tz != "Local"
}

// costs is the Costs page: this month (or ?month=YYYY-MM) and the six
// before it, by model, in ?tz (UTC by default); the month's costliest
// runs and schedules; and the price table's date and source.
func (s *Server) costs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	loc, ok := costLocation(r.URL.Query().Get("tz"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "tz: use an IANA time zone, such as Europe/Lisbon"})
		return
	}
	at := time.Now()
	if m := r.URL.Query().Get("month"); m != "" {
		t, err := time.ParseInLocation("2006-01", m, loc)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "month: use YYYY-MM, such as 2026-11"})
			return
		}
		at = t
	}
	start, end := loom.MonthOf(at, loc)
	first := start.AddDate(0, -(CostMonths - 1), 0)
	runs, err := loom.AllRunsBetween(ctx, s.Store, first, end)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
		return
	}
	prices, perr := loom.ReadPrices(s.PricesFile)

	type model struct {
		Model string `json:"model"`
		spent
	}
	type month struct {
		Month   string  `json:"month"` // YYYY-MM
		ByModel []model `json:"byModel"`
		spent
	}
	type runCost struct {
		Workflow string    `json:"workflowId"`
		Run      string    `json:"runId"`
		Schedule string    `json:"schedule,omitempty"`
		At       time.Time `json:"at"`
		spent
	}
	type scheduleCost struct {
		Name string `json:"name"`
		spent
	}
	months := make([]month, CostMonths)
	usages := make([]loom.Usage, CostMonths)
	counts := make([]int, CostMonths)
	byModel := make([]map[string]loom.Usage, CostMonths)
	modelRuns := make([]map[string]map[string]bool, CostMonths)
	for i := range months {
		months[i].Month = start.AddDate(0, -i, 0).Format("2006-01")
		byModel[i], modelRuns[i] = map[string]loom.Usage{}, map[string]map[string]bool{}
	}
	var thisMonth []runCost
	scheduled := map[string]loom.Usage{}
	scheduledRuns := map[string]int{}
	for _, run := range runs {
		i := monthsBetween(run.At.In(loc), start)
		if i < 0 || i >= CostMonths || len(run.Usage.Steps) == 0 {
			continue
		}
		usages[i] = usages[i].Add(run.Usage)
		counts[i]++
		for _, st := range run.Usage.Steps {
			m := st.Model
			if st.Missing != "" {
				m = ""
			}
			byModel[i][m] = byModel[i][m].Add(loom.Usage{Steps: []loom.StepUsage{st}})
			if modelRuns[i][m] == nil {
				modelRuns[i][m] = map[string]bool{}
			}
			modelRuns[i][m][run.Run] = true
		}
		if i == 0 {
			thisMonth = append(thisMonth, runCost{Workflow: run.Workflow, Run: run.Run, Schedule: run.Schedule, At: run.At, spent: spentOf(1, run.Usage, prices)})
			if run.Schedule != "" {
				scheduled[run.Schedule] = scheduled[run.Schedule].Add(run.Usage)
				scheduledRuns[run.Schedule]++
			}
		}
	}
	for i := range months {
		months[i].spent = spentOf(counts[i], usages[i], prices)
		months[i].ByModel = []model{}
		for m, u := range byModel[i] {
			months[i].ByModel = append(months[i].ByModel, model{Model: m, spent: spentOf(len(modelRuns[i][m]), u, prices)})
		}
		sort.Slice(months[i].ByModel, func(a, b int) bool { return months[i].ByModel[a].Model < months[i].ByModel[b].Model })
	}
	// Costliest first: by what could be priced, then by tokens.
	costlier := func(a, b spent) bool {
		if a.Priced != b.Priced {
			return a.Priced > b.Priced
		}
		return a.Tokens.Input+a.Tokens.Output > b.Tokens.Input+b.Tokens.Output
	}
	sort.SliceStable(thisMonth, func(a, b int) bool { return costlier(thisMonth[a].spent, thisMonth[b].spent) })
	if len(thisMonth) > 10 {
		thisMonth = thisMonth[:10]
	}
	schedules := []scheduleCost{}
	for name, u := range scheduled {
		schedules = append(schedules, scheduleCost{Name: name, spent: spentOf(scheduledRuns[name], u, prices)})
	}
	sort.SliceStable(schedules, func(a, b int) bool { return costlier(schedules[a].spent, schedules[b].spent) })
	if thisMonth == nil {
		thisMonth = []runCost{}
	}
	yours := prices.Yours
	if yours == nil {
		yours = []string{}
	}
	resp := map[string]any{"zone": loc.String(), "months": months, "runs": thisMonth, "schedules": schedules,
		"asOf": prices.AsOf, "source": prices.Source, "yours": yours}
	if perr != nil {
		resp["pricesError"] = perr.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// monthsBetween is how many calendar months t is before the month that
// starts at start (0: that month).
func monthsBetween(t, start time.Time) int {
	if !t.Before(start.AddDate(0, 1, 0)) {
		return -1
	}
	return (start.Year()-t.Year())*12 + int(start.Month()) - int(t.Month())
}

// scheduleSpend is each schedule's month to date, in its own time zone
// (as its budget counts it), and the last 30 days.
func (s *Server) scheduleSpend(ctx context.Context, ss []loom.Schedule, now time.Time) (map[string]map[string]spent, string, error) {
	prices, perr := loom.ReadPrices(s.PricesFile)
	out := map[string]map[string]spent{}
	for _, sc := range ss {
		loc, ok := costLocation(sc.Spec.TimeZone)
		if !ok {
			loc = time.UTC
		}
		start, _ := loom.MonthOf(now, loc)
		from := now.AddDate(0, 0, -30)
		if start.Before(from) {
			from = start
		}
		ref := sc.Ref
		if ref == "" {
			ref = s.Ref
		}
		runs, err := loom.RunsBetween(ctx, s.Store, ref, from, now.Add(time.Minute), sc.Name)
		if err != nil {
			return nil, "", err
		}
		var month, last30 loom.Usage
		var nMonth, n30 int
		for _, run := range runs {
			if !run.At.Before(start) {
				month, nMonth = month.Add(run.Usage), nMonth+1
			}
			if !run.At.Before(now.AddDate(0, 0, -30)) {
				last30, n30 = last30.Add(run.Usage), n30+1
			}
		}
		out[sc.Name] = map[string]spent{"month": spentOf(nMonth, month, prices), "last30": spentOf(n30, last30, prices)}
	}
	if perr != nil {
		return out, perr.Error(), nil
	}
	return out, "", nil
}

// budgetRequest sets a schedule's monthly budget: USD 0 removes it.
type budgetRequest struct {
	USD             float64 `json:"usd"`
	ResumeNextMonth bool    `json:"resumeNextMonth"`
}

// setBudget sets a schedule's budget, through Temporal.
func (s *Server) setBudget(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !scheduleName.MatchString(name) {
		writeJSON(w, http.StatusNotFound, apiError{Error: "no schedule " + name})
		return
	}
	var req budgetRequest
	if !readJSONUpTo(w, r, &req, 256) {
		return
	}
	b, err := loom.ParseBudget(formatUSD(req.USD))
	if err != nil || (b == 0 && req.ResumeNextMonth) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "a budget is dollars from 0 to 1000000, in whole cents; a new month resumes only a schedule with a budget"})
		return
	}
	bt, ok := s.Temporal.(Budgeter)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, apiError{Error: "this server can't set budgets"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), temporalTimeout)
	defer cancel()
	if err := bt.SetBudget(ctx, name, loom.Budget{USD: b, ResumeNextMonth: req.ResumeNextMonth}); err != nil {
		var nf *serviceerror.NotFound
		if errors.As(err, &nf) || errors.Is(err, loom.ErrNoSchedule) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "no schedule " + name})
			return
		}
		writeJSON(w, http.StatusBadGateway, apiError{Error: "Temporal: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "budget": loom.Budget{USD: b, ResumeNextMonth: req.ResumeNextMonth}})
}

func formatUSD(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
