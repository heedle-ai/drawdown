## Ground rules

- **Reuse, never rewrite.** The server composes draft, loom, Temporal's SDK and warp; the page uses React, htm and diff2html unmodified. If something seems to need modifying one of them, stop and ask first.
- **Read and submit only.** No endpoint edits history.
- **No unescaped data in HTML.** Let React render text, the graphs included; never set HTML from data.
- **Pin and hash every CDN file.** To upgrade one, change the version in `static/index.html` and recompute its hash from the npm package file:

  ```bash
  npm pack react@18.3.1 && tar -xzf react-18.3.1.tgz
  openssl dgst -sha384 -binary package/umd/react.production.min.js | base64
  ```

  `bash .github/sri.sh` checks every file this way, and runs in CI. It also finds every external URL in `index.html` and `app.js`, however it's quoted, and fails unless it's a `<script>` or `<link>` with an integrity hash and an exact `X.Y.Z` version. `app.js` may not refer to any external URL.

- **A mistake isn't fixed until it has a row on [Invariants](Invariants)** and a guard that fails on the old code. CI checks the page against the tests in both directions.
- **Update this wiki in the same change.** The pages live in `docs/wiki/` and publish on every push to `main`.
- Supported platforms are Linux (amd64, arm64) and macOS on Apple Silicon.

## Before opening a pull request

```bash
gofmt -l .        # prints nothing
go vet ./...
go test -race ./...
bash .github/invariants.sh
bash .github/sri.sh
node --test ui/lib.test.js
```

The top bar's check (CI's `topbar` step) opens the page in Chromium, so it needs Node 22 and Playwright 1.63 with its Chromium. It serves the page's files itself, takes the CDN files from their npm packages and answers the API from its own fixtures, so it needs no server:

```bash
npm install --no-save --no-audit --no-fund --prefix ~/.cache/drawdown-playwright playwright@1.63.0
~/.cache/drawdown-playwright/node_modules/.bin/playwright install chromium
NODE_PATH=~/.cache/drawdown-playwright/node_modules node ui/topbar.check.js
```

Give it a directory (`node ui/topbar.check.js shots`) to save its screenshots: the home page and a review, at 375 and 1280 px, light and dark.
