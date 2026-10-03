# Llama AMD (RX 9070 XT) plan

Goal: `llama` service on `apps` network, Vulkan GPU inference on AMD gfx1201, Traefik + tsdproxy HTTPS API with native API-key auth, no Authentik.

## Research (verified, not trusted blindly)

- Image: `ghcr.io/ggml-org/llama.cpp:server-vulkan-b11146`.
  Upstream `vulkan.Dockerfile@b11146` (fetched 2026-10-03): `cmake -DGGML_VULKAN=ON`,
  runtime has `libvulkan1 mesa-vulkan-drivers`, `ENTRYPOINT ["/app/llama-server"]`,
  `ENV LLAMA_ARG_HOST=0.0.0.0`,
  `HEALTHCHECK CMD ["curl","-f","http://localhost:8080/health"]`.
- Flags to verify from image `--help`: `--model --host --port --ctx-size -ngl --list-devices`
  plus Vulkan device-select flag (candidate: check `--help` output, do not assume).
- Host: kernel 7.0.0-38, `pci-0000:07:00.0-render -> renderD129` (AMD, `render` gid 993),
  Intel `renderD128` must NOT be mapped. Vulkan needs host amdgpu only, no ROCm/CUDA.
- Model: Gemma3 1B Q4_K_M GGUF (769 MB) proof; runtime selection from vault
  `LLAMA_MODEL_FILE` overrides the documented compose fallback. Dedicated
  `${DOCKER_DIR}/llama/models`, never Immich `model-cache`.

## Design

- `compose.yml`: `llama` block, `*service-base` + `*logging-default`, `apps` network,
  internal `expose: ["8080"]`, no host ports, Traefik `llama.${DOMAIN}` + tsdproxy provider `rfapps`
  host `llama` on `443/https:8080/http`, no Authentik, no privileged, no kfd,
  `devices: [/dev/dri/by-path/pci-0000:07:00.0-render:/dev/dri/renderD129]`,
  `-ngl 99`, explicit GPU device flag, healthcheck on `/health`,
  `deploy.resources.limits` cpus 4 / memory 4G / pids 128.
- `rfapps.config.yaml`: `llama` in `infra-stack` + `profiles.mapping` infrastructure.
- `.env.example`: `LLAMA_MODEL_FILE` (+ doc default), `LLAMA_API_KEY` vault reference.
  Native `--api-key-file` auth, atomically provisioned 0400 `PUID:PGID` key file.
- `docs/services/llama-setup.md`: concise setup/verify/troubleshoot.
- `scripts/test-llama-service.sh`: contract check gated on `RUN_LLAMA_CONTRACT_TEST=1`
  (compose contract via `.env.example`, probe container on `apps` net, `/health` +
  completion tokens + PCI-address GPU metrics, both HTTPS endpoints return 401
  without key and generate with key). No new frameworks (bash+curl+node).

## Status: implemented and verified (2026-10-03)

Evidence: `/health` → `{"status":"ok"}`; chat completion returned tokens
(~148 tok/s, 400-token run); startup logs show `Vulkan0 : AMD Radeon RX
9070 XT (RADV GFX1201)` and `offloaded 27/27 layers to GPU`,
`Vulkan0 model buffer size = 762.49 MiB`; `gpu_busy_percent` peaked 83%,
VRAM ~1.0 GB during generation. Only container added: `llama` (no other
service recreated). rfapps lint llama: 0 findings; markdownlint: 0 errors;
rfapps tests 1835 passed.

## Endpoint/auth continuation (2026-10-03)

Both HTTPS endpoints verified: `https://llama.example.com` (Traefik) and
`https://llama.tailnet-name.ts.net` (tsdproxy). Native auth rejects missing key
with 401; authenticated generation works; `/health` stays public. Key remains
concealed in `EnvSecrets/RFMEDIA_SECRETS`, `.env.local` section, `LLAMA_API_KEY`.
No model files deleted. Runtime model selection remains the vault's choice.
Larger models require measured memory/load-time sizing beyond current 4 GiB,
60-second health start period and 120-second request timeout.

## ROCm switch (2026-10-03)

Image changed from `server-vulkan-b11146` (RADV, Vulkan0) to
`ghcr.io/ggml-org/llama.cpp:server-rocm-b11146` (ROCm/HIP, `--device ROCm0`,
gfx1201). Device name `ROCm0` was verified from the image’s `--list-devices`
output. The `server-rocm-b11146` tag pull resolves to OCI index
`sha256:c3b731..`; compose pins the amd64 manifest digest directly
(`sha256:a4d07a..`). Devices are the AMD render node plus `/dev/kfd`
(`group render` 993). Memory limit went 4G to 16G with `--cache-ram 512`
because Qwen3-14B-Q4_K_M (~8.4 GB) needs a wider mmap/offload window than the
Gemma3-1B-era defaults.

Benchmark (Qwen3-14B-Q4_K_M, internal `/completion`, prompt “Describe the water
cycle in clear, neutral language.”, `n_predict=200`, `temperature=0`,
`seed=42`, `cache_prompt=false`, `ignore_eos=true`, two runs):

- Run 1: wall 4.24s; prompt 267.9 tok/s (10 tokens, 37.33 ms); completion
  49.08 tok/s (200 tokens, 4054.56 ms); GPU busy peak 98%; VRAM steady 9.76 GB.
- Run 2: wall 4.24s; prompt 324.3 tok/s (10 tokens, 30.84 ms); completion
  49.13 tok/s (200 tokens, 4050.56 ms); GPU busy peak 98%; VRAM steady 9.76 GB.

Startup logs show `ROCm0 : AMD Radeon RX 9070 XT (16304 MiB, 16238 MiB free)`,
`using device ROCm0`, `offloaded 41/41 layers to GPU`, `ROCm0 model buffer size
= 8161.75 MiB`, KV buffer 640.00 MiB and compute buffer 136.01 MiB. Earlier
Vulkan/Gemma numbers (~148 tok/s, 27/27 layers, ~1 GB VRAM) reflect a smaller
model and a different benchmark shape (400-token chat run), so they are not
comparable to these figures. The contract test still passes health, 401 without
key, authenticated generation, GPU proof and both HTTPS ingress paths.
