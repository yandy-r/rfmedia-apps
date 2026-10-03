# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

This is a monorepo containing a Docker-based self-hosting platform (47 containerized applications)
and TypeScript CLI tools for orchestration and media management. The platform uses Docker Compose
with extensions to manage multi-container deployments with a focus on security and ease of
management.

**Key Components:**

- `compose.yml` - Docker Compose configuration for all services
- `packages/rfapps-cli` - TypeScript CLI for Docker service orchestration
- `packages/rfmedia-cli` - TypeScript CLI for music library management
- `packages/rf-common` - Shared utilities (logger, progress, prompts)

## Monorepo Structure

```
rfmedia-apps/
├── compose.yml              # Docker service definitions (47 services)
├── .env.example             # Environment template
├── config/                  # Service configurations
│   └── traefik/             # Traefik routing configs
├── packages/
│   ├── rfapps-cli/          # Docker orchestration CLI
│   ├── rfmedia-cli/         # Music library management CLI
│   └── rf-common/           # Shared utilities
└── docs/                    # Comprehensive documentation
```

## Essential Commands

### Monorepo Development

```bash
# Run CLIs in development (no build required)
npm run rfapps -- <command> [options]
npm run rfmedia -- <command> [options]

# Build packages
npm run build:all            # Build all packages
npm run build:rfapps         # Build rfapps-cli only
npm run build:rfmedia        # Build rfmedia-cli only

# Link CLIs globally
npm run link                 # Link both CLIs
npm run link:rfapps          # Link rfapps only

# Testing
npm test                     # Run all tests (watch mode)
npm run test:coverage        # Run with coverage
```

### rfapps CLI Quick Reference

```bash
rfapps status --all              # Show all service status
rfapps deploy -s <service> --yes # Deploy single service
rfapps deploy -g media-stack --yes # Deploy service group
rfapps rebuild -s <service> --yes  # Rebuild service
rfapps plan -s <service>         # Preview changes
rfapps plan --check-updates      # Check for image updates
rfapps lint                      # Check compose production-readiness
```

See `packages/rfapps-cli/README.md` for complete documentation.

## Development Guidelines

### Type Safety

- **Never use `any` type** - Look up types rather than guessing
- Use TypeScript interfaces and discriminated unions
- Prefer strict typing over loose typing

### ESM Module System

All packages use ESM with NodeNext resolution:

```typescript
// Always use .js extensions in imports (even for .ts files)
import { logger } from "../lib/logger.js";
import type { CopyOptions } from "../types/options.js";

// Re-export patterns in index.ts files
export * from "./options.js";
export type { CopyResult } from "./results.js";
```

### Error Handling

- **Throw errors early** - Do not use fallbacks
- Fail fast - catch issues at development time
- Use proper error boundaries and exception handling
- Log errors with sufficient context for debugging

### Command/Action Separation

CLI packages follow a strict separation pattern:

```
commands/  - CLI interface (arguments, options, help text)
actions/   - Business logic (framework-agnostic)
lib/       - Shared utilities
types/     - TypeScript definitions
```

Commands parse arguments and delegate to actions. Actions contain all business logic.

### Lazy Loading for Performance

Action handlers are dynamically imported for faster CLI startup:

```typescript
// In command handler
const { executeAction } = await import("../actions/my-action.js");
result = await executeAction(options);
```

### Testing Expectations

- Write tests for new features and bug fixes
- Use Vitest for all test files
- Mock external dependencies (filesystem, network, Docker)
- Test error conditions and edge cases

## Architecture Quick Reference

### Service Categories

| Category       | Count | Key Services                                              |
| -------------- | ----- | --------------------------------------------------------- |
| Core           | 9     | Traefik, Authentik                                        |
| Infrastructure | 15    | Uptime Kuma, Homarr, StirlingPDF                          |
| Downloads      | 4     | SABnzbd, Prowlarr                                         |
| Arr-Stack      | 12    | Sonarr, Radarr, Bazarr, Autobrr                           |
| Media          | 11+   | Plex, Plex Music, Tautulli, Plexseerr, Jellyseerr, Kometa |
| Photos         | 5     | Immich                                                    |

### Network Architecture

- Custom bridge network `apps` for inter-service communication
- Traefik reverse proxy with Authentik forward authentication
- **Docktail** for Tailscale Services (Traefik)
- **tsdproxy-rfapps** for shareable hosts (`git`, `plex`, `plex-music`, `jellyfin`, `images`)
- Sidecar linking disabled in `rfapps.config.yaml` (`sidecars.enabled: false`)

### Key Environment Variables

| Variable                        | Purpose                              |
| ------------------------------- | ------------------------------------ |
| `DOCKER_DIR`                    | Service configuration files location |
| `DOCKER_DATA_DIR`               | Service data storage location        |
| `DATA_DIR`                      | Media files location                 |
| `TZ`                            | Timezone                             |
| `PUID` / `PGID`                 | User/group IDs for file permissions  |
| `DOMAIN`                        | Primary domain (infrastructure)      |
| `DOMAIN2`                       | Secondary domain (media services)    |
| `TAILSCALE_OAUTH_CLIENT_ID`     | Docktail OAuth client ID             |
| `TAILSCALE_OAUTH_CLIENT_SECRET` | Docktail OAuth client secret         |

## Modifying compose.yml Services

When adding or modifying services:

1. **Use Docker Compose extensions:**
   - `<<: *service-base` - Restart policy and pull behavior
   - `logging: *logging-default` - Standard logging
   - `<<: *common-env` - TZ/PUID/PGID environment variables
   - For Tailscale Services: add `docktail.service.*` labels (see `traefik`)
   - For shareable hosts: add `tsdproxy.*` labels with `<<: *tsdproxy-rfapps` (see `plex`, `forgejo`)

2. **Assign service profiles:**
   - `core` / `infrastructure` / `downloads` / `arr-stack` / `media` / `photos`
   - Always include `all` profile

3. **Mount paths:**
   - Configuration: `${DOCKER_DIR}/[service-name]`
   - Data: `${DOCKER_DATA_DIR}/[service-name]` or `${DATA_DIR}` for media

4. **Network:**
   - Use `apps` network with explicit `hostname`
   - Use `apps` network with explicit `hostname` for all services
   - Add Docktail labels when direct tailnet access is required (media streaming, etc.)

5. **Traefik labels** (for web services):
   - Enable Traefik routing
   - Configure HTTPS with Let's Encrypt
   - Apply Authentik middleware (`authentik-dev` or `authentik-media`)

See `docs/features/docker-compose-extensions.md` for extension patterns and
`docs/features/traefik-reverse-proxy.md` for label examples.

## Sidecar Linking (CLI feature — inactive in this repo)

The rfapps CLI supports optional sidecar linking when `sidecars.enabled: true` in config. This
deployment uses Docktail only; `rfapps.config.yaml` has `sidecars.enabled: false` and an empty
mapping.

```bash
rfapps rebuild -s plex --yes              # Operates on plex only
rfapps deploy -g infra-stack --yes        # Includes docktail + traefik
```

Sidecar mappings are defined in `rfapps.config.yaml` or `.rfapps.yaml` under `sidecars.mapping`.

## Config File Secrets Injection

Both CLI tools support template-based secrets using `{{ VAR_NAME }}` syntax:

```yaml
# .rfmedia.yaml or .rfapps.yaml
plex:
  token: "{{ PLEX_TOKEN }}"
```

Templates resolve from environment variables at config load time. Use with `--use-dotenvx` or
`--use-op` for secrets injection.

**Alternative for Plex:** instead of supplying a token at all, enroll the device with
`rfmedia plex auth login`. The resulting credential lives in an out-of-band `0600` store
(`~/.config/rfmedia/plex-auth/store.json`, relocatable with `RFMEDIA_PLEX_AUTH_DIR`), never in a
config file, and is therefore not `{{ VAR }}`-templated. See
`packages/rfmedia-cli/docs/features/plex-configuration.md`.

## Package-Specific Guidance

Each package has its own CLAUDE.md with detailed AI guidance:

- `packages/rfmedia-cli/CLAUDE.md` - Music CLI patterns, discriminated unions, smart filters,
  testing patterns
- `packages/rfapps-cli/CLAUDE.md` - Docker orchestration patterns, plan/apply workflow, state
  persistence
- `packages/rf-common/CLAUDE.md` - Shared utilities patterns (logger, progress, prompts, secrets)

## Documentation References

Detailed documentation is in `docs/`:

| Topic                     | Location                                     |
| ------------------------- | -------------------------------------------- |
| Getting Started           | `docs/guides/getting-started.md`             |
| Quick Reference           | `docs/features/quick-reference.md`           |
| Environment Variables     | `docs/reference/environment-variables.md`    |
| Traefik Setup             | `docs/features/traefik-reverse-proxy.md`     |
| Tailscale Integration     | `docs/features/tailscale-integration.md`     |
| Docker Compose Extensions | `docs/features/docker-compose-extensions.md` |
| Sidecar Linking           | `docs/features/sidecar-linking.md`           |
| Secrets Management        | `docs/features/secrets-management.md`        |
| Troubleshooting           | `docs/guides/troubleshooting.md`             |

## GitHub Contribution Templates

When creating GitHub issues or pull requests, all coding agents must follow repository templates
exactly.

### Issue Templates (Required)

- Always use GitHub issue forms from `.github/ISSUE_TEMPLATE/`; do not open blank issues.
- Choose the correct form:
  - Enhancement: `.github/ISSUE_TEMPLATE/enhancement.yml`
  - Bug: `.github/ISSUE_TEMPLATE/bug.yml`
  - Question: `.github/ISSUE_TEMPLATE/question.yml`
  - Documentation: `.github/ISSUE_TEMPLATE/docs.yml`
  - Chore: `.github/ISSUE_TEMPLATE/chore.yml`
  - Security hardening (public-safe only): `.github/ISSUE_TEMPLATE/security.yml`
- For exploitable vulnerabilities or sensitive security details, do not use public issues; use
  private reporting from `.github/ISSUE_TEMPLATE/config.yml` (`Private Security Report` link).

### Pull Request Template (Required)

- Always use `.github/pull_request_template.md` as the PR body baseline.
- Preserve required sections:
  - `## Summary`
  - `## Changes`
  - `## Testing`
  - `## Related Issues` (use `Closes #<issue-number>` when applicable)
  - `## Breaking Changes`
  - `## Risk and Rollback`
  - `## Checklist`
- Include exact verification commands and pass/fail outcomes in `## Testing`.

### Agent Markdown Mirrors

- For offline drafting, automation, or agent-generated artifacts, use markdown mirrors in
  `docs/templates/github/`.
- Mirror files are drafting aids only; GitHub issue forms and PR template remain the source of truth
  for final submissions.

## Code Quality Standards

- Use markdownlint guidelines for all markdown files
- All markdown headings should be surrounded by a newline
- Run `npm run format` before committing
- Prefer editing existing files over creating new ones
- Keep functions small and focused on single responsibility

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
