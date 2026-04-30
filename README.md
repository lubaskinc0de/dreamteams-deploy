# DreamTeams Deploy

Kubernetes/GitOps configuration for DreamTeams.

## Stack

- Frontend: static Nuxt image served by nginx.
- Backend: 2 API replicas.
- Exporter: 2 API replicas and 2 worker replicas.
- Infrastructure: Postgres, PgBouncer, Redis, NATS JetStream, RustFS, Authentik, oauth2-proxy, cert-manager, Traefik.
- Observability: Grafana, Prometheus, Loki, Tempo, OpenTelemetry Collector, Vector, node-exporter.

ArgoCD app manifests are split by environment:

- `apps/local/` applies plaintext local-only secrets and self-signed certificates.
- `apps/prod/` applies SealedSecrets and a Let’s Encrypt issuer.

The local profile uses registry images and self-signed cert-manager certificates. Production uses pinned registry images, SealedSecrets, and a Let’s Encrypt ClusterIssuer.

## Local K3S

Prerequisites:

- K3S with Traefik enabled.
- kubectl, helm, argocd CLI, just.
- ArgoCD installed in the `argocd` namespace.

Install ArgoCD if needed:

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd argo/argo-cd -n argocd --create-namespace \
  --set server.service.type=LoadBalancer --wait
```

Apply the local app set:

```bash
just local-k3s-up
just argocd-login
just local-sync
```

Local hosts:

- `https://dreamteams.localhost`
- `https://s3.dreamteams.localhost`
- `https://auth.dreamteams.localhost/if/flow/initial-setup/`
- `https://grafana.dreamteams.localhost`

The local issuer is self-signed, so browser warnings and `curl -k` are expected. If your resolver does not handle nested `.localhost` names, add these to `/etc/hosts`:

```text
127.0.0.1 dreamteams.localhost s3.dreamteams.localhost auth.dreamteams.localhost grafana.dreamteams.localhost
```

Local secrets live in `local/secrets.yaml` and are intentionally fake. The local Authentik chart mounts a blueprint that creates the DreamTeams OIDC provider/application with matching local oauth2-proxy credentials.

For local images imported directly into K3S/containerd, override the relevant Helm values in the local ArgoCD app:

- API, migrations, exporter: `image.repository`, `image.tag`, `image.pullPolicy`.
- Frontend: `image.repository`, `image.tag`, `image.pullPolicy`.

The frontend is static and reads public runtime settings from `/config.js`. For these ingress rules, same-origin works best: API traffic is expected under `/api`, oauth2-proxy under `/oauth2`, avatar objects under `/s3`, and signed exporter downloads under the dedicated S3 host.

If you reuse an old local PVC, Postgres init scripts will not run again. Delete the local DreamTeams PVCs before a clean re-test.

The existing Docker Compose observability sandbox is still available for non-K3S local runs:

```bash
just observe
SUPERUSER_PASSWORD=asd123321 just demo-traffic
```

Observability config ownership:

- Docker and K3S share `observability/prometheus.yml`, `observability/loki.yaml`, `observability/tempo.yaml`, `observability/otel-collector.yaml`, and Grafana datasources/dashboards.
- Vector is environment-specific: Docker Compose uses `observability/vector.docker.yaml`, while K3S uses `observability/vector.kubernetes.yaml`.

## Production

Before production deploy, update:

- `apps/prod/ingress.yaml`: replace `dreamteams.example.com`, `s3.dreamteams.example.com`, `auth.dreamteams.example.com`, and `grafana.dreamteams.example.com`.
- `apps/prod/oauth2proxy.yaml`: replace the same hostnames in the oauth2-proxy config block.
- SealedSecrets under `sealed-secrets/prod/` for every secret in `local/secrets.yaml`, with production values and namespaces preserved.

Production secret names expected by the charts:

- `dreamteams-api-config`
- `dreamteams-exporter-config`
- `dreamteams-migrations-config`
- `dreamteams-postgres-secret`
- `dreamteams-postgres-initdb`
- `dreamteams-pgbouncer-secret`
- `dreamteams-rustfs-secret`
- `dreamteams-oauth2proxy-secret`
- `authentik-env` in namespace `authentik`
- `authentik-postgres-secret` in namespace `authentik`
- `grafana-admin` in namespace `observability`

Seal production secrets after the Sealed Secrets controller is available:

```bash
just prod-fetch-cert
just seal-prod /tmp/api-config.yaml sealed-secrets/prod/api-config.yaml
```

Repeat for each production secret file. Do not commit plaintext production secrets.

## Validation

Render/lint locally:

```bash
helm dependency update dreamteams_authentik
for chart in dreamteams_api dreamteams_migrations dreamteams_exporter dreamteams_frontend \
  dreamteams_pgbouncer dreamteams_nats dreamteams_cert_issuer dreamteams_ingress \
  observability dreamteams_postgres dreamteams_redis dreamteams_rustfs \
  dreamteams_oauth2proxy dreamteams_authentik; do
  release=$(printf '%s' "$chart" | tr '_' '-')
  helm template "$release" "./$chart" >/tmp/$chart.yaml
  helm lint "./$chart"
done
```
