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

# Install Ansible collections used by the production bootstrap.
ansible-install:
    ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ANSIBLE_GALAXY_CACHE_DIR=/tmp/ansible-galaxy-cache ansible-galaxy collection install -r ansible/requirements.yml -p .ansible/collections

# Record a production host SSH key only when it matches the provider fingerprint.
prod-known-host host fingerprint:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    mkdir -p ~/.ssh
    ssh-keyscan -H {{host}} > "$tmp"
    ssh-keygen -l -f "$tmp"
    ssh-keygen -l -f "$tmp" | grep -F "{{fingerprint}}" >/dev/null
    cat "$tmp" >> ~/.ssh/known_hosts
    ssh-keygen -F {{host}} -l -f ~/.ssh/known_hosts

# Bootstrap a production k3s cluster from ansible/inventory/hosts.yml.
prod-bootstrap:
    ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ansible-playbook ansible/site.yml --ask-vault-pass

# First bootstrap when the provider only gave a root SSH password.
prod-bootstrap-password:
    ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ansible-playbook ansible/site.yml --ask-pass --ask-vault-pass

# First infrastructure run before prod SealedSecrets exist.
prod-bootstrap-infra:
    ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ansible-playbook ansible/site.yml --ask-vault-pass -e '{"prod_required_secret_names":[]}'

# First infrastructure run by root SSH password before prod SealedSecrets exist.
prod-bootstrap-infra-password:
    ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ansible-playbook ansible/site.yml --ask-pass --ask-vault-pass -e '{"prod_required_secret_names":[]}'

# Re-login to ArgoCD (token expires after 24h)
argocd-login:
    #!/usr/bin/env bash
    PASSWORD=$(kubectl get secret argocd-initial-admin-secret \
        -n {{argocd_namespace}} -o jsonpath="{.data.password}" | base64 -d)
    argocd login localhost --username admin --password "$PASSWORD" \
        --insecure {{argocd_flags}}

# Sync all ArgoCD apps
local-sync:
    just local-apply
    just argocd-login
    argocd app sync k3s-traefik-config {{argocd_flags}}
    argocd app sync argo-rollouts {{argocd_flags}}
    argocd app wait argo-rollouts --sync --health --timeout 300 {{argocd_flags}}
    argocd app sync cert-manager dreamteams-cert-issuer dreamteams-local-secrets \
        dreamteams-postgres dreamteams-redis dreamteams-rustfs dreamteams-nats \
        dreamteams-authentik dreamteams-pgbouncer dreamteams-oauth2proxy \
        dreamteams-migrations dreamteams-api dreamteams-exporter \
        dreamteams-frontend dreamteams-anubis dreamteams-ingress dreamteams-observability \
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

# Open production ArgoCD UI through SSH tunnel. Usage: just prod-argocd-tunnel 203.0.113.10
prod-argocd-tunnel host local_port="8080" remote_port="8080":
    #!/usr/bin/env bash
    set -euo pipefail
    ssh_args=()
    if [ -n "${ANSIBLE_PRIVATE_KEY_FILE:-}" ]; then
      ssh_args+=("-i" "$ANSIBLE_PRIVATE_KEY_FILE")
    fi
    echo "Opening ArgoCD UI tunnel: https://localhost:{{local_port}}"
    echo "Stop it with Ctrl+C."
    ssh "${ssh_args[@]}" -L 127.0.0.1:{{local_port}}:127.0.0.1:{{remote_port}} deploy@{{host}} \
      'kubectl -n {{argocd_namespace}} port-forward svc/argocd-server {{remote_port}}:443 --address 127.0.0.1'

# Print production ArgoCD admin password over SSH. Usage: just prod-argocd-password 203.0.113.10
prod-argocd-password host:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh_args=()
    if [ -n "${ANSIBLE_PRIVATE_KEY_FILE:-}" ]; then
      ssh_args+=("-i" "$ANSIBLE_PRIVATE_KEY_FILE")
    fi
    ssh "${ssh_args[@]}" deploy@{{host}} \
      "kubectl get secret argocd-initial-admin-secret -n {{argocd_namespace}} -o jsonpath='{.data.password}' | base64 -d && echo"

# Fetch prod SealedSecrets public cert over SSH. Usage: just prod-fetch-cert-ssh 203.0.113.10
prod-fetch-cert-ssh host output="/tmp/prod-cert.pem":
    #!/usr/bin/env bash
    set -euo pipefail
    ssh_args=()
    if [ -n "${ANSIBLE_PRIVATE_KEY_FILE:-}" ]; then
      ssh_args+=("-i" "$ANSIBLE_PRIVATE_KEY_FILE")
    fi
    ssh "${ssh_args[@]}" deploy@{{host}} \
      "kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key=active -o jsonpath='{.items[0].data.tls\\.crt}'" \
      | base64 -d > "{{output}}"
    echo "Cert saved to {{output}}"

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

# Open local ArgoCD UI through kubectl port-forward.
argocd-web port="8080":
    kubectl -n {{argocd_namespace}} port-forward svc/argocd-server {{port}}:443 --address 127.0.0.1

# Print ArgoCD URL and admin password
argocd-open:
    @echo "URL:      https://localhost:8080"
    @echo "Tunnel:   just argocd-web 8080"
    @echo "Password: $(kubectl get secret argocd-initial-admin-secret -n {{argocd_namespace}} -o jsonpath='{.data.password}' | base64 -d)"
