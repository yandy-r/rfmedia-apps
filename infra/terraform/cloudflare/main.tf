# Cloudflare Tunnel (remotely managed) + proxied DNS for public hostnames.
# Every hostname routes to Traefik, which owns TLS, routing, and auth middleware.
# Run via npm scripts (`npm run tf:plan:cloudflare`), which inject secrets with dotenvx.

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }
}

# Auth: CLOUDFLARE_API_TOKEN from the environment (injected from .env.local by dotenvx).
provider "cloudflare" {}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the tunnel (CF_ACCOUNT_ID)."
  type        = string
  validation {
    condition     = length(var.cloudflare_account_id) > 0
    error_message = "CF_ACCOUNT_ID is not set in .env.local."
  }
}

variable "domain" {
  description = "Primary infrastructure domain (DOMAIN)."
  type        = string
  validation {
    condition     = length(var.domain) > 0
    error_message = "DOMAIN is not set in .env.local."
  }
}

variable "domain2" {
  description = "Media domain (DOMAIN2)."
  type        = string
  validation {
    condition     = length(var.domain2) > 0
    error_message = "DOMAIN2 is not set in .env.local."
  }
}

variable "tunnel_name" {
  description = "Tunnel name shown in the Cloudflare dashboard."
  type        = string
  default     = "rfmedia-apps-tf"
}

variable "origin_service" {
  description = "Origin every hostname is sent to. Traefik routes by Host/SNI from there."
  type        = string
  default     = "https://traefik:443"
}

variable "ingress" {
  description = "Public hostnames. Key = subdomain; domain = \"primary\" (DOMAIN) or \"media\" (DOMAIN2)."
  type        = map(object({ domain = string }))
  validation {
    condition     = alltrue([for r in values(var.ingress) : contains(["primary", "media"], r.domain)])
    error_message = "ingress[*].domain must be \"primary\" or \"media\"."
  }
}

locals {
  domains = { primary = var.domain, media = var.domain2 }
  hosts   = { for sub, r in var.ingress : sub => "${sub}.${local.domains[r.domain]}" }
  # ponytail: zone = last two DNS labels; breaks on multi-part TLDs (e.g. co.uk). Add an explicit zone field to `ingress` then.
  host_zone = { for sub, h in local.hosts : sub => join(".", slice(split(".", h), length(split(".", h)) - 2, length(split(".", h)))) }
}

data "cloudflare_zone" "this" {
  for_each = toset(values(local.host_zone))
  filter   = { name = each.key }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.cloudflare_account_id
  name       = var.tunnel_name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
  config = {
    ingress = concat(
      [for sub, h in local.hosts : {
        hostname = h
        service  = var.origin_service
        origin_request = {
          origin_server_name = h
          http2_origin       = true
        }
      }],
      [{ service = "http_status:404" }],
    )
  }
}

resource "cloudflare_dns_record" "this" {
  for_each = local.hosts
  zone_id  = data.cloudflare_zone.this[local.host_zone[each.key]].id
  name     = each.value
  type     = "CNAME"
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied  = true
  ttl      = 1
  comment  = "Managed by Terraform (infra/terraform/cloudflare)"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "hostnames" {
  value = values(local.hosts)
}

output "tunnel_token" {
  description = "Connector token for the cloudflared container (CF_TUNNEL_TOKEN)."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
