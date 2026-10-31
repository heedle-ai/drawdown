**drawdown** will be heddle's UI: a way to see what the system knows and how it came to know it.

> **Status: Planned.** No code yet, and no stack has been chosen. When one is, the decision and the reasons for it will be recorded here.

## Scope

| View | Shows |
|---|---|
| Refs and history | Branches, and the commit graph behind each one |
| Commit | Root tree, inputs and outputs, and a link to the Temporal execution that produced it |
| Diff | What changed between two commits: evidence, claims and outcomes, not just text |
| Provenance | Trace any conclusion back to its sources, and see which conclusions depend on a source |

## Out of scope

- **Execution details** (retries, timings, event history). Temporal's Web UI already shows these, so drawdown links to it rather than rebuilding it.
- **Writing to warp.** drawdown starts read-only. Changes like promoting a ref or resolving a merge go through shuttle workflows, so they're recorded and can be retried.

## Depends on

- [warp](https://github.com/heedle-ai/warp/wiki) milestone 1 (the store) for anything to show
- [warp](https://github.com/heedle-ai/warp/wiki) milestone 3 (provenance) for the provenance view
