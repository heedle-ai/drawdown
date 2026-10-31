## Ground rules

- **Reuse, never rewrite.** The server composes draft, loom, Temporal's SDK and warp; the page uses React, htm, mermaid and diff2html unmodified. If something seems to need modifying one of them, stop and ask first.
- **Read and submit only.** No endpoint edits history.
- **No unescaped data in HTML.** Let React render text; keep mermaid's `securityLevel: "strict"`.
- **Pin and hash every CDN file.** To upgrade one, change the version in `static/index.html` and recompute its hash from the npm package file:

  ```bash
  npm pack react@18.3.1 && tar -xzf react-18.3.1.tgz
  openssl dgst -sha384 -binary package/umd/react.production.min.js | base64
  ```

- **Update this wiki in the same change.** The pages live in `docs/wiki/` and publish on every push to `main`.
- Supported platforms are Linux (amd64, arm64) and macOS on Apple Silicon.

## Before opening a pull request

```bash
gofmt -l .        # prints nothing
go vet ./...
go test -race ./...
```
