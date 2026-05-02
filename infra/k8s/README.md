# Tainnel on GKE Autopilot

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
└── 05-grafana.yaml             Grafana Deployment + Service + provisioning ConfigMaps.
```

## Prerequisites

- `gcloud` ≥ 470, `kubectl` ≥ 1.28.
- A GCP project with billing enabled.
- A GKE Autopilot cluster (commands below).
- An Artifact Registry repository for the hub + watchtower images.
- A Cloudflare R2 bucket (or any S3-compatible store) for litestream
  backups, and an HMAC access key + secret pair scoped to that bucket.
- A DNS zone you control for the public hub hostname (default
  `hub.tainnel.dev`).

## One-time setup

### Cluster

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT
gcloud config set compute/region us-central1

gcloud container clusters create-auto tainnel-prod \
  --region us-central1 \
  --release-channel regular

gcloud container clusters get-credentials tainnel-prod --region us-central1
kubectl config current-context  # confirm
```

### Artifact Registry

```bash
gcloud artifacts repositories create tainnel \
  --repository-format=docker \
  --location=us-central1 \
  --description="tainnel images"

gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Release images

Hub and watchtower production images are built by the `gke-images` GitHub
Actions workflow whenever a `v*` tag is pushed. The workflow builds both
Dockerfiles with `INCLUDE_LITESTREAM=1`, pushes versioned images to Artifact
Registry, and uploads a `gke-manifests-${tag}` artifact containing rendered
Kubernetes manifests with exact image references.

Configure these GitHub repository variables before pushing a release tag:

```text
GCP_PROJECT_ID=<your-project-id>
GAR_LOCATION=us-central1
GAR_REPOSITORY=tainnel
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
GCP_SERVICE_ACCOUNT=<service-account>@<project-id>.iam.gserviceaccount.com
```

The service account must be impersonable by the GitHub Workload Identity
provider and must have permission to upload Docker images to the Artifact
Registry repository, for example `roles/artifactregistry.writer` on the
repository.

The source manifests keep placeholder image references. For deployment, use the
rendered manifests from the release artifact so `01-hub.yaml` and
`02-watchtower.yaml` point at immutable `v*-<short_sha>` image tags.

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
LITESTREAM_R2_BUCKET=tainnel-hub-prod
LITESTREAM_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

```dotenv
# .secrets/watchtower-prod.env
WATCHTOWER_PRIVATE_KEY=0x...
RPC_URL=https://rpc.mainnet.taiko.xyz
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
LITESTREAM_R2_BUCKET=tainnel-watchtower-prod
LITESTREAM_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

```dotenv
# .secrets/monitoring-prod.env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<random; rotate after first login>
```

Apply them via the bootstrap script. It refuses to write any value that
matches a known dev key.

```bash
infra/k8s/secrets-bootstrap.sh --service hub        --env-file .secrets/hub-prod.env
infra/k8s/secrets-bootstrap.sh --service watchtower --env-file .secrets/watchtower-prod.env
infra/k8s/secrets-bootstrap.sh --bootstrap-monitoring --env-file .secrets/monitoring-prod.env
```

### 3. Workloads

Download and unpack the `gke-manifests-${tag}` artifact from the release
workflow, then apply those rendered manifests:

```bash
kubectl apply -f gke-manifests/01-hub.yaml
kubectl apply -f gke-manifests/02-watchtower.yaml
kubectl apply -f gke-manifests/03-prometheus.yaml
kubectl apply -f gke-manifests/04-alertmanager.yaml
kubectl apply -f gke-manifests/05-grafana.yaml
```

Watch them come up:

```bash
kubectl get pods -n tainnel -w
```

## Verify

```bash
# Hub: public via Ingress (after ManagedCertificate provisions, ~10–20 min).
kubectl get ingress -n tainnel tainnel-hub
curl -fsS https://hub.tainnel.dev/v1/health

# Watchtower: internal only.
kubectl port-forward -n tainnel statefulset/tainnel-watchtower 3031:3031 &
curl -fsS http://localhost:3031/health

# Prometheus: confirm scrape targets. The watchtower target uses port 3031,
# but hub + watchtower will still report `up==0` until the metrics-binding
# follow-up below is resolved.
kubectl port-forward -n tainnel svc/tainnel-prometheus 9090:9090 &
open http://localhost:9090/targets

# Grafana: log in with the admin password from monitoring-prod.env.
kubectl port-forward -n tainnel svc/tainnel-grafana 3000:3000 &
open http://localhost:3000

# Litestream: confirm a snapshot uploaded to R2.
kubectl logs -n tainnel statefulset/tainnel-hub -c litestream --tail=50
```

## DNS

After `kubectl describe ingress -n tainnel tainnel-hub` reports an
external IP under `Address:`, point your hostname's A record at it. The
ManagedCertificate finishes provisioning a few minutes after DNS
resolves.

## Rollback

Image rollbacks:

```bash
kubectl rollout undo statefulset/tainnel-hub        -n tainnel
kubectl rollout undo statefulset/tainnel-watchtower -n tainnel
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

### 🛑 Metrics binding

Hub + watchtower currently bind their `/metrics` listener to `127.0.0.1`
inside the pod:

- Hub: `apps/hub/src/server.ts:116` — `metricsApp.listen({ port:
  config.prometheusPort, host: '127.0.0.1' })`.
- Watchtower: `apps/watchtower/src/index.ts:239` — `http.listen({ port:
  opts.httpPort ?? 0, host: '127.0.0.1' })`.

Until those bindings are widened, Prometheus running in a sibling pod
will report `up == 0` for both jobs even though the pods are healthy.
Three options:

1. Patch hub + watchtower to bind `::` (or `0.0.0.0`) when an env var
   like `METRICS_BIND_ADDR=::` is set, then redeploy. Cleanest.
2. Run a tiny `socat`-style sidecar in each pod that proxies
   `127.0.0.1:9090` to the pod's eth0 interface.
3. Run an in-pod Prometheus Agent and `remote_write` to a central
   Prometheus or Grafana Cloud.

This is the same gap documented in `infra/fly/README.md` and
`infra/monitoring/README.md`.

### Bucket setup

R2 buckets for litestream should have:

- Server-side encryption AES-256 at the bucket layer.
- 30-day lifecycle policy (matches `retention: 720h` in the litestream
  configs).
- Access key scoped to `PutObject`, `GetObject`, `ListBucket` only.
- Distinct buckets / regions for hub vs watchtower.

### Image tag pinning

The deploy workflow at `.github/workflows/deploy.yml` (Fly path) gates
on `v*` tags. For the GKE path, recommend the same: build images
labelled `vX.Y.Z-<short-sha>` and use that as the StatefulSet image.
Don't deploy from `:latest`.

### Optional add-ons not shipped here

- NetworkPolicy locking pod-to-pod traffic. Autopilot supports them; a
  policy that restricts hub ingress to the GCE LB and the Prometheus
  pod, and watchtower ingress to the Prometheus pod only, is a sane
  next step.
- HorizontalPodAutoscaler. Out of scope for v1 (single-replica
  architecture).
- Backup job that runs `infra/scripts/restore-drill.sh` against staging
  buckets monthly. The Fly path uses GitHub Actions; the same workflow
  works on GKE without changes.
