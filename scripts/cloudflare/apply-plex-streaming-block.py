#!/usr/bin/env python3
"""Apply a Cloudflare WAF custom rule that blocks Plex streaming on tunnel hostnames.

Requires an API token with Zone.Firewall Services Edit (or Zone.WAF Edit) on the
zone that contains DOMAIN2 (for example rfmedia.media when DOMAIN2=home.rfmedia.media).

Usage:
  export CF_WAF_API_TOKEN="<token-with-waf-permissions>"  # optional; falls back to CF_MEDIA_API_TOKEN
  dotenvx run -q -f .env.local -- python3 scripts/cloudflare/apply-plex-streaming-block.py
  # or, with an env file of op:// references:
  op run --env-file .env.local -- python3 scripts/cloudflare/apply-plex-streaming-block.py

Idempotent: uses rule ref ``plex_tunnel_streaming_block`` to update in place.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

RULE_REF = "plex_tunnel_streaming_block"
RULE_DESCRIPTION = "Block Plex streaming on tunnel hostnames (plex / plex-sync)"
API_BASE = "https://api.cloudflare.com/client/v4"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def api_request(
    method: str,
    path: str,
    token: str,
    payload: dict | None = None,
) -> dict:
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            raise SystemExit(f"HTTP {exc.code} from Cloudflare API: {body}") from exc
        errors = parsed.get("errors", [])
        message = errors[0].get("message", body) if errors else body
        raise SystemExit(f"HTTP {exc.code} from Cloudflare API: {message}") from exc

    parsed = json.loads(body)
    if not parsed.get("success"):
        errors = parsed.get("errors", [])
        message = errors[0].get("message", "unknown error") if errors else "unknown error"
        raise SystemExit(f"Cloudflare API error: {message}")
    return parsed


def resolve_zone_id(token: str, domain2: str) -> tuple[str, str]:
    """Return (zone_id, zone_name) for the Cloudflare zone containing DOMAIN2."""
    candidates: list[str] = []
    parts = domain2.split(".")
    for index in range(len(parts) - 1):
        candidates.append(".".join(parts[index:]))

    for candidate in candidates:
        query = urllib.parse.urlencode({"name": candidate})
        parsed = api_request("GET", f"/zones?{query}", token)
        zones = parsed.get("result", [])
        if zones:
            zone = zones[0]
            return zone["id"], zone["name"]

    raise SystemExit(f"Could not find a Cloudflare zone for DOMAIN2={domain2}")


def build_expression(domain2: str) -> str:
    plex_host = f"plex.{domain2}"
    plex_sync_host = f"plex-sync.{domain2}"
    return (
        f'(http.host in {{"{plex_host}" "{plex_sync_host}"}}) and '
        f'(starts_with(http.request.uri.path, "/video/:/transcode") or '
        f'http.request.uri.path contains "/library/parts/")'
    )


def build_rule(domain2: str) -> dict:
    return {
        "ref": RULE_REF,
        "action": "block",
        "description": RULE_DESCRIPTION,
        "expression": build_expression(domain2),
        "enabled": True,
    }


def merge_rules(existing_rules: list[dict], desired_rule: dict) -> list[dict]:
    merged: list[dict] = []
    replaced = False

    for rule in existing_rules:
        if rule.get("ref") == RULE_REF:
            merged.append(desired_rule)
            replaced = True
        else:
            merged.append(rule)

    if not replaced:
        merged.append(desired_rule)

    return merged


def main() -> int:
    domain2 = require_env("DOMAIN2")
    token = os.environ.get("CF_WAF_API_TOKEN", "").strip() or require_env("CF_MEDIA_API_TOKEN")

    zone_id, zone_name = resolve_zone_id(token, domain2)
    desired_rule = build_rule(domain2)

    entrypoint = api_request(
        "GET",
        f"/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint",
        token,
    )
    ruleset = entrypoint["result"]
    rules = ruleset.get("rules", []) or []
    updated_rules = merge_rules(rules, desired_rule)

    api_request(
        "PUT",
        f"/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint",
        token,
        {"rules": updated_rules},
    )

    print(f"Applied WAF rule on zone {zone_name} ({zone_id})")
    print(f"Hosts: plex.{domain2}, plex-sync.{domain2}")
    print(f"Rule ref: {RULE_REF}")
    print("Action: block streaming paths (/video/:/transcode*, /library/parts/*)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
