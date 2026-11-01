Every invariant below is guarded by a test or a CI step, and CI checks this page against the code on every push with `bash .github/invariants.sh`. Only the **Guarded by** column counts. Each test named there must exist in exactly one package and is run, and the gate fails if it fails or skips; each `ci:NAME` must be a step in `.github/workflows/ci.yml`. Every `TestLaw_*`, `TestInv_*` and `Fuzz*` test must be listed, and no test file may have build tags, which would hide tests from CI. A mistake isn't fixed until it has a row on this page.

[[/images/invariant-loop.svg|alt=From a mistake to a codified invariant: mistake, named invariant, guard, CI gate]]

[[/images/sources.svg|alt=Where drawdown's data comes from: the browser talks to drawdown's API, which compiles with draft, submits through loom, reads Temporal and warp]]

| ID | Invariant | Guarded by | Came from |
|---|---|---|---|
| DRAW-1 | Other websites can't use drawdown: POSTs must be JSON, cross-origin requests and unknown `Host` names are refused | `TestGuard_RefusesCrossSiteAndRebinding` | Review: any page you visited could start runs (CSRF), and DNS rebinding could read results |
| DRAW-2 | The runs list does bounded work: the latest 200 records, programs cached by content-addressed tree ID | `TestList_IsBoundedAndRecordedRowsHaveNoDuration` | Review: 5.8 s per poll at 400 records, polled every 2 s |
| DRAW-3 | Recorded history stays visible when Temporal is down, and Temporal's errors are shown, never swallowed | `TestList_WhenTemporalIsDown_ShowsRecords`, `TestDetail_ReportsTemporalErrorWhenNoRecord` | Review: "no such run" hid "Temporal is down" |
| DRAW-4 | Every endpoint compiles, submits, lists, details and diffs correctly against real runs and real Git records | `TestCompile`, `TestSubmitListDetailDiff` | Design |
| DRAW-5 | Bad input is refused: revision expressions in diffs, unknown runs, broken programs, unknown JSON fields | `TestDiffAndDetail_RejectBadInput`, `TestCompile` | Design |
| DRAW-6 | Every external URL in the page and its script, in any quoting, is a pinned `X.Y.Z` jsDelivr file with an integrity hash that matches the npm package; `app.js` loads nothing external | `ci:sri` | A drifting or tampered UI dependency would load silently; review 3: single-quoted URLs, URLs in `app.js` and loose versions got past the old check |
| DRAW-7 | The page and its API metadata are served | `TestPage` | Design |
| DRAW-8 | drawdown never runs programs or writes history: nothing here starts a process, and the server sees warp only through the read-only `History` interface | `TestInv_OnlyWarpRunsGit`, `TestInv_UIOnlyReadsHistory` | Reuse rule: one writer, through one door; review 3: "read-only" was a convention, not a type |
| DRAW-9 | Every response carries a Content-Security-Policy: scripts only from this server and jsDelivr, requests only to this server, no framing or plugins | `TestPage` | Review 3: integrity hashes protect the CDN files, but nothing limited what the page could load or call |
| DRAW-10 | This page is checked strictly against the code: every listed guard exists once and runs without skipping, every `TestLaw_`, `TestInv_` and `Fuzz` test is listed, and no test file has build tags | `ci:invariants` | Review 3: a reviewer satisfied the old gate with a guard named only in prose, a skipped test and a build-tagged test |
