#!/usr/bin/env bash
#
# Fail if Kubernetes manifests introduce unreviewed image references.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K8S_DIR="$ROOT_DIR/infra/k8s"

allowed_pattern='^(REGION-docker\.pkg\.dev/PROJECT/pico/(hub|watchtower):VERSION|litestream/litestream:0\.3\.13|prom/prometheus:v2\.54\.1|prom/alertmanager:v0\.32\.1|grafana/grafana:10\.4\.5)$'
failed=0

while IFS= read -r manifest; do
  while IFS=: read -r line_no image; do
    [[ -n "$image" ]] || continue
    if [[ ! "$image" =~ $allowed_pattern ]]; then
      printf 'Unapproved image reference in %s:%s: %s\n' "${manifest#$ROOT_DIR/}" "$line_no" "$image" >&2
      failed=1
    fi
  done < <(
    awk '
      /^[[:space:]]*image:[[:space:]]*/ {
        value=$0
        sub(/^[[:space:]]*image:[[:space:]]*/, "", value)
        sub(/[[:space:]]+#.*/, "", value)
        gsub(/^["'\'']|["'\'']$/, "", value)
        print FNR ":" value
      }
    ' "$manifest"
  )
done < <(find "$K8S_DIR" -maxdepth 1 -type f -name '*.yaml' | sort)

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Kubernetes image references are approved."
