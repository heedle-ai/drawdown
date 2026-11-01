Every invariant below is guarded by a test or a CI step, and CI checks this page against the code on every push: each test named here must exist, and every `TestLaw_*`, `TestInv_*` and `Fuzz*` test must be listed here. A mistake isn't fixed until it has a row on this page.

[[/images/invariant-loop.svg|alt=From a mistake to a codified invariant: mistake, named invariant, guard, CI gate]]

[[/images/sources.svg|alt=Where drawdown's data comes from: the browser talks to drawdown's API, which compiles with draft, submits through loom, reads Temporal and warp]]

| ID | Invariant | Guarded by | Came from |
|---|---|---|---|
| DRAW-1 | Other websites can't use drawdown: POSTs must be JSON, cross-origin requests and unknown `Host` names are refused | `TestGuard_RefusesCrossSiteAndRebinding` | Review: any page you visited could start runs (CSRF), and DNS rebinding could read results |
| DRAW-2 | The runs list does bounded work: the latest 200 records, programs cached by content-addressed tree ID | `TestList_IsBoundedAndRecordedRowsHaveNoDuration` | Review: 5.8 s per poll at 400 records, polled every 2 s |
| DRAW-3 | Recorded history stays visible when Temporal is down, and Temporal's errors are shown, never swallowed | `TestList_WhenTemporalIsDown_ShowsRecords`, `TestDetail_ReportsTemporalErrorWhenNoRecord` | Review: "no such run" hid "Temporal is down" |
| DRAW-4 | Every endpoint compiles, submits, lists, details and diffs correctly against real runs and real Git records | `TestCompile`, `TestSubmitListDetailDiff` | Design |
| DRAW-5 | Bad input is refused: revision expressions in diffs, unknown runs, broken programs, unknown JSON fields | `TestDiffAndDetail_RejectBadInput`, `TestCompile` | Design |
| DRAW-6 | Every CDN file is pinned to an exact version and its integrity hash matches the npm package | `ci:sri` | A drifting or tampered UI dependency would load silently |
| DRAW-7 | The page and its API metadata are served | `TestPage` | Design |
| DRAW-8 | drawdown never runs programs; Git is reached only through warp, read-only | `TestInv_OnlyWarpRunsGit` | Reuse rule: one writer, through one door |
