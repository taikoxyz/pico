#!/usr/bin/env bash
#
# Stage Fly secrets for the Pico hub or watchtower from a local .env file
# and apply them in a single atomic deploy. Refuses to run if any value is a
# known dev key, a placeholder, or empty.
#
# Usage:
#   infra/fly/secrets-bootstrap.sh --service hub --env-file ./hub.env [--app pico-hub-prod] [--allow-non-prod]
#   infra/fly/secrets-bootstrap.sh --service watchtower --env-file ./wt.env [--app pico-watchtower-prod] [--allow-non-prod]

set -euo pipefail

SERVICE=""
ENV_FILE=""
APP=""
ALLOW_NON_PROD=0

usage() {
  sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --allow-non-prod) ALLOW_NON_PROD=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[[ "$SERVICE" == "hub" || "$SERVICE" == "watchtower" ]] || { echo "--service must be hub or watchtower" >&2; exit 1; }
[[ -n "$ENV_FILE" && -f "$ENV_FILE" ]] || { echo "--env-file required and must exist" >&2; exit 1; }

if [[ -z "$APP" ]]; then
  APP="pico-${SERVICE}-prod"
fi

if [[ "$ALLOW_NON_PROD" -ne 1 && "$APP" != *prod* ]]; then
  echo "Refusing to set secrets on non-prod app '$APP' (use --allow-non-prod to override)" >&2
  exit 1
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not on PATH. Install: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

# Required keys per service. Mirrors apps/${SERVICE}/src/config-validate.ts.
case "$SERVICE" in
  hub)
    REQUIRED=(HUB_PRIVATE_KEY RPC_URL HUB_OPERATOR_TOKEN LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY LITESTREAM_R2_BUCKET LITESTREAM_R2_ENDPOINT)
    ;;
  watchtower)
    REQUIRED=(WATCHTOWER_PRIVATE_KEY RPC_URL)
    ;;
esac

# Known dev keys mirrored from apps/{hub,watchtower}/src/config-validate.ts.
# Any of these in any value aborts the bootstrap.
KNOWN_DEV_KEYS=(
  "0x0000000000000000000000000000000000000000000000000000000000000001"
  "0x0000000000000000000000000000000000000000000000000000000000000002"
  "0x0000000000000000000000000000000000000000000000000000000000000003"
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
)

declare -A ENV_KV
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    ENV_KV["$key"]="$val"
  fi
done < "$ENV_FILE"

ARGS=()
MISSING=()
for key in "${REQUIRED[@]}"; do
  val="${ENV_KV[$key]:-}"
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
  ARGS+=("${key}=${val}")
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Missing or placeholder values for: ${MISSING[*]}" >&2
  exit 1
fi

echo "Staging ${#ARGS[@]} secrets for app $APP..."
flyctl secrets set --app "$APP" --stage "${ARGS[@]}"
echo "Deploying staged secrets..."
flyctl secrets deploy --app "$APP"
echo "Done. Verify with: flyctl secrets list --app $APP"
