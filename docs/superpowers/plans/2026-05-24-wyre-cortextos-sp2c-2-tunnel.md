# WYRE cortextOS SP2c-2 — Cloudflare Tunnel + Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the cortextOS dashboard at `https://agents.internal.wyre.ai` and ops SSH at `agents-ssh.internal.wyre.ai` through a Cloudflare Tunnel gated by Entra-SSO Access — no public IP, no NSG ingress, and zero dashboard code change (host-based subdomain routing).

**Architecture:** Terraform's Cloudflare provider creates a remotely-managed tunnel, its ingress config (two hostnames → localhost:3000 and ssh://localhost:22), two DNS CNAMEs, and two Zero-Trust Access apps+policies (Entra IdP, `@wyretechnology.com`). The tunnel token is written to Key Vault. Cloud-init installs `cloudflared`, fetches the token from Key Vault via the VM's managed identity, and runs `cloudflared.service`. SSH on the VM stays bound to localhost — reachable only through the tunnel.

**Tech Stack:** Terraform (`cloudflare` provider ~> 5.0, `azurerm` ~> 3.90), cloud-init, systemd, `cloudflared`, Azure IMDS + Key Vault REST.

**Spec:** `docs/superpowers/specs/2026-05-24-wyre-cortextos-sp2c-tunnel-backups-design.md`

---

## CRITICAL context for every task

- **Branch:** `feat/sp2c-2-tunnel` (already checked out). Working dir `~/cortextos`.
- **Commits:** `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com" commit ...`, Conventional Commits.
- **The Cloudflare provider v5 renamed many resources from v4.** This plan uses the **v5** names to the best of current knowledge, but the authoritative source is the installed provider. After `terraform init` downloads the provider, **every Terraform task's gate is `terraform validate`** — if validate reports an unknown resource type or attribute, run `terraform providers schema -json | jq '.provider_schemas | keys'` (and drill into the specific resource) to find the correct v5 name/shape, fix it, and re-validate. This is expected, not a failure.
- **`terraform validate` does NOT call the Cloudflare API** — it needs no `CLOUDFLARE_API_TOKEN`. So all authoring tasks complete and validate-clean offline. The live `terraform apply` is an operator step deferred to the end (Task 8), gated on operator prerequisites (Cloudflare token + Entra IdP). Do **not** attempt `terraform apply` in tasks 1-7.
- After each Terraform change: `cd infra/terraform && terraform fmt && terraform validate`.

---

## Task 1: Cloudflare provider + variables

**Files:**
- Modify: `infra/terraform/main.tf` (add `cloudflare` to `required_providers` + a `provider "cloudflare"` block)
- Modify: `infra/terraform/variables.tf` (append Cloudflare variables)

- [ ] **Step 1: Add the provider to `required_providers`**

In `infra/terraform/main.tf`, the `required_providers` block currently has only `azurerm`. Add `cloudflare`:

```hcl
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
```

- [ ] **Step 2: Add the provider config**

In `infra/terraform/main.tf`, after the existing `provider "azurerm" { ... }` block, add:

```hcl
# Cloudflare provider. The API token comes from the CLOUDFLARE_API_TOKEN env var
# (provider reads it automatically) — never hardcode or put it in tfvars.
# Token scopes required: Zone:DNS:Edit on wyre.ai + Account:Cloudflare Tunnel:Edit
# + Account:Access: Apps and Policies:Edit.
provider "cloudflare" {}
```

- [ ] **Step 3: Append Cloudflare variables to `variables.tf`**

Append to `infra/terraform/variables.tf`:

```hcl
variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the tunnel and Access apps."
  default     = ""
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for wyre.ai (DNS records are created here)."
  default     = ""
}

variable "cloudflare_zone_name" {
  type        = string
  description = "Cloudflare zone name."
  default     = "wyre.ai"
}

variable "dashboard_hostname" {
  type        = string
  description = "Public hostname for the dashboard (host-based routing, served at /)."
  default     = "agents.internal.wyre.ai"
}

variable "ssh_hostname" {
  type        = string
  description = "Public hostname for ops SSH through the tunnel."
  default     = "agents-ssh.internal.wyre.ai"
}

variable "cloudflare_access_idp_id" {
  type        = string
  description = "Cloudflare Zero Trust IdP id for the Entra (Azure AD) identity provider. Operator sets this up in the CF Zero Trust dashboard first (see runbook); required for the Access policy."
  default     = ""
}

variable "access_email_domain" {
  type        = string
  description = "Email domain allowed through Cloudflare Access."
  default     = "wyretechnology.com"
}
```

> Defaults are empty for the account/zone/idp ids so `terraform validate` passes offline; real values go in `terraform.tfvars` at apply time (Task 8). `terraform plan/apply` will fail fast with a clear message if they're still empty — acceptable, since apply is operator-gated.

- [ ] **Step 4: Validate**

```bash
cd infra/terraform
terraform init -upgrade
terraform fmt
terraform validate
```

Expected: `init` downloads `cloudflare/cloudflare` v5.x; `validate` → `Success! The configuration is valid.` If init fails to find v5, check the latest 5.x with `terraform init` error output and pin accordingly (still `~> 5.0`).

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/main.tf infra/terraform/variables.tf
git commit -m "feat(infra): add Cloudflare provider and tunnel/access variables"
```

---

## Task 2: Cloudflare tunnel + ingress config + DNS

**Files:**
- Create: `infra/terraform/cloudflare.tf`

- [ ] **Step 1: Write the tunnel, config, and DNS records**

Create `infra/terraform/cloudflare.tf` with the tunnel, its ingress config, and the two CNAMEs. **Verify each resource/attribute name against the installed v5 provider** (see CRITICAL context):

```hcl
# A remotely-managed Cloudflare Tunnel. The token this produces is stored in
# Key Vault (see end of file) and consumed by cloudflared.service on the VM.
resource "cloudflare_zero_trust_tunnel_cloudflared" "cortextos" {
  account_id = var.cloudflare_account_id
  name       = "${local.name_prefix}-tunnel"
  # config_src = "cloudflare" makes this a remotely-managed tunnel whose ingress
  # is defined by the _config resource below (v5 default; set explicitly).
  config_src = "cloudflare"
}

# Ingress rules: hostname-based routing. Dashboard → local Next.js; ssh hostname
# → local sshd. Final catch-all returns 404 as required by cloudflared.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cortextos" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id

  config = {
    ingress = [
      {
        hostname = var.dashboard_hostname
        service  = "http://localhost:3000"
      },
      {
        hostname = var.ssh_hostname
        service  = "ssh://localhost:22"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

# DNS: both hostnames are CNAMEs to the tunnel's <id>.cfargotunnel.com target,
# proxied through Cloudflare (orange cloud) so Access can gate them.
resource "cloudflare_dns_record" "dashboard" {
  zone_id = var.cloudflare_zone_id
  name    = var.dashboard_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 = automatic; required when proxied
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.cloudflare_zone_id
  name    = var.ssh_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
```

> **Schema caveats to confirm during validate:**
> - In v5 the DNS record content field is `content` (was `value` in v4). If validate complains, check `terraform providers schema -json | jq '.provider_schemas["registry.terraform.io/cloudflare/cloudflare"].resource_schemas.cloudflare_dns_record.block.attributes | keys'`.
> - The `_config` resource's `config`/`ingress` may be a nested block (`config { ingress { ... } }`) rather than an attribute object depending on the exact v5 minor. Validate will tell you; adjust block-vs-attribute syntax to match.
> - `cloudflare_dns_record.name` may need to be the short name (`agents.internal`) rather than FQDN depending on provider version; if validate/plan complains the record name is outside the zone, strip the `.wyre.ai` suffix. Document whichever the provider wants in a comment.

- [ ] **Step 2: Validate**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: `Success!`. Iterate on resource/attribute names per the caveats until clean.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/cloudflare.tf
git commit -m "feat(infra): Cloudflare tunnel, ingress config, and DNS records"
```

---

## Task 3: Access applications + policy

**Files:**
- Modify: `infra/terraform/cloudflare.tf` (append Access resources)

- [ ] **Step 1: Append the Access policy and two applications**

Append to `infra/terraform/cloudflare.tf`. In v5, Access policies are **account-level resources referenced by applications** (a change from v4's inline policies):

```hcl
# One reusable policy: allow identities from the Entra IdP whose email is in the
# WYRE domain. Referenced by both Access applications below.
resource "cloudflare_zero_trust_access_policy" "wyre_staff" {
  account_id = var.cloudflare_account_id
  name       = "WYRE staff (Entra, ${var.access_email_domain})"
  decision   = "allow"

  include = [
    {
      email_domain = {
        domain = var.access_email_domain
      }
    },
  ]

  # Require the Entra IdP specifically (not just any login method).
  require = [
    {
      login_method = {
        id = var.cloudflare_access_idp_id
      }
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "dashboard" {
  account_id       = var.cloudflare_account_id
  name             = "WYRE Agents"
  domain           = var.dashboard_hostname
  type             = "self_hosted"
  session_duration = "24h"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.wyre_staff.id
      precedence = 1
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "ssh" {
  account_id       = var.cloudflare_account_id
  name             = "WYRE Agents — SSH"
  domain           = var.ssh_hostname
  type             = "ssh"
  session_duration = "24h"
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.wyre_staff.id
      precedence = 1
    },
  ]
}
```

> **Schema caveats:** v5's `include`/`require` are lists of objects with typed keys (`email_domain`, `login_method`); some minors use `email_domain = [{ domain = ... }]` shape or a flatter form. The `policies` attribute on the application (referencing policy ids with precedence) is the v5 model; older shapes inlined `policies` blocks. Confirm all three via `terraform validate` + `terraform providers schema` and adjust. Keep the *intent* fixed: one allow-policy = (email domain in WYRE) AND (login via the Entra IdP), attached to both apps.

- [ ] **Step 2: Validate**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: `Success!`.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/cloudflare.tf
git commit -m "feat(infra): Cloudflare Access apps + Entra-gated policy"
```

---

## Task 4: Write the tunnel token to Key Vault

**Files:**
- Modify: `infra/terraform/cloudflare.tf` (append the KV secret)
- Modify: `infra/terraform/outputs.tf` (expose tunnel id + hostnames)

- [ ] **Step 1: Append the Key Vault secret**

The VM's managed identity already has Key Vault Get/List (from SP2a's `keyvault.tf`). Store the tunnel's run token as a secret. Append to `infra/terraform/cloudflare.tf`:

```hcl
# The tunnel's run token, stored in Key Vault. cloud-init fetches it at first
# boot via the VM's managed identity and hands it to cloudflared.service.
# The token attribute on the tunnel resource is sensitive.
resource "azurerm_key_vault_secret" "cloudflared_token" {
  name         = "cloudflared-token"
  value        = cloudflare_zero_trust_tunnel_cloudflared.cortextos.token
  key_vault_id = azurerm_key_vault.main.id

  # The operator access policy must exist before we can write secrets.
  depends_on = [azurerm_key_vault_access_policy.operator]
}
```

> **Schema caveat:** the token attribute may be `.token` or exposed via a separate `cloudflare_zero_trust_tunnel_cloudflared_token` data source in some v5 minors. If `.token` is not an attribute on the resource, add the data source:
> ```hcl
> data "cloudflare_zero_trust_tunnel_cloudflared_token" "cortextos" {
>   account_id = var.cloudflare_account_id
>   tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id
> }
> ```
> and use `data.cloudflare_zero_trust_tunnel_cloudflared_token.cortextos.token`. Confirm via schema.

- [ ] **Step 2: Add outputs**

Append to `infra/terraform/outputs.tf`:

```hcl
output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id
  description = "Cloudflare Tunnel id."
}

output "dashboard_url" {
  value       = "https://${var.dashboard_hostname}"
  description = "Access-gated dashboard URL."
}

output "ssh_hostname" {
  value       = var.ssh_hostname
  description = "Ops SSH hostname (reach via cloudflared access ssh ProxyCommand)."
}
```

- [ ] **Step 3: Validate**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: `Success!`.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/cloudflare.tf infra/terraform/outputs.tf
git commit -m "feat(infra): store tunnel token in Key Vault; tunnel outputs"
```

---

## Task 5: cloudflared.service systemd unit (standalone copy)

**Files:**
- Create: `infra/systemd/cloudflared.service`

- [ ] **Step 1: Write the unit**

Create `infra/systemd/cloudflared.service`. The token is read from an env file that cloud-init writes (Task 6):

```ini
[Unit]
Description=cloudflared tunnel (WYRE Agents)
After=network-online.target cortextos.service
Wants=network-online.target

[Service]
Type=simple
User=cloudflared
Group=cloudflared
EnvironmentFile=/etc/cloudflared.env
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> `${TUNNEL_TOKEN}` is a systemd `EnvironmentFile` expansion (not a Terraform placeholder) — systemd substitutes it from `/etc/cloudflared.env`. The unit does not depend on `cortextos.service` succeeding (no `Requires=`), only orders after it, so a dashboard hiccup doesn't tear down the tunnel.

- [ ] **Step 2: Commit**

```bash
git add infra/systemd/cloudflared.service
git commit -m "feat(infra): cloudflared systemd unit"
```

---

## Task 6: cloud-init — install cloudflared, fetch token, run service

**Files:**
- Modify: `infra/terraform/cloud-init.yaml.tftpl`
- Modify: `infra/terraform/vm.tf` (pass `key_vault_uri` into the template; add `depends_on` on the token secret)

- [ ] **Step 1: Pass the Key Vault URI into the cloud-init template**

In `infra/terraform/vm.tf`, find the `templatefile(...)` call that renders `cloud-init.yaml.tftpl` and add `key_vault_uri` to its variables map:

```hcl
    key_vault_uri = azurerm_key_vault.main.vault_uri
```

(Keep all existing keys; just add this one.)

- [ ] **Step 2: Add `${key_vault_uri}` handling + cloudflared to the template**

In `infra/terraform/cloud-init.yaml.tftpl`:

(a) Under `packages:` add nothing for cloudflared (it's not in apt by default); it's installed in the bootstrap script instead.

(b) Create the `cloudflared` user and install the binary. In the embedded bootstrap shell script (the `cortextos-bootstrap.sh` content block), after the cortextos user/Node setup and before the final sentinel, add:

```bash
      # ── cloudflared install + token fetch ──────────────────────
      if ! id cloudflared >/dev/null 2>&1; then
        log "creating cloudflared system user"
        useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared
      fi
      if ! command -v cloudflared >/dev/null 2>&1; then
        log "installing cloudflared"
        ARCH=$(dpkg --print-architecture)
        curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb" -o /tmp/cloudflared.deb
        dpkg -i /tmp/cloudflared.deb
        rm -f /tmp/cloudflared.deb
      fi

      # Fetch the tunnel token from Key Vault via the VM's managed identity.
      log "fetching cloudflared token from Key Vault"
      KV_URI="${key_vault_uri}"
      IMDS_TOKEN=$(curl -s -H "Metadata: true" \
        "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" \
        | jq -r .access_token)
      CF_TOKEN=$(curl -s -H "Authorization: Bearer $IMDS_TOKEN" \
        "$${KV_URI}secrets/cloudflared-token?api-version=7.4" | jq -r .value)
      if [ -z "$CF_TOKEN" ] || [ "$CF_TOKEN" = "null" ]; then
        log "FATAL: could not fetch cloudflared-token from Key Vault ($${KV_URI})"
        exit 1
      fi
      umask 077
      printf 'TUNNEL_TOKEN=%s\n' "$CF_TOKEN" > /etc/cloudflared.env
      chmod 600 /etc/cloudflared.env
```

> Note the `$${KV_URI}` doubling: `${key_vault_uri}` is the Terraform placeholder (substituted at render), while `$${KV_URI}` escapes to the literal `${KV_URI}` bash variable in the rendered output. Single `${KV_URI}` would make Terraform try to resolve a `KV_URI` template var and fail — the same class of bug SP2b hit with `$${...}` in a comment.

(c) Add the `cloudflared.service` unit to `write_files` (mirror of `infra/systemd/cloudflared.service` from Task 5, indented 6 spaces under `content: |`):

```yaml
  - path: /etc/systemd/system/cloudflared.service
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=cloudflared tunnel (WYRE Agents)
      After=network-online.target cortextos.service
      Wants=network-online.target

      [Service]
      Type=simple
      User=cloudflared
      Group=cloudflared
      EnvironmentFile=/etc/cloudflared.env
      ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token $${TUNNEL_TOKEN}
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
```

> `$${TUNNEL_TOKEN}` → renders to `${TUNNEL_TOKEN}` (systemd env expansion). Single-`$` would be a Terraform template error.

(d) In `runcmd:`, after the existing `cortextos.service` start lines, enable and start cloudflared:

```yaml
  - systemctl enable cloudflared.service
  - systemctl start --no-block cloudflared.service
```

- [ ] **Step 3: Validate the rendered template**

```bash
cd infra/terraform
# YAML shape check with all placeholders substituted (including the new key_vault_uri):
sed -e 's/${cortextos_instance}/prod/g' \
    -e 's/${cortextos_org}/wyre/g' \
    -e 's|${cortextos_repo_url}|https://github.com/wyre-technology/cortextos|g' \
    -e 's/${cortextos_branch}/main/g' \
    -e 's/${node_major_version}/20/g' \
    -e 's|${key_vault_uri}|https://kv.vault.azure.net/|g' \
    cloud-init.yaml.tftpl | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" && echo "YAML OK"
terraform fmt
terraform validate
```

Expected: `YAML OK` and `Success!`. If validate errors on the `templatefile` call, it usually means a single-`$` slipped into a `${...}` that should be `$${...}` — fix the escape.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/cloud-init.yaml.tftpl infra/terraform/vm.tf
git commit -m "feat(infra): cloud-init installs cloudflared and runs the tunnel from KV token"
```

---

## Task 7: Extend the drift checker to cover cloudflared.service

**Files:**
- Modify: `infra/bin/check-systemd-drift.sh` (only if it hardcodes the unit list)

- [ ] **Step 1: Inspect the drift checker**

```bash
cat infra/bin/check-systemd-drift.sh
```

The SP2b version parses `cloud-init.yaml.tftpl` with PyYAML and compares every `write_files` entry under `/etc/systemd/system/` against the matching file in `infra/systemd/`. If it iterates **all** such entries dynamically, it already covers `cloudflared.service` — no change needed; skip to Step 3.

If it has a hardcoded list of unit names (e.g. `for unit in cortextos.service cortextos-bootstrap.service`), add `cloudflared.service` to that list.

- [ ] **Step 2: Run the checker**

```bash
./infra/bin/check-systemd-drift.sh
```

Expected output includes a line for each of the three units:
```
OK: cortextos-bootstrap.service
OK: cortextos.service
OK: cloudflared.service
```
Exit 0. If `cloudflared.service` shows `DRIFT`, the embedded copy (Task 6c) and standalone copy (Task 5) differ — reconcile them byte-for-byte (the standalone file is the human source of truth; the embedded YAML must match it exactly after de-indentation).

- [ ] **Step 3: Commit (only if the script changed)**

```bash
git add infra/bin/check-systemd-drift.sh
git commit -m "feat(infra): drift check covers cloudflared.service"
```

If the script was already dynamic and unchanged, skip the commit and note it in the report.

---

## Task 8: CHANGELOG, PR, and operator-apply handoff

This task does **not** run `terraform apply` itself — it documents the operator prerequisites and opens the PR. The live apply + E2E (dashboard loads through Access, SSH via tunnel) happens after the operator supplies Cloudflare credentials and sets up the Entra IdP.

- [ ] **Step 1: Update `CHANGELOG.md`**

Append to the `[Unreleased]` / `### Added` list:

```markdown
- SP2c-2 — Cloudflare Tunnel + Zero-Trust Access. The dashboard is reachable at
  `https://agents.internal.wyre.ai` and ops SSH at `agents-ssh.internal.wyre.ai`
  through a Cloudflare Tunnel (no public IP), gated by Entra-SSO Access limited
  to `@wyretechnology.com`. `cloudflared.service` runs the tunnel from a token
  stored in Key Vault and fetched at first boot via the VM's managed identity.
  Host-based subdomain routing — no dashboard code change.
```

- [ ] **Step 2: Document operator prerequisites in the runbook**

Append a section to `docs/runbook/sp2-host.md`:

```markdown
## SP2c-2 apply prerequisites (Cloudflare Tunnel + Access)

Before `terraform apply` with the Cloudflare resources:

1. **Cloudflare API token** — create one scoped to:
   - Zone : DNS : Edit  (on the `wyre.ai` zone)
   - Account : Cloudflare Tunnel : Edit
   - Account : Access: Apps and Policies : Edit
   Export it: `export CLOUDFLARE_API_TOKEN=...` (never commit).

2. **Account / zone ids** — put in `terraform.tfvars`:
   - `cloudflare_account_id` = (Cloudflare dashboard → account id)
   - `cloudflare_zone_id`    = (wyre.ai zone → zone id)

3. **Entra IdP in Cloudflare Zero Trust** — Zero Trust dashboard → Settings →
   Authentication → add **Azure AD** login method (app registration in the
   `wyretechnology.com` Entra tenant; redirect URI from the CF setup wizard).
   Copy the resulting IdP id into `terraform.tfvars` as `cloudflare_access_idp_id`.

4. `terraform apply`. Then verify:
   - `https://agents.internal.wyre.ai` → Cloudflare Access login → WYRE SSO → dashboard.
   - Local `~/.ssh/config`:
     ```
     Host agents-ssh.internal.wyre.ai
       ProxyCommand cloudflared access ssh --hostname %h
       User ops
     ```
     then `ssh agents-ssh.internal.wyre.ai`.
```

- [ ] **Step 3: Commit and push**

```bash
git add CHANGELOG.md docs/runbook/sp2-host.md
git commit -m "docs: SP2c-2 changelog + Cloudflare apply prerequisites in runbook"
git push -u origin feat/sp2c-2-tunnel
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp2c-2-tunnel \
  --title "SP2c-2: Cloudflare Tunnel + Access (subdomain routing)" \
  --body "Implements the Tunnel + Access half of docs/superpowers/specs/2026-05-24-wyre-cortextos-sp2c-tunnel-backups-design.md.

Dashboard at https://agents.internal.wyre.ai and ops SSH at agents-ssh.internal.wyre.ai through a Cloudflare Tunnel (no public IP), gated by Entra-SSO Access (@wyretechnology.com). Tunnel token in Key Vault, fetched at first boot via managed identity. Host-based subdomain routing — ZERO dashboard code change (revised from the original path-based /agents plan, which would have required rewriting 54 client fetch('/api/...') calls).

terraform validate clean. The live apply + E2E is operator-gated (needs CLOUDFLARE_API_TOKEN + account/zone ids + Entra IdP setup in Cloudflare Zero Trust — see docs/runbook/sp2-host.md). Provider note: Cloudflare v5 resource names were confirmed against the installed provider via terraform validate during implementation."
```

- [ ] **Step 5: Report**

Report the PR URL, the final `terraform validate` result, the drift-check output, and any v5 provider resource/attribute names that differed from what this plan assumed (so the spec/plan can be annotated).

---

## Self-review notes

- **Spec coverage:** provider+vars (T1), tunnel+config+DNS (T2), Access apps+policy (T3), KV token+outputs (T4), cloudflared unit (T5), cloud-init install+fetch+run (T6), drift checker (T7), changelog+runbook+PR (T8). Backups (SP2c-1) already merged. Restore drill + full runbook + `v0.3.0` tag are SP2c-3, out of this plan's scope.
- **Application-code change:** none — host-based subdomain routing means `dashboard/next.config.ts` and the 54 `fetch('/api/...')` calls are untouched, exactly as the revised spec requires.
- **Placeholder scan:** no TBDs. The v5 provider schema caveats are explicit, bounded instructions ("confirm via `terraform validate` / `terraform providers schema`, fix names") — not hand-waving, because the provider schema genuinely cannot be resolved offline and validate is a deterministic gate.
- **`$$` escaping:** both the bash `$${KV_URI}` and the systemd `$${TUNNEL_TOKEN}` are doubled so `templatefile()` emits a literal `${...}`. The only real Terraform placeholders in the new cloud-init content are `${key_vault_uri}` (Step 6b) — passed in via Step 6a.
- **Apply is deferred, deliberately.** Tasks 1-7 are validate-clean offline; Task 8 documents the operator prerequisites and opens the PR. No task runs `terraform apply` — that needs the Cloudflare token and Entra IdP the operator must provision first.
- **Consistency:** `cloudflare_zero_trust_tunnel_cloudflared.cortextos`, `..._config.cortextos`, `cloudflare_dns_record.dashboard/.ssh`, `cloudflare_zero_trust_access_policy.wyre_staff`, `cloudflare_zero_trust_access_application.dashboard/.ssh`, `azurerm_key_vault_secret.cloudflared_token` — referenced consistently across T2-T4 and outputs.
