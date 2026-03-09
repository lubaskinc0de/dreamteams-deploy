# DreamTeams Deploy

## Production: Setting up a new server

### Prerequisites (local machine)
- Ansible: `pip install ansible`
- `kubeseal` installed
- SSH key pair (default: `~/.ssh/id_ed25519`, override with `SSH_KEY=/path/to/key`)

### 1. Configure the server
Edit `ansible/inventory/hosts.yml` — replace `YOUR_VDS_IP` with the actual server IP.

### 2. Configure domain
Before deploying, update these files with your actual domain:

- `dreamteams_ingress/values.yaml` — set `host`
- `dreamteams_oauth2proxy/values.yaml` — set `redirect_url`
- `apps/api.yaml` — set `allow_origins` in `configFile`

Also update the Keycloak redirect URL in your Keycloak admin panel.

### 3. Fill Ansible Vault secrets
```bash
ansible-vault edit ansible/group_vars/secrets.yml
```

Required keys:
```yaml
ghcr_username: "your-github-username"
ghcr_token: "your-github-PAT"     # needs read:packages scope
ssh_private_key: |                 # deploy key with read access to this repo
  -----BEGIN OPENSSH PRIVATE KEY-----
  ...
  -----END OPENSSH PRIVATE KEY-----
```

Add the deploy key public part to GitHub → repo Settings → Deploy keys.

### 5. Run Ansible
```bash
just prod-up
```

If your SSH key is not at `~/.ssh/id_ed25519`:
```bash
SSH_KEY=~/.ssh/your_key just prod-up
```

This will:
1. Harden the OS, create `deploy` user, configure firewall
2. Install k3s
3. Install ArgoCD and deploy all applications

### 6. Seal prod secrets

After Ansible finishes, the Sealed Secrets controller is running. Fetch its public cert:

```bash
just prod-fetch-cert
```

Create plain secret files in `/tmp` (never commit these), then seal each one:

```bash
just seal-prod /tmp/api-secret.yaml        sealed-secrets/prod/api-secret.yaml
just seal-prod /tmp/migrations-secret.yaml sealed-secrets/prod/migrations-secret.yaml
just seal-prod /tmp/postgres-secret.yaml   sealed-secrets/prod/postgres-secret.yaml
just seal-prod /tmp/oauth2proxy-secret.yaml sealed-secrets/prod/oauth2proxy-secret.yaml
just seal-prod /tmp/rustfs-secret.yaml     sealed-secrets/prod/rustfs-secret.yaml
```

See `sealed-secrets/local/` for the structure each file must have.

Commit and push — ArgoCD picks them up automatically:
```bash
git add sealed-secrets/prod/
git commit -m "add prod sealed secrets"
git push
```

### 7. Get kubectl access

After Ansible, copy kubeconfig from the server to your local machine:
```bash
scp deploy@YOUR_VDS_IP:~/.kube/config ~/.kube/prod-config
export KUBECONFIG=~/.kube/prod-config
kubectl get pods -n dreamteams
```

---

## Production: Adding a new agent node

Buy a second VDS and add it to the inventory:

```yaml
# ansible/inventory/hosts.yml
agent:
  hosts:
    AGENT_VDS_IP:
```

Run Ansible again — k3s-ansible handles joining the agent to the cluster automatically.

---

## Local development

### Prerequisites
- minikube
- kubectl, helm, argocd CLI, kubeseal, just

### Start the stack
```bash
minikube start
```

Install ArgoCD manually (first time only):
```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd argo/argo-cd -n argocd --create-namespace \
  --set server.service.type=LoadBalancer --wait
```

Run:
```bash
just local-run
```

Open `http://localhost`.


### Updating a secret
```bash
# Edit /tmp/api-secret.yaml with new values, then:
just seal-local /tmp/api-secret.yaml sealed-secrets/local/api-secret.yaml
git add sealed-secrets/local/api-secret.yaml && git commit -m "update secret" && git push
```