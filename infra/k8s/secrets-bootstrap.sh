#!/usr/bin/env bash
#
# Stage Kubernetes Secrets for the Tainnel hub, watchtower, or monitoring
# stack from a local .env file. Refuses to apply if any value is a known
# dev key, a placeholder, or empty. Mirrors infra/fly/secrets-bootstrap.sh.
#
# Usage:
#   infra/k8s/secrets-bootstrap.sh --service hub --env-file ./.secrets/hub-prod.env
#   infra/k8s/secrets-bootstrap.sh --service watchtower --env-file ./.secrets/watchtower-prod.env
#   infra/k8s/secrets-bootstrap.sh --bootstrap-monitoring --env-file ./.secrets/monitoring-prod.env
#
# Optional flags:
#   --namespace <name>   default: tainnel (or tainnel-prod, etc.)
#   --allow-non-prod     skip the "namespace must contain 'prod'" guard
#   --kubectl-context    pass through to kubectl

set -euo pipefail

SERVICE=""
ENV_FILE=""
NAMESPACE="tainnel"
ALLOW_NON_PROD=0
BOOTSTRAP_MONITORING=0
KUBECTL_CTX=""

usage() {
  sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --allow-non-prod) ALLOW_NON_PROD=1; shift ;;
    --bootstrap-monitoring) BOOTSTRAP_MONITORING=1; shift ;;
    --kubectl-context) KUBECTL_CTX="--context=$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if [[ "$BOOTSTRAP_MONITORING" -ne 1 ]]; then
  [[ "$SERVICE" == "hub" || "$SERVICE" == "watchtower" ]] || \
    { echo "--service must be hub or watchtower (or use --bootstrap-monitoring)" >&2; usage; }
fi
[[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || { echo "--env-file required and must exist" >&2; usage; }

# Production guard: namespace must contain "prod" unless explicitly overridden.
if [[ "$ALLOW_NON_PROD" -ne 1 && "$NAMESPACE" != *prod* ]]; then
  # The reference manifests use the bare 'tainnel' namespace; allow it without
  # complaint and only block clearly-non-prod names like 'staging' or 'dev'.
  if [[ "$NAMESPACE" != "tainnel" ]]; then
    echo "Refusing to set secrets in non-prod namespace '$NAMESPACE' (use --allow-non-prod to override)" >&2
    exit 1
  fi
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required on PATH" >&2
  exit 1
fi

# Required keys per target. Mirror apps/{hub,watchtower}/src/config-validate.ts.
if [[ "$BOOTSTRAP_MONITORING" -eq 1 ]]; then
  SECRET_NAME="tainnel-monitoring-secrets"
  REQUIRED=(GRAFANA_ADMIN_USER GRAFANA_ADMIN_PASSWORD
            ALERTMANAGER_DEFAULT_WEBHOOK_URL
            ALERTMANAGER_PAGER_WEBHOOK_URL
            ALERTMANAGER_TRIAGE_WEBHOOK_URL)
else
  SECRET_NAME="tainnel-${SERVICE}-secrets"
  case "$SERVICE" in
    hub)
      REQUIRED=(HUB_PRIVATE_KEY RPC_URL HUB_OPERATOR_TOKEN
                LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY
                LITESTREAM_R2_BUCKET LITESTREAM_R2_ENDPOINT)
      ;;
    watchtower)
      REQUIRED=(WATCHTOWER_PRIVATE_KEY RPC_URL
                LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY
                LITESTREAM_R2_BUCKET LITESTREAM_R2_ENDPOINT)
      ;;
  esac
fi

# Known dev keys mirrored from apps/{hub,watchtower}/src/config-validate.ts.
KNOWN_DEV_KEYS=(
  "0x0000000000000000000000000000000000000000000000000000000000000001"
  "0x0000000000000000000000000000000000000000000000000000000000000002"
  "0x0000000000000000000000000000000000000000000000000000000000000003"
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
)

ENV_KEYS=()
ENV_VALUES=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    ENV_KEYS+=("$key")
    ENV_VALUES+=("$val")
  fi
done < "$ENV_FILE"

env_value() {
  local wanted="$1"
  local i
  for ((i=${#ENV_KEYS[@]} - 1; i >= 0; i--)); do
    if [[ "${ENV_KEYS[$i]}" == "$wanted" ]]; then
      printf '%s' "${ENV_VALUES[$i]}"
      return 0
    fi
  done
}

LITERAL_ARGS=()
MISSING=()
for key in "${REQUIRED[@]}"; do
  val="$(env_value "$key")"
  if [[ -z "$val" || "$val" == "<set via secrets>" || "$val" == "TODO" ]]; then
    MISSING+=("$key")
    continue
  fi
  lc_val="$(echo "$val" | tr '[:upper:]' '[:lower:]')"
  for dev in "${KNOWN_DEV_KEYS[@]}"; do
    if [[ "$lc_val" == "$dev" ]]; then
      echo "REFUSING: $key is a known dev key. Generate a fresh production key." >&2
      exit 1
    fi
  done
  LITERAL_ARGS+=("--from-literal=${key}=${val}")
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Missing or placeholder values for: ${MISSING[*]}" >&2
  exit 1
fi

# Ensure the namespace exists (idempotent).
kubectl ${KUBECTL_CTX:-} get namespace "$NAMESPACE" >/dev/null 2>&1 || \
  kubectl ${KUBECTL_CTX:-} create namespace "$NAMESPACE"

echo "Applying Secret $SECRET_NAME to namespace $NAMESPACE (${#LITERAL_ARGS[@]} keys)..."
kubectl ${KUBECTL_CTX:-} create secret generic "$SECRET_NAME" \
  --namespace "$NAMESPACE" \
  "${LITERAL_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl ${KUBECTL_CTX:-} apply -f -

echo "Done. Verify with:"
echo "  kubectl ${KUBECTL_CTX:-} get secret $SECRET_NAME -n $NAMESPACE -o json | jq '.data | keys'"
