# DreamTeams deployment automation
# Usage: just <recipe>
#
argocd_namespace := "argocd"
argocd_flags := "--port-forward --port-forward-namespace " + argocd_namespace

# Show available recipes
default:
    @just --list

# ─── Local ────────────────────────────────────────────────────────────────────

# Apply local K3S ArgoCD apps.
local-apply:
    kubectl apply -f apps/local/

# Apply production ArgoCD apps.
prod-apply:
    kubectl apply -f apps/prod/

# Re-login to ArgoCD (token expires after 24h)
argocd-login:
    #!/usr/bin/env bash
    PASSWORD=$(kubectl get secret argocd-initial-admin-secret \
        -n {{argocd_namespace}} -o jsonpath="{.data.password}" | base64 -d)
    argocd login localhost --username admin --password "$PASSWORD" \
        --insecure {{argocd_flags}}

# Sync all ArgoCD apps
local-sync:
    argocd app sync cert-manager dreamteams-cert-issuer dreamteams-local-secrets \
        dreamteams-postgres dreamteams-redis dreamteams-rustfs dreamteams-nats \
        dreamteams-authentik dreamteams-pgbouncer dreamteams-oauth2proxy \
        dreamteams-migrations dreamteams-api dreamteams-exporter \
        dreamteams-frontend dreamteams-ingress dreamteams-observability \
        {{argocd_flags}}

# Show status of all apps
local-status:
    argocd app list {{argocd_flags}}

local-run:
    just local-apply
    just argocd-open
    @echo "Local app:      https://dreamteams.localhost"
    @echo "Local Authentik: https://auth.dreamteams.localhost/if/flow/initial-setup/"
    @echo "Local Grafana:  https://grafana.dreamteams.localhost"

local-k3s-up:
    just local-apply
    @echo "Local K3S apps applied. Sync in ArgoCD or run: just local-sync"

observe:
    docker compose -f observability/docker-compose.yml up --build

observe-clear:
    docker compose -f observability/docker-compose.yml down -v

# Run k6 demo traffic against the local API. Requires SUPERUSER_PASSWORD env var.
# Usage: SUPERUSER_PASSWORD=asd123321 just demo-traffic
demo-traffic:
    docker compose -f observability/docker-compose.k6.yml run --rm k6

# ─── Prod ─────────────────────────────────────────────────────────────────────

# Fetch prod cluster cert for sealing prod secrets
prod-fetch-cert:
    kubeseal --fetch-cert \
        --controller-name=sealed-secrets \
        --controller-namespace=kube-system \
        > /tmp/prod-cert.pem
    @echo "Cert saved to /tmp/prod-cert.pem"

# ─── Secrets ──────────────────────────────────────────────────────────────────

# Seal a secret for prod. Usage: just seal-prod /tmp/secret.yaml sealed-secrets/prod/secret.yaml
seal-prod input output:
    @test -f /tmp/prod-cert.pem || (echo "Run 'just prod-fetch-cert' first" && exit 1)
    kubeseal --cert /tmp/prod-cert.pem --format yaml < {{input}} > {{output}}

# ─── ArgoCD ───────────────────────────────────────────────────────────────────

# Print ArgoCD URL and admin password
argocd-open:
    @echo "URL:      http://$(kubectl get svc argocd-server -n {{argocd_namespace}} -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
    @echo "Password: $(kubectl get secret argocd-initial-admin-secret -n {{argocd_namespace}} -o jsonpath='{.data.password}' | base64 -d)"
