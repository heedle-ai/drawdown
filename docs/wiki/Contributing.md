## Ground rules

- **Reuse, never rewrite.** The server composes draft, loom, Temporal's SDK and warp; the page uses React, htm, diff2html and CodeMirror unmodified. If something seems to need modifying one of them, stop and ask first.
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

The browser tests need Playwright 1.63.0 and its Chromium (Node 22, Go):

```bash
npm install --no-save --prefix /tmp/pw playwright@1.63.0
/tmp/pw/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/pw/node_modules node --test ui/browser.test.js
```
