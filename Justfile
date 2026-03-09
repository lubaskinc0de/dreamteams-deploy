# DreamTeams deployment automation
# Usage: just <recipe>

argocd_namespace := "argocd"
argocd_flags := "--port-forward --port-forward-namespace " + argocd_namespace

# Show available recipes
default:
    @just --list

# ─── Local ────────────────────────────────────────────────────────────────────

# Apply all ArgoCD apps + local secrets
local-apply:
    kubectl apply -f apps/
    kubectl apply -f local/secrets.yaml

# Re-login to ArgoCD (token expires after 24h)
argocd-login:
    #!/usr/bin/env bash
    PASSWORD=$(kubectl get secret argocd-initial-admin-secret \
        -n {{argocd_namespace}} -o jsonpath="{.data.password}" | base64 -d)
    argocd login localhost --username admin --password "$PASSWORD" \
        --insecure {{argocd_flags}}

# Sync all ArgoCD apps
local-sync:
    argocd app sync sealed-secrets dreamteams-secrets dreamteams-postgres \
        dreamteams-redis dreamteams-rustfs dreamteams-migrations \
        dreamteams-oauth2proxy dreamteams-api dreamteams-ingress \
        {{argocd_flags}}

# Show status of all apps
local-status:
    argocd app list {{argocd_flags}}

local-run:
    just local-apply
    just apps-apply
    just argocd-open
    kubectl port-forward svc/traefik 80:80 -n traefik


# ─── Prod ─────────────────────────────────────────────────────────────────────

# Provision and bootstrap prod server
prod-up:
    cd ansible && ansible-playbook site.yml -i inventory/hosts.yml --ask-vault-pass

# Fetch prod cluster cert for sealing prod secrets
prod-fetch-cert:
    kubeseal --fetch-cert \
        --controller-name=sealed-secrets \
        --controller-namespace=kube-system \
        > /tmp/prod-cert.pem
    @echo "Cert saved to /tmp/prod-cert.pem"

# ─── Secrets ──────────────────────────────────────────────────────────────────

# Seal a secret for local. Usage: just seal-local /tmp/secret.yaml sealed-secrets/local/secret.yaml
seal-local input output:
    kubeseal --controller-name=sealed-secrets --controller-namespace=kube-system \
        --format yaml < {{input}} > {{output}}

# Seal a secret for prod. Usage: just seal-prod /tmp/secret.yaml sealed-secrets/prod/secret.yaml
seal-prod input output:
    @test -f /tmp/prod-cert.pem || (echo "Run 'just prod-fetch-cert' first" && exit 1)
    kubeseal --cert /tmp/prod-cert.pem --format yaml < {{input}} > {{output}}

# ─── ArgoCD ───────────────────────────────────────────────────────────────────

# Print ArgoCD URL and admin password
argocd-open:
    @echo "URL:      http://$(kubectl get svc argocd-server -n {{argocd_namespace}} -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"
    @echo "Password: $(kubectl get secret argocd-initial-admin-secret -n {{argocd_namespace}} -o jsonpath='{.data.password}' | base64 -d)"

# Re-apply ArgoCD Application manifests after changing apps/*.yaml
apps-apply:
    kubectl apply -f apps/
