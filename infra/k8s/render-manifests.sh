#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: render-manifests.sh --hub-image IMAGE --watchtower-image IMAGE [--namespace NAME] [--out-dir DIR]

Renders the GKE manifests with exact Artifact Registry image references.
USAGE
}

OUT_DIR=".context/gke-manifests"
HUB_IMAGE=""
WATCHTOWER_IMAGE=""
NAMESPACE="tainnel"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-image)
      HUB_IMAGE="${2:-}"
      shift 2
      ;;
    --watchtower-image)
      WATCHTOWER_IMAGE="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$HUB_IMAGE" ]]; then
  echo "--hub-image is required" >&2
  exit 2
fi

if [[ -z "$WATCHTOWER_IMAGE" ]]; then
  echo "--watchtower-image is required" >&2
  exit 2
fi

if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "--namespace must be a valid Kubernetes namespace name" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

sed \
  -e "s|name: tainnel$|name: $NAMESPACE|g" \
  -e "s|namespace: tainnel$|namespace: $NAMESPACE|g" \
  "$SCRIPT_DIR/00-namespace.yaml" > "$OUT_DIR/00-namespace.yaml"
sed \
  "s|REGION-docker.pkg.dev/PROJECT/tainnel/hub:VERSION|$HUB_IMAGE|g" \
  "$SCRIPT_DIR/01-hub.yaml" \
  | sed \
      -e "s|namespace: tainnel$|namespace: $NAMESPACE|g" \
      -e "s|\\.tainnel\\.svc|.$NAMESPACE.svc|g" \
    > "$OUT_DIR/01-hub.yaml"
sed \
  "s|REGION-docker.pkg.dev/PROJECT/tainnel/watchtower:VERSION|$WATCHTOWER_IMAGE|g" \
  "$SCRIPT_DIR/02-watchtower.yaml" \
  | sed \
      -e "s|namespace: tainnel$|namespace: $NAMESPACE|g" \
      -e "s|\\.tainnel\\.svc|.$NAMESPACE.svc|g" \
    > "$OUT_DIR/02-watchtower.yaml"
for manifest in 03-prometheus.yaml 04-alertmanager.yaml 05-grafana.yaml 06-networkpolicy.yaml; do
  sed \
    -e "s|namespace: tainnel$|namespace: $NAMESPACE|g" \
    -e "s|\\.tainnel\\.svc|.$NAMESPACE.svc|g" \
    "$SCRIPT_DIR/$manifest" > "$OUT_DIR/$manifest"
done

if grep -R "REGION-docker.pkg.dev/PROJECT/tainnel" "$OUT_DIR"; then
  echo "Rendered manifests still contain image placeholders." >&2
  exit 1
fi

echo "Rendered GKE manifests to $OUT_DIR"
