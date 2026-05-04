# Pico on GKE Autopilot

Production manifests for hub + watchtower + the monitoring stack
(Prometheus + Grafana + Alertmanager) on Google Kubernetes Engine
**Autopilot**. Mirrors the workload shape of `infra/fly/` with the
litestream sidecar pattern, the `infra/monitoring/` Prometheus + alert
rules, and the same `KNOWN_DEV_PRIVATE_KEYS` rejection at secrets-bootstrap
time.

Single replica per workload. Single region. Public TLS via the GCE
Ingress + ManagedCertificate. Backups via litestream to Cloudflare R2.

## Layout

```
infra/k8s/
├── README.md                   This file.
├── secrets-bootstrap.sh        .env → kubectl Secret. Refuses known dev keys.
├── 00-namespace.yaml           Namespace + LimitRange.
├── 01-hub.yaml                 Hub StatefulSet + Service + Ingress + ManagedCertificate.
├── 02-watchtower.yaml          Watchtower StatefulSet + headless Service (no public surface).
├── 03-prometheus.yaml          Prometheus StatefulSet + Service + scrape/alert ConfigMap.
├── 04-alertmanager.yaml        Alertmanager Deployment + Service + ConfigMap.
├── 05-grafana.yaml             Grafana Deployment + Service + provisioning ConfigMaps.
└── 06-networkpolicy.yaml       Default-deny NetworkPolicy + documented traffic flows.
```

## Prerequisites

- `gcloud` ≥ 470, `kubectl` ≥ 1.28.
- A GCP project with billing enabled.
- A GKE Autopilot cluster (commands below).
- An Artifact Registry repository for the hub + watchtower images.
- A Cloudflare R2 bucket (or any S3-compatible store) for litestream
  backups, and an HMAC access key + secret pair scoped to that bucket.
- A DNS zone you control for the public hub hostname (default
  `pico.taiko.xyz`).

## One-time setup

### Cluster

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT
gcloud config set compute/region us-central1

gcloud container clusters create-auto pico-prod \
  --region us-central1 \
  --release-channel regular

gcloud container clusters get-credentials pico-prod --region us-central1
kubectl config current-context  # confirm
```

### Artifact Registry

```bash
gcloud artifacts repositories create pico \
  --repository-format=docker \
  --location=us-central1 \
  --description="pico images"

gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Release images and deploy

Hub and watchtower production images are built by the `gke-images` GitHub
Actions workflow whenever a `v*` tag is pushed. The workflow builds both
Dockerfiles with `INCLUDE_LITESTREAM=1`, pushes versioned images to Artifact
Registry, and uploads a `gke-manifests-${tag}` artifact containing rendered
Kubernetes manifests with exact image references. After the image push
succeeds, it calls `.github/workflows/deploy.yml` to apply those manifests to
GKE and verify the rollout.

Configure these GitHub repository variables before pushing a release tag:

```text
GCP_PROJECT_ID=<your-project-id>
GAR_LOCATION=us-central1
GAR_REPOSITORY=pico
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
GCP_SERVICE_ACCOUNT=<service-account>@<project-id>.iam.gserviceaccount.com
GKE_CLUSTER=pico-prod
GKE_LOCATION=us-central1
GKE_NAMESPACE=pico                 # optional; defaults to pico
```

The service account must be impersonable by the GitHub Workload Identity
provider. It needs permission to upload Docker images to Artifact Registry
(for example `roles/artifactregistry.writer` on the repository), read the GKE
cluster (`roles/container.clusterViewer`), and apply resources in the target
Kubernetes namespace. Bind Kubernetes RBAC to the Google service account before
the first automated deploy.

The deploy workflow uses GitHub `environment: production`, so configure the
environment's required reviewers/protection rules in repository settings if a
human approval gate is required. The source manifests keep placeholder image
references; `infra/k8s/render-manifests.sh` renders immutable
`v*-<short_sha>` image tags at deploy time.
CI runs `infra/k8s/lint-images.sh` to ensure only the approved placeholders
and pinned third-party images appear in source manifests.

## Deploy

### 1. Namespace

```bash
kubectl apply -f infra/k8s/00-namespace.yaml
```

### 2. Secrets

Create three local `.env` files (do **not** commit them) with the
values per `apps/{hub,watchtower}/src/config-validate.ts`:

```dotenv
# .secrets/hub-prod.env
HUB_PRIVATE_KEY=0x...                # not in KNOWN_DEV_PRIVATE_KEYS
RPC_URL=https://rpc.mainnet.taiko.xyz
HUB_OPERATOR_TOKEN=...
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
LITESTREAM_R2_BUCKET=pico-hub-prod
LITESTREAM_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

```dotenv
# .secrets/watchtower-prod.env
WATCHTOWER_PRIVATE_KEY=0x...
RPC_URL=https://rpc.mainnet.taiko.xyz
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
LITESTREAM_R2_BUCKET=pico-watchtower-prod
LITESTREAM_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

```dotenv
# .secrets/monitoring-prod.env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<random; rotate after first login>
ALERTMANAGER_DEFAULT_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERTMANAGER_PAGER_WEBHOOK_URL=https://events.pagerduty.com/...
ALERTMANAGER_TRIAGE_WEBHOOK_URL=https://api.linear.app/...
```

Apply them via the bootstrap script. It refuses to write any value that
matches a known dev key.

```bash
infra/k8s/secrets-bootstrap.sh --service hub        --env-file .secrets/hub-prod.env
infra/k8s/secrets-bootstrap.sh --service watchtower --env-file .secrets/watchtower-prod.env
infra/k8s/secrets-bootstrap.sh --bootstrap-monitoring --env-file .secrets/monitoring-prod.env
```

### 3. Workloads

Normal deploys are automatic: push a `v*` tag, wait for the `gke-images`
workflow to push images, then approve the `production` environment deployment
if protection rules are enabled.

To redeploy an existing release tag, run the `deploy` GitHub Action manually
with `release_tag=vX.Y.Z`. It derives the exact `vX.Y.Z-<short_sha>` image
references, verifies they exist in Artifact Registry, applies manifests, and
checks rollouts and health endpoints.

For emergency local deploys, render exact image references and apply them:

```bash
infra/k8s/render-manifests.sh \
  --hub-image us-central1-docker.pkg.dev/YOUR_PROJECT/pico/hub:vX.Y.Z-abc123def456 \
  --watchtower-image us-central1-docker.pkg.dev/YOUR_PROJECT/pico/watchtower:vX.Y.Z-abc123def456 \
  --out-dir .context/gke-manifests

kubectl apply -f .context/gke-manifests/00-namespace.yaml
kubectl apply -f .context/gke-manifests/01-hub.yaml
kubectl apply -f .context/gke-manifests/02-watchtower.yaml
kubectl apply -f .context/gke-manifests/03-prometheus.yaml
kubectl apply -f .context/gke-manifests/04-alertmanager.yaml
kubectl apply -f .context/gke-manifests/05-grafana.yaml
kubectl apply -f .context/gke-manifests/06-networkpolicy.yaml
```

Watch them come up:

```bash
kubectl get pods -n pico -w
```

## Verify

```bash
# Hub: public via Ingress (after ManagedCertificate provisions, ~10–20 min).
kubectl get ingress -n pico pico-hub
curl -fsS https://pico.taiko.xyz/v1/health

# Watchtower: internal only.
kubectl port-forward -n pico statefulset/pico-watchtower 3031:3031 &
curl -fsS http://localhost:3031/health

# Prometheus: confirm hub + watchtower scrape targets are up.
kubectl port-forward -n pico svc/pico-prometheus 9090:9090 &
open http://localhost:9090/targets

# Grafana: log in with the admin password from monitoring-prod.env.
kubectl port-forward -n pico svc/pico-grafana 3000:3000 &
open http://localhost:3000

# Litestream: confirm a snapshot uploaded to R2.
kubectl logs -n pico statefulset/pico-hub -c litestream --tail=50
```

## NetworkPolicy

`06-networkpolicy.yaml` applies default deny ingress and egress to the
`pico` namespace, then allows only the production traffic flows:

- All pods can resolve DNS through kube-dns on TCP/UDP 53.
- GCE load balancer and health check ranges can reach hub HTTP on `3030`.
- Prometheus can scrape hub `9090`, watchtower `3031`, and send alerts to
  Alertmanager `9093`.
- Grafana can query Prometheus on `9090`.
- Hub, watchtower, and Alertmanager can make outbound HTTPS calls on `443`
  for Taiko RPC, R2 backups, and on-call webhook delivery.

## DNS

After `kubectl describe ingress -n pico pico-hub` reports an
external IP under `Address:`, point your hostname's A record at it. The
ManagedCertificate finishes provisioning a few minutes after DNS
resolves.

## Rollback

Image rollbacks:

```bash
kubectl rollout undo statefulset/pico-hub        -n pico
kubectl rollout undo statefulset/pico-watchtower -n pico
```

Manifest rollbacks: re-apply the previous file revision via git.

## Cost note

A rough monthly estimate before traffic, on Autopilot in `us-central1`:

- Hub StatefulSet (app + litestream): ~$8/mo (CPU + memory requests).
- Watchtower StatefulSet: ~$8/mo.
- Prometheus + Alertmanager + Grafana: ~$13/mo.
- Persistent disks (10Gi + 5Gi + 20Gi pd-balanced): ~$5/mo.
- GCE LoadBalancer + Ingress: ~$18/mo.
- **Total: ~$50/mo** before egress / R2 storage.

You can cut the LoadBalancer cost by exposing the hub via Cloud Run for
Anthos or Cloudflare Tunnel instead, but those paths are out of scope
for these manifests.

## Follow-ups

### Bucket setup

R2 buckets for litestream should have:

- Server-side encryption AES-256 at the bucket layer.
- 30-day lifecycle policy (matches `retention: 720h` in the litestream
  configs).
- Access key scoped to `PutObject`, `GetObject`, `ListBucket` only.
- Distinct buckets / regions for hub vs watchtower.

### Image tag pinning

The GKE image and deploy workflows gate on `v*` tags, build images labelled
`vX.Y.Z-<short-sha>`, and verify the StatefulSets are running those exact
references. Don't deploy from `:latest`.

### Optional add-ons not shipped here

- HorizontalPodAutoscaler. Out of scope for v1 (single-replica
  architecture).
- Backup job that runs `infra/scripts/restore-drill.sh` against staging
  buckets monthly. The Fly path uses GitHub Actions; the same workflow
  works on GKE without changes.
