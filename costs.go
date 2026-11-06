package drawdown

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.temporal.io/api/serviceerror"

	"github.com/heedle-ai/loom"
)

// Costs (roadmap 10.4): what runs used of Claude, as their records say
// (loom.UsageOf), plus every call no record holds, from loom's usage
// ledger (loom.ExtrasBetween: front-door asks, retried attempts, failed
// runs; roadmap 10.4.1), and estimates in dollars (loom.Cost) with the
// worker's prices. Nothing here asks Anthropic, and a step with no price gets no
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
// priced (Priced holds the part that was), and AtMost bounds it when
// every step could at least be bounded, as a budget counts it.
type spent struct {
	Runs     int             `json:"runs"`
	Tokens   loom.Tokens     `json:"tokens"`
	USD      *float64        `json:"usd"`
	Priced   float64         `json:"priced"`
	AtMost   *float64        `json:"atMost,omitempty"`
	Unpriced []loom.Unpriced `json:"unpriced"`
}

func spentOf(runs int, u loom.Usage, p loom.Prices) spent {
	c := loom.Cost(u, p)
	s := spent{Runs: runs, Tokens: u.Total(), Priced: c.USD, Unpriced: c.Unpriced}
	if c.Complete {
		s.USD = &c.USD
	} else if most, ok := c.AtMost(); ok {
		s.AtMost = &most
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
	extras, err := loom.ExtrasBetween(ctx, s.Store, first, end, runs, "")
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
		// Replayed counts the act steps that replayed an earlier run's
		// script whole, asking Claude nothing (roadmap 9.9); they aren't
		// in ByModel.
		Replayed int `json:"replayed"`
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
	// kindCost is this month's calls of one kind no record holds: Runs
	// is how many runs (or front-door requests) made them, Calls how
	// many calls.
	type kindCost struct {
		Kind  string `json:"kind"`
		Calls int    `json:"calls"`
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
			if st.Replayed == "all" {
				months[i].Replayed++ // no Claude: not a model's (review 51)
				continue
			}
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
	// The ledger's calls: in their month's totals and models (not as
	// runs), this month's by kind, and in their schedule's spend.
	kinds := map[string]loom.Usage{}
	kindRuns := map[string]map[string]bool{}
	for _, x := range extras {
		i := monthsBetween(x.At.In(loc), start)
		if i < 0 || i >= CostMonths {
			continue
		}
		usages[i] = usages[i].Add(x.Usage)
		for _, st := range x.Usage.Steps {
			byModel[i][st.Model] = byModel[i][st.Model].Add(loom.Usage{Steps: []loom.StepUsage{st}})
		}
		if i == 0 {
			kinds[x.Kind] = kinds[x.Kind].Add(x.Usage)
			if kindRuns[x.Kind] == nil {
				kindRuns[x.Kind] = map[string]bool{}
			}
			kindRuns[x.Kind][x.Workflow] = true
			if x.Schedule != "" {
				scheduled[x.Schedule] = scheduled[x.Schedule].Add(x.Usage)
			}
		}
	}
	byKind := []kindCost{}
	for _, k := range []string{loom.ExtraFrontDoor, loom.ExtraRetry, loom.ExtraFailedRun} {
		u := kinds[k]
		calls := 0
		for _, st := range u.Steps {
			calls += st.Requests
		}
		byKind = append(byKind, kindCost{Kind: k, Calls: calls, spent: spentOf(len(kindRuns[k]), u, prices)})
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
	resp := map[string]any{"zone": loc.String(), "months": months, "runs": thisMonth, "schedules": schedules, "kinds": byKind,
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
// (as its budget counts it), and the last 30 days. Each ref is read
// once, however many schedules record on it (review 48: once per
// schedule, on every top-bar refresh).
func (s *Server) scheduleSpend(ctx context.Context, ss []loom.Schedule, now time.Time) (spend map[string]map[string]spent, pricesErr, spendErr string) {
	prices, perr := loom.ReadPrices(s.PricesFile)
	type window struct{ month, last30 time.Time }
	windows := map[string]window{}
	byRef := map[string][]string{}
	from := map[string]time.Time{}
	for _, sc := range ss {
		loc, ok := costLocation(sc.Spec.TimeZone)
		if !ok {
			loc = time.UTC
		}
		start, _ := loom.MonthOf(now, loc)
		w := window{start, now.AddDate(0, 0, -30)}
		windows[sc.Name] = w
		ref := sc.Ref
		if ref == "" {
			ref = s.Ref
		}
		byRef[ref] = append(byRef[ref], sc.Name)
		earliest := w.month
		if w.last30.Before(earliest) {
			earliest = w.last30
		}
		if f, ok := from[ref]; !ok || earliest.Before(f) {
			from[ref] = earliest
		}
	}
	type acc struct {
		month, last30   loom.Usage
		nMonth, nLast30 int
	}
	sums := map[string]*acc{}
	var problems []string
	var all []loom.RunUsage
	earliest := now
	for ref, names := range byRef {
		// A schedule on a ref that can't be read gets no spend, never $0.
		runs, err := loom.RunsBetween(ctx, s.Store, ref, from[ref], now.Add(time.Minute), names...)
		if err != nil {
			// That ref's schedules show no spend, and why; the page,
			// where a budget is changed, still answers (review 48).
			problems = append(problems, ref+": "+err.Error())
			continue
		}
		mine := map[string]bool{}
		for _, n := range names {
			mine[n] = true
		}
		for _, n := range names {
			sums[n] = &acc{}
		}
		all = append(all, runs...)
		if from[ref].Before(earliest) {
			earliest = from[ref]
		}
		for _, run := range runs {
			if !mine[run.Schedule] {
				continue
			}
			a, w := sums[run.Schedule], windows[run.Schedule]
			if !run.At.Before(w.month) {
				a.month, a.nMonth = a.month.Add(run.Usage), a.nMonth+1
			}
			if !run.At.Before(w.last30) {
				a.last30, a.nLast30 = a.last30.Add(run.Usage), a.nLast30+1
			}
		}
	}
	// And each schedule's calls no record holds, from the ledger (roadmap
	// 10.4.1), as its budget counts them.
	if len(sums) > 0 {
		extras, err := loom.ExtrasBetween(ctx, s.Store, earliest, now.Add(time.Minute), all, "")
		if err != nil {
			problems = append(problems, "the usage ledger: "+err.Error())
		}
		for _, x := range extras {
			a, ok := sums[x.Schedule]
			if !ok || x.Schedule == "" {
				continue
			}
			w := windows[x.Schedule]
			if !x.At.Before(w.month) {
				a.month = a.month.Add(x.Usage)
			}
			if !x.At.Before(w.last30) {
				a.last30 = a.last30.Add(x.Usage)
			}
		}
	}
	out := map[string]map[string]spent{}
	if len(problems) > 0 {
		spendErr = "can't add up what schedules used on " + strings.Join(problems, "; ")
	}
	for name, a := range sums {
		out[name] = map[string]spent{"month": spentOf(a.nMonth, a.month, prices), "last30": spentOf(a.nLast30, a.last30, prices)}
	}
	if perr != nil {
		pricesErr = perr.Error()
	}
	return out, pricesErr, spendErr
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
