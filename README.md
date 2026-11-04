# drawdown

heedle-ai's web UI. Write a draft program, run it on Temporal through loom, and browse every run's record in warp: composition graphs, outputs, and diffs between runs.

```bash
temporal server start-dev                          # terminal 1
go run ./cmd/drawdown -store ~/heedle-store.git    # terminal 2, then open http://127.0.0.1:8090
```

A small Go JSON API over draft, loom, Temporal and warp, plus one page: React from a CDN with htm, diff2html and CodeMirror. No build step.

Documentation: **[wiki](https://github.com/heedle-ai/drawdown/wiki)**
