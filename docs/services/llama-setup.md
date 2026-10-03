# llama.cpp (AMD ROCm inference)

`llama-server` on `apps` network with native API-key auth (`--api-key-file`,
exact upstream mechanism: `--api-key` / `LLAMA_API_KEY` env /
`--api-key-file` / `LLAMA_ARG_API_KEY_FILE` env, verified via image `--help`).
No Authentik middleware — API clients can't do browser SSO. No published host
ports.

## Endpoints

- Internal: `http://llama:8080` (apps network only).
- Traefik: `https://llama.${DOMAIN}` (websecure, Let's Encrypt).
- Tailscale: `https://llama.<TS_DOMAIN>` via tsdproxy-rfapps
  (`tsdproxy.name: llama`, `tsdproxy.port.1: 443/https:8080/http`,
  provider `rfapps`).

`/health` is public. All inference routes require
`Authorization: Bearer <key>`, return 401 without it.

## Hardware

- AMD RX 9070 XT (gfx1201). Host: kernel driver `amdgpu` only — no host ROCm
  install. Image bundles ROCm/HIP userland; devices mapped are the render node
  plus `/dev/kfd` (`group render` 993 covers both).
- Only the AMD render node is mapped: stable by-path
  `/dev/dri/by-path/pci-0000:07:00.0-render -> /dev/dri/renderD129`, long-form
  `devices` entry (by-path names contain a colon, short syntax is ambiguous).
  Intel `renderD128` is deliberately NOT mapped.
- Container needs host `render` group access: `LLAMA_RENDER_GID` (host `993`
  verified 2026-10-03 via `stat -c %g /dev/dri/by-path/pci-0000:07:00.0-render`).
- Offload is explicit: `--device ROCm0 --gpu-layers 99` (`ROCm0` verified
  via `--list-devices` on `server-rocm-b11146`). It fails
  loudly if the GPU disappears (no silent CPU fallback).
- Model RAM: Qwen3-14B Q4 (~8.4 GB) needs the 16 GiB host limit; `--cache-ram
512` bounds the host-side prompt cache (default 8192 MiB would squeeze the
  model mmap/offload window against the limit).

## Model

- `${DOCKER_DIR}/llama/models/${LLAMA_MODEL_FILE}` mounted read-only at `/models`.
- `LLAMA_MODEL_FILE=gemma-3-1b-it-Q4_K_M.gguf` (public, ungated, 769 MB).
  Value lives in 1Password (`op://EnvSecrets/RFMEDIA_SECRETS/.env.local/LLAMA_MODEL_FILE`);
  `.env.example` documents the default.
- Add a model: drop any `.GGUF` in the models dir and update the vault field.

## Auth

- Key lives in 1Password (`op://EnvSecrets/RFMEDIA_SECRETS/.env.local/LLAMA_API_KEY`,
  concealed field) and is referenced from ignored `.env.local` — never in
  tracked files.
- Supported provisioning/test key format: exactly 64 lowercase hexadecimal
  characters (256-bit random key). This contract prevents curl-config injection;
  llama.cpp itself accepts other bearer strings.
- Initial setup and rotation use the same command below. First store a generated
  256-bit key in the existing concealed vault field, preserving other fields.
  No key belongs in shell arguments, logs, or tracked files.
- Run from the deployment host as an account that can set ownership to `PUID:PGID`.
  The command reads the existing vault fields, writes mode `0400` with correct
  ownership, fsyncs, then atomically replaces the file. An invalid/empty key or
  ownership failure leaves the previous file intact. No secret is printed.

```bash
python3 - <<'PYKEY'
import os, re, subprocess, tempfile
from pathlib import Path

def read(field):
    result = subprocess.run(
        ["op", "read", "op://EnvSecrets/RFMEDIA_SECRETS/.env.local/" + field],
        capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("1Password read failed for " + field + "; check sign-in/access")
    return result.stdout.rstrip("\n")

key = read("LLAMA_API_KEY")
if not re.fullmatch(r"[0-9a-f]{64}", key):
    raise SystemExit("LLAMA_API_KEY must be 64 lowercase hex characters")
root = read("DOCKER_DIR")
if not root or not Path(root).is_absolute():
    raise SystemExit("DOCKER_DIR must be an absolute path")
uid, gid = int(read("PUID")), int(read("PGID"))
folder = Path(root) / "llama"
folder.mkdir(parents=True, exist_ok=True)
fd, name = tempfile.mkstemp(prefix=".api-keys-", dir=folder)
try:
    with os.fdopen(fd, "wb") as stream:
        os.fchmod(stream.fileno(), 0o400)
        os.fchown(stream.fileno(), uid, gid)
        stream.write((key + "\n").encode("ascii"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, folder / "api-keys")
finally:
    if os.path.exists(name):
        os.unlink(name)
PYKEY
op run --env-file .env.local -- docker compose up -d --no-deps --force-recreate llama
```

Recreation is required after rotation: the existing bind mount still references
old inode after atomic replacement. Never use `docker restart` for this step.

## Image

`ghcr.io/ggml-org/llama.cpp:server-rocm-b11146@sha256:a4d07a...1e9cef`
(pinned amd64-manifest digest). Server target builds with ROCm/HIP support,
entrypoint `/app/llama-server`, healthcheck `curl -f http://localhost:8080/health`.
Note: the `server-rocm-b11146` tag pull resolves to OCI index
`sha256:c3b731...05fba6`; compose pins the amd64 manifest digest directly.

## Verify

```bash
op run --env-file .env.local -- docker compose up -d --no-deps llama
docker exec llama curl -s http://localhost:8080/health
# 401 without key:
docker exec llama curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi"}],"max_tokens":5}'
# Internal and both HTTPS routes, including authenticated generation:
op run --env-file .env.local -- env RUN_LLAMA_CONTRACT_TEST=1 \
  bash scripts/test-llama-service.sh
```

GPU proof: ROCm startup logs report RX 9070 XT, `ROCm0`, 41/41 layers
offloaded, 8161.75 MiB model buffer, 640.00 MiB KV buffer and 136.01 MiB
compute buffer. During Qwen3-14B generation, `gpu_busy_percent` peaked at 98%
and VRAM stayed at 9,756,102,656 bytes (~9.76 GB); offloaded weights remain
resident between requests. Two 200-token runs measured ~49.1 tok/s completion
and ~268–324 tok/s prompt eval. See `docs/plans/llama-amd/plan.md` for
2026-10-03 benchmark settings and timings.

## Limits

- CORS allows all origins (upstream default, flagged at startup). Acceptable:
  API-key auth on all inference routes, no host port. Revisit if threat model changes.

The compose model filename fallback applies only when `LLAMA_MODEL_FILE` is
unset/empty. `.env.example` documents Gemma3 1B; `op run --env-file .env.local`
injects the vault override (currently Qwen3-14B-Q4_K_M), which takes precedence
over compose's fallback. For larger models, review the 16 GiB memory limit,
32768-token context, 300-second health start period and 120-second request
timeout before deployment. Size those limits for measured model RAM and load
time; do not assume Gemma3 limits fit.
