# Research Objective: rfapps-cli Advanced Features & Enhancements

## Context

rfapps-cli is a TypeScript CLI for Docker Compose orchestration managing 47+ containerized
applications in a self-hosting platform. It replaces a legacy bash script with type-safe,
feature-rich tooling.

### Current Features (Implemented)

- **Service lifecycle**: deploy, rebuild, stop, delete, prune with multi-phase workflows
- **Plan/Apply workflow**: Terraform-inspired deployment preview with diff (image, env, ports,
  volumes, networks)
- **State persistence**: SQLite-based deployment history with rollback capabilities
- **Parallel operations**: Dependency-aware parallel deploy/rebuild with topological sorting
- **Health checks**: Dependency readiness waiting (container state + TCP probes)
- **Sidecar linking**: Automatic Tailscale sidecar expansion with force-recreate
- **Interactive selection**: Ink-based multi-select with status indicators and type-ahead
- **Error handling**: Custom error classes with fuzzy-match "Did you mean?" suggestions
- **Multiple output formats**: JSON, YAML, CSV, table, text for scripting
- **Secrets integration**: dotenvx and 1Password CLI support
- **Shell completion**: bash, zsh, fish with dynamic service name completion
- **MCP server mode**: Expose rfapps tools over stdio JSON-RPC for AI agents
- **Configuration**: Layered YAML config (project/XDG/home) with validation
- **Image update detection**: Registry digest comparison without pulling

### Open GitHub Issues (rfapps-cli)

1. **#73** [priority:high] Unit Test Suite (Vitest)
2. **#68** [priority:high] Exit Code Standardization
3. **#70** [priority:medium] Integration Tests with Mock Docker
4. **#66** [priority:medium] Silence by Default
5. **#65** [priority:medium] State Locking
6. **#64** [priority:medium] Service Conflict Detection
7. **#63** [priority:medium] Hierarchical Service Tagging
8. **#74** [priority:medium] Contextual Help with Examples
9. **#72** [priority:low] Container Runtime Abstraction (Podman/nerdctl Support)
10. **#62** [priority:low] Smart Service Groups (Dynamic Criteria)
11. **#75** [priority:low] Interactive Tutorial Mode

### Closed/Completed Issues

- #104 - Tab completion (done)
- #71 - MCP Server Support (done)
- #69 - Parallel Service Operations (done)
- #67 - JSON Output for All Commands (done)
- #61 - State File with Deployment History (done)
- #60 - Service Fingerprinting (done)
- #59 - Better Error Messages (done)
- #58 - Smart Dependency Waiting (done)

### Tech Stack

- TypeScript (ES2022), Node.js 22+, ESM
- Commander.js v14, better-sqlite3, listr2, Ink
- Docker Compose integration via subprocess
- @rfmedia/common shared utilities

## Core Research Questions

1. What advanced Docker orchestration features exist in competing tools (Portainer, Dockge, CasaOS,
   Cosmos-Server, Yacht, etc.) that rfapps-cli should consider?
2. What infrastructure-as-code patterns from Terraform, Pulumi, and similar tools could enhance the
   plan/apply workflow?
3. What modern CLI UX patterns and innovations could improve the developer experience?
4. What monitoring, observability, and alerting features are common in self-hosting platforms?
5. What security hardening and audit features would strengthen the platform?
6. Which of the open GitHub issues should be prioritized, and what additional features are missing
   entirely?

## Success Criteria

- [ ] All 8 personas deployed with distinct search strategies
- [ ] Minimum 8-10 parallel searches per persona executed
- [ ] Contradictions and disagreements captured, not smoothed over
- [ ] Evidence hierarchy applied (primary > secondary > synthetic > speculative)
- [ ] Cross-domain analogies explored
- [ ] Temporal range covered (past, present, future)

## Evidence Standards

- Primary sources preferred over secondary analysis
- Citations required for all claims
- Confidence ratings assigned to findings
- Contradictions explicitly documented

## Potential Biases to Guard Against

- Recency bias - not all new features are needed; some are hype-driven
- Feature creep - more features != better tool; simplicity has value
- Survivorship bias - looking only at successful tools, not ones that failed from complexity
