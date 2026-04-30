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
  --set server.service.type=ClusterIP \
  --set configs.rbac.policy\\.csv="g, admin, role:admin" \
  --wait
```

Apply the local app set:

```bash
just local-k3s-up
just argocd-login
just local-sync
```

ArgoCD UI is intentionally not exposed through the cluster LoadBalancer, so it does not compete with Traefik for ports `80` and `443`. Use a local port-forward when you need the UI:

```bash
just argocd-web 8080
```

Then open `https://localhost:8080`.

Local hosts:

- `https://dreamteams.localhost`
- `https://s3.dreamteams.localhost`
- `https://auth.dreamteams.localhost/if/flow/initial-setup/`
- `https://grafana.dreamteams.localhost`

The local issuer is self-signed, so browser warnings and `curl -k` are expected. If your resolver does not handle nested `.localhost` names, add these to `/etc/hosts`:

```text
127.0.0.1 dreamteams.localhost s3.dreamteams.localhost auth.dreamteams.localhost grafana.dreamteams.localhost
```

Local secrets live in `local/secrets.yaml` and are intentionally fake. The Authentik chart mounts a blueprint that creates the DreamTeams OIDC provider/application, an email-only authentication flow, and a registration flow with email, password, password confirmation, and mandatory email-code verification. The OIDC client id/secret are read from `DREAMTEAMS_OIDC_CLIENT_ID` and `DREAMTEAMS_OIDC_CLIENT_SECRET` in the `authentik-env` Secret, and must match the oauth2-proxy `client-id` and `client-secret`.

End-user Authentik copy for the DreamTeams flows is configured under `dreamteamsOidc.text` in `dreamteams_authentik/values.yaml`.

Email-code verification uses Authentik global email settings, so `authentik-env` must also include the relevant `AUTHENTIK_EMAIL__...` SMTP configuration before registrations can complete.

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

The Compose observability sandbox also starts Alertmanager and Mailpit. Alertmanager sends local alert emails to Mailpit; open `http://localhost:8025` to inspect captured messages.

Observability config ownership:

- Docker and K3S share Prometheus alert rule files, `observability/loki.yaml`, `observability/tempo.yaml`, `observability/otel-collector.yaml`, and Grafana datasources/dashboards.
- Docker uses `observability/prometheus.yml`; K3S uses `observability/prometheus.kubernetes.yml` so Kubernetes-only targets do not break the Compose sandbox.
- Vector is environment-specific: Docker Compose uses `observability/vector.docker.yaml`, while K3S uses `observability/vector.kubernetes.yaml`.

## Production

Before production deploy, update:

- `apps/prod/ingress.yaml`: replace `dreamteams.example.com`, `s3.dreamteams.example.com`, `auth.dreamteams.example.com`, and `grafana.dreamteams.example.com`.
- `apps/prod/oauth2proxy.yaml`: replace the same hostnames in the oauth2-proxy config block.
- `dreamteams_authentik/values-prod.yaml`: replace the Authentik OIDC redirect URI hostname.
- SealedSecrets under `sealed-secrets/prod/` for every secret in `local/secrets.yaml`, with production values and namespaces preserved.
- Backups for Postgres and object storage. This repo does not create production backup CronJobs yet; configure and verify backups before putting real user data in the cluster.

For production Authentik automation, include `DREAMTEAMS_OIDC_CLIENT_ID` and `DREAMTEAMS_OIDC_CLIENT_SECRET` in the sealed `authentik-env` Secret. Use the same values as the sealed `dreamteams-oauth2proxy-secret` `client-id` and `client-secret` keys.

Traefik source IP preservation is managed by the `k3s-traefik-config` ArgoCD app. It applies the K3S `HelmChartConfig` for Traefik as a `DaemonSet` with `externalTrafficPolicy: Local`, so every VDS that receives ingress traffic has a local Traefik endpoint and rate-limit `RemoteAddr` sees the original client IP. Traefik access logs stay disabled by default.

### Ansible Bootstrap

The Ansible bootstrap always applies `apps/prod/`. Kubernetes API is not opened to the public internet by default; manage the cluster over SSH from the first control-plane node.

From a fresh VDS:

1. Buy a server with Ubuntu/Debian and public IPv4. At the provider firewall level, allow at least TCP `22`, `80`, and `443`.
2. Point DNS `A` records to the server IP: `dreamteams.example.com`, `auth.dreamteams.example.com`, `s3.dreamteams.example.com`, and `grafana.dreamteams.example.com`.
3. Generate an SSH key if needed:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/dreamteams_prod
```

4. Fill `ansible/inventory/hosts.yml`.
   - Put 1, 3, 5, or 7 control-plane nodes under `server`.
   - Put worker nodes under `agent`.
   - If nodes use private networking, set `k3s_firewall_ip` per node and optionally `k3s_api_endpoint` to a VIP/load balancer.
5. Set production hosts in `ansible/group_vars/all.yaml`: `app_host`, `auth_host`, `s3_host`, `grafana_host`, and `letsencrypt_email`.
6. If `deploy_repo` is an SSH URL, put the deploy key in Ansible Vault as `deploy_repo_ssh_private_key` or `ssh_private_key`:

```bash
ansible-vault edit ansible/group_vars/secrets.yml
```

7. Export the SSH connection/public key values:

```bash
export ANSIBLE_USER=root
export ANSIBLE_PRIVATE_KEY_FILE=~/.ssh/dreamteams_prod
export SSH_PUBLIC_KEY="$(cat ~/.ssh/dreamteams_prod.pub)"
```

8. Get each server SSH host key fingerprint from your provider console or rescue shell, then record the key locally. The recipe appends the scanned key only when it matches the expected `SHA256:` fingerprint:

```bash
just prod-known-host YOUR_SERVER_IP SHA256:EXPECTED_SERVER_FINGERPRINT
```

9. Install collections:

```bash
just ansible-install
```

10. Run bootstrap.

If the provider already installed your SSH public key for root:

```bash
just prod-bootstrap
```

If the provider only gave a root SSH password:

```bash
just prod-bootstrap-password
```

The playbook creates the `deploy` user, installs your SSH key, disables SSH password login, enables UFW/fail2ban/unattended-upgrades, installs k3s, tightens the firewall, installs ArgoCD, and applies `apps/prod/`.

For HA with embedded etcd, k3s requires an odd number of server nodes. Without an external API load balancer, the first server is used as `api_endpoint`.

### First SealedSecrets Run

For a brand-new cluster, SealedSecrets must be sealed with a certificate that the target cluster's controller can decrypt. If `sealed-secrets/prod/` already contains valid prod SealedSecrets, run the normal bootstrap above.

If this is the first ever production cluster and prod SealedSecrets do not exist yet, run an infrastructure bootstrap first:

```bash
just prod-bootstrap-infra
```

or, with a provider root password:

```bash
just prod-bootstrap-infra-password
```

That run installs k3s, ArgoCD, cert-manager, and the SealedSecrets controller, but application pods may wait for missing secrets. Fetch the SealedSecrets cert from the control-plane node:

```bash
just prod-fetch-cert-ssh YOUR_SERVER_IP /tmp/prod-cert.pem
```

Seal real production secrets with that cert, commit/push them to `sealed-secrets/prod/`, then rerun:

```bash
just prod-bootstrap
```

or sync from the control-plane node:

```bash
ssh deploy@YOUR_SERVER_IP
just argocd-refresh
just argocd-sync-all
```

### Control-Plane Operations

After bootstrap, SSH into the first control-plane node as `deploy`. Ansible installs a small ops `Justfile` at `/home/deploy/cluster-ops/Justfile` and links it as `/home/deploy/Justfile`.

Useful commands on the server:

```bash
ssh deploy@YOUR_SERVER_IP
just nodes
just pods
just apps
just ingress
just secrets-status
just firewall
```

### ArgoCD UI

ArgoCD is intentionally not exposed publicly. Open it through an SSH tunnel from your local machine:

```bash
just prod-argocd-tunnel YOUR_SERVER_IP
```

Then open:

```text
https://localhost:8080
```

The browser will warn about the local TLS certificate; accept it for this local tunnel. Login is `admin`. Print the password from your local machine:

```bash
just prod-argocd-password YOUR_SERVER_IP
```

Manual tunnel equivalent:

```bash
ssh -L 127.0.0.1:8080:127.0.0.1:8080 deploy@YOUR_SERVER_IP \
  'kubectl -n argocd port-forward svc/argocd-server 8080:443 --address 127.0.0.1'
```

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
- `alertmanager-config` in namespace `observability`
- `ghcr-secret` in namespace `dreamteams` if GHCR images are private

Alertmanager reads its full SMTP config from the `alertmanager-config` Secret. Production should seal a Secret shaped like this:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-config
  namespace: observability
type: Opaque
stringData:
  alertmanager.yml: |
    global:
      smtp_smarthost: smtp.example.com:587
      smtp_from: alerts@example.com
      smtp_auth_username: alerts@example.com
      smtp_auth_password: REPLACE_ME
      smtp_require_tls: true
      resolve_timeout: 5m

    route:
      receiver: email
      group_by: ['alertname', 'severity', 'service_name', 'namespace']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h

    receivers:
      - name: email
        email_configs:
          - to: ops@example.com
            send_resolved: true
```

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
