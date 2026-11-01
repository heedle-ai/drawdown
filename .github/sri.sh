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
done < <(python3 -c '
import re
html = open("static/index.html").read()
for tag in re.findall(r"<(?:script|link)\b[^>]*>", html):
    url = re.search(r"(?:src|href)=\"(https?://[^\"]+)\"", tag)
    if url:
        sri = re.search(r"integrity=\"([^\"]+)\"", tag)
        print(url.group(1), sri.group(1) if sri else "MISSING")
')
[ "$fail" = 0 ] && echo "sri: $n CDN files match their npm packages"
exit "$fail"
