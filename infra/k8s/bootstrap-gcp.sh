#!/usr/bin/env bash
#
# One-time GCP bootstrap for Pico production: enables APIs, creates the
# Artifact Registry repo, the GKE Autopilot cluster, the GitHub Actions
# deployer service account, the Workload Identity Federation pool +
# provider, and sets the GitHub repo variables that gke-images.yml /
# deploy.yml validate at the start of every run.
#
# Idempotent: every step checks for existence first and skips if already
# present. Safe to re-run.
#
# Usage:
#   infra/k8s/bootstrap-gcp.sh           # apply
#   infra/k8s/bootstrap-gcp.sh --dry-run # print commands without running
#
# Env overrides (defaults match the production decisions in #58):
#   GCP_PROJECT_ID  default: pico-mainnet
#   REGION          default: asia-southeast1
#   CLUSTER_NAME    default: pico-prod
#   GAR_REPO        default: pico
#   SA_NAME         default: gha-pico-deployer
#   WIF_POOL        default: gha-pool
#   WIF_PROVIDER    default: gha-github
#   GITHUB_REPO     default: dantaik/pico

set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-pico-mainnet}"
REGION="${REGION:-asia-southeast1}"
CLUSTER_NAME="${CLUSTER_NAME:-pico-prod}"
GAR_REPO="${GAR_REPO:-pico}"
SA_NAME="${SA_NAME:-gha-pico-deployer}"
WIF_POOL="${WIF_POOL:-gha-pool}"
WIF_PROVIDER="${WIF_PROVIDER:-gha-github}"
GITHUB_REPO="${GITHUB_REPO:-dantaik/pico}"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency: $1" >&2
    exit 1
  }
}

require gcloud
require gh
require kubectl

if [[ "${GCP_PROJECT_ID}" != "pico-mainnet" ]]; then
  echo "refusing to run: GCP_PROJECT_ID must be 'pico-mainnet' (got '${GCP_PROJECT_ID}')." >&2
  echo "to override, set ALLOW_NON_PICO_MAINNET=1." >&2
  if [[ "${ALLOW_NON_PICO_MAINNET:-0}" != "1" ]]; then
    exit 2
  fi
fi

echo "Project: ${GCP_PROJECT_ID}"
echo "Region:  ${REGION}"
echo "Cluster: ${CLUSTER_NAME} (Autopilot)"
echo "GAR:     ${GAR_REPO}"
echo "SA:      ${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
echo "GitHub:  ${GITHUB_REPO}"
echo

gcloud projects describe "${GCP_PROJECT_ID}" >/dev/null

echo "==> 1/8 Enable APIs"
run gcloud services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  dns.googleapis.com \
  --project "${GCP_PROJECT_ID}"

echo "==> 2/8 Artifact Registry repo"
if gcloud artifacts repositories describe "${GAR_REPO}" \
  --location "${REGION}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists"
else
  run gcloud artifacts repositories create "${GAR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Pico hub + watchtower images" \
    --project "${GCP_PROJECT_ID}"
fi

echo "==> 3/8 GKE Autopilot cluster"
if gcloud container clusters describe "${CLUSTER_NAME}" \
  --region "${REGION}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists"
else
  run gcloud container clusters create-auto "${CLUSTER_NAME}" \
    --region="${REGION}" \
    --release-channel=regular \
    --project "${GCP_PROJECT_ID}"
fi

SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo "==> 4/8 Deployer service account"
if gcloud iam service-accounts describe "${SA_EMAIL}" \
  --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists"
else
  run gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="GitHub Actions deployer for Pico" \
    --project "${GCP_PROJECT_ID}"
fi

echo "==> 5/8 IAM roles on project"
for role in \
  roles/artifactregistry.writer \
  roles/container.developer \
  roles/container.viewer
do
  run gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" \
    --condition=None >/dev/null
done

echo "==> 6/8 Workload Identity Federation pool + provider"
if gcloud iam workload-identity-pools describe "${WIF_POOL}" \
  --location=global --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "  pool already exists"
else
  run gcloud iam workload-identity-pools create "${WIF_POOL}" \
    --location=global \
    --display-name="GitHub Actions pool" \
    --project "${GCP_PROJECT_ID}"
fi

if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
  --location=global --workload-identity-pool="${WIF_POOL}" \
  --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "  provider already exists"
else
  run gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --location=global \
    --workload-identity-pool="${WIF_POOL}" \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
    --project "${GCP_PROJECT_ID}"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  POOL_RESOURCE="projects/<project-number>/locations/global/workloadIdentityPools/${WIF_POOL}"
else
  POOL_RESOURCE=$(gcloud iam workload-identity-pools describe "${WIF_POOL}" \
    --location=global --project "${GCP_PROJECT_ID}" --format='value(name)')
fi
PROVIDER_RESOURCE="${POOL_RESOURCE}/providers/${WIF_PROVIDER}"

run gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_RESOURCE}/attribute.repository/${GITHUB_REPO}" \
  --project "${GCP_PROJECT_ID}" >/dev/null

echo "==> 7/8 GitHub repo variables"
run gh variable set GCP_PROJECT_ID                 -R "${GITHUB_REPO}" -b "${GCP_PROJECT_ID}"
run gh variable set GAR_LOCATION                   -R "${GITHUB_REPO}" -b "${REGION}"
run gh variable set GAR_REPOSITORY                 -R "${GITHUB_REPO}" -b "${GAR_REPO}"
run gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER -R "${GITHUB_REPO}" -b "${PROVIDER_RESOURCE}"
run gh variable set GCP_SERVICE_ACCOUNT            -R "${GITHUB_REPO}" -b "${SA_EMAIL}"
run gh variable set GKE_CLUSTER                    -R "${GITHUB_REPO}" -b "${CLUSTER_NAME}"
run gh variable set GKE_LOCATION                   -R "${GITHUB_REPO}" -b "${REGION}"

echo "==> 8/8 Apply base manifests"
run gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --region "${REGION}" --project "${GCP_PROJECT_ID}"
run kubectl apply -f infra/k8s/00-namespace.yaml
run kubectl apply -f infra/k8s/06-networkpolicy.yaml

echo
echo "Done. Verify with:"
echo "  gh variable list -R ${GITHUB_REPO}"
echo "  kubectl get ns pico"
echo "  gcloud container clusters describe ${CLUSTER_NAME} --region ${REGION} --project ${GCP_PROJECT_ID} --format='value(status)'"
