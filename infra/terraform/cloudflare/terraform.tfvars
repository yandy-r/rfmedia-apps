# Public hostnames served by the Cloudflare Tunnel. All route to Traefik.
# Add a service: new entry here + a matching Traefik router in compose.yml, then `npm run tf:plan:apply cloudflare`.
ingress = {
  "tokenhop"  = { domain = "primary" } # tokenhop.${DOMAIN}
  "plex-sync" = { domain = "media" }   # plex-sync.${DOMAIN2}
}
