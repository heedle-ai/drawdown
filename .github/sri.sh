#!/usr/bin/env bash
# Recomputes the Subresource Integrity hash of every CDN file in
# static/index.html from its npm package, and fails if any differs or any
# external file is loaded without one. jsDelivr's /npm/ URLs serve npm
# package files byte for byte, so the hashes must match exactly.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0
n=0
while read -r url sri; do
  [ "$url" = BAD ] && { fail=1; continue; }  # the scan below already said why
  if [[ ! $url =~ ^https://cdn\.jsdelivr\.net/npm/((@[^/]+/)?[^@/]+)@([^/]+)/(.*)$ ]]; then
    echo "sri: $url is not a pinned jsDelivr npm URL" >&2; fail=1; continue
  fi
  pkg=${BASH_REMATCH[1]} ver=${BASH_REMATCH[3]} path=${BASH_REMATCH[4]}
  dir="$work/$pkg@$ver"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    (cd "$dir" && npm pack --silent "$pkg@$ver" >/dev/null && tar -xzf ./*.tgz)
  fi
  got="sha384-$(openssl dgst -sha384 -binary "$dir/package/$path" | base64 | tr -d '\n')"
  if [ "$got" != "$sri" ]; then
    echo "sri: $url: page has $sri, npm package gives $got" >&2; fail=1
  fi
  n=$((n + 1))
done < <(python3 - <<'PY'
import re, sys
# Every external URL in the page or its script, in any quoting, must be a
# <script src> or <link href> in index.html that carries an integrity hash
# and pins an exact x.y.z version. app.js may load nothing external.
html = open("static/index.html").read()
js = open("static/app.js").read()
url = re.compile(r"(?:https?:)?//[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s\"'`<>)]*")
tagged = {}
for tag in re.findall(r"<(?:script|link)\b[^>]*>", html):
    m = re.search(r"\b(?:src|href)\s*=\s*[\"']?((?:https?:)?//[^\"'\s>]+)", tag)
    if m:
        sri = re.search(r"\bintegrity\s*=\s*[\"']?([^\"'\s>]+)", tag)
        tagged[m.group(1)] = sri.group(1) if sri else "MISSING"
bad = False
for u in url.findall(html):
    if u not in tagged and not u.startswith("http://www.w3.org/"):
        print(f"sri: {u} is loaded or linked outside a <script>/<link> with integrity", file=sys.stderr); bad = True
for u in url.findall(js):
    print(f"sri: app.js refers to {u}; load external code only from index.html, with integrity", file=sys.stderr); bad = True
for u, sri in tagged.items():
    if not re.match(r"^https://cdn\.jsdelivr\.net/npm/(@[^/]+/)?[^@/]+@\d+\.\d+\.\d+/", u):
        print(f"sri: {u} must be https://cdn.jsdelivr.net/npm/PKG@X.Y.Z/... (an exact version)", file=sys.stderr); bad = True
    print(u, sri)
if bad:
    print("BAD BAD")
PY
)
[ "$fail" = 0 ] && echo "sri: $n CDN files match their npm packages"
exit "$fail"
