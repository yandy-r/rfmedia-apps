# Evidence Verification Log

## High-Confidence Findings

### Docker Compose Market Dominance

- **Claimed by**: Journalist, Historian, Futurist, Contrarian
- **Primary sources**: 2025 Self-Hosted Survey (3,700 respondents, deployn.de), Docker 2026 enterprise adoption data
- **Verification status**: Confirmed
- **Confidence**: High
- **Key data**: 87.6% self-hosting adoption, 92% enterprise, 31.7% CLI-only

### No Competitor Has Plan/Apply for Docker Compose

- **Claimed by**: Journalist, Historian, Negative Space Explorer
- **Primary sources**: Direct competitive analysis of Portainer, Dockge, CasaOS, Cosmos-Server, Yacht, Komodo, Arcane, Coolify
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Docker Compose native `--dry-run` exists but limited to syntax/config validation

### Feature Creep Kills Docker Ecosystem Tools

- **Claimed by**: Contrarian, Systems Thinker, Historian, Archaeologist
- **Primary sources**: Flynn shutdown (2021), Deis acquisition (2018), CasaOS GitHub activity, Algorand SDK changelog, Spotify Helios archive
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: 100% of documented Compose wrappers that expanded scope aggressively either died or faced backlash

### Watchtower Archived December 2025

- **Claimed by**: Negative Space Explorer, Journalist
- **Primary sources**: Watchtower GitHub repository archive notice
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Incompatible with Docker 28+; 21.9% of self-hosters were using it

### State Persistence as Competitive Moat

- **Claimed by**: Journalist, Analogist, Contrarian, Systems Thinker, Historian, Negative Space Explorer
- **Primary sources**: Docker Compose architecture documentation (stateless by design), Terraform state model, Nix generation model
- **Verification status**: Confirmed (architectural analysis)
- **Confidence**: Very High
- **Notes**: 6/8 independent persona convergence; Docker Compose adding state would require fundamental architectural change

## Medium-Confidence Findings

### MCP Protocol Trajectory

- **Claimed by**: Futurist (bullish), Contrarian (bearish)
- **Supporting sources**: Docker MCP investment (270+ servers), Docker Desktop 4.50, Docker MCP Gateway
- **Conflicting sources**: Gartner 40%+ cancellation prediction, MCP OAuth immaturity, "not good yet" critiques
- **Verification status**: Partially confirmed (investment is real; maturity is questionable)
- **Confidence**: Medium
- **Notes**: Both Gartner predictions cited (70% deployment AND 40% cancellation)

### Self-Hosting Market Growth

- **Claimed by**: Futurist, Historian
- **Supporting sources**: Market projections ($85.2B by 2034), cloud repatriation trends
- **Conflicting sources**: No direct user adoption data for CLI tools specifically
- **Verification status**: Partially confirmed (market size projections are inherently uncertain)
- **Confidence**: Medium

### Docker Compose Go SDK Impact

- **Claimed by**: Systems Thinker, Historian, Futurist
- **Supporting sources**: Docker Compose v5 release notes
- **Verification status**: Confirmed (SDK exists)
- **Confidence**: Medium (impact on TypeScript ecosystem is uncharacterized)
- **Notes**: Go-only; no TypeScript SDK exists or is planned

## Contradictions Requiring Resolution

### Feature Addition vs. Restraint

- **Position A**: Real gaps exist causing real pain (Analogist, Archaeologist, Negative Space, Futurist)
- **Position B**: Every feature is a permanent liability (Contrarian, Systems Thinker)
- **Evidence for A**: Gap analysis, cross-domain patterns, user pain documentation
- **Evidence for B**: 6+ documented tool failures from complexity
- **Resolution**: Five-question feature filter operationalizes this tension

### Docker Compose Dry-Run: Threat or Validation?

- **Position A**: Dry-run threatens plan/apply (Systems Thinker, Contrarian)
- **Position B**: Dry-run validates problem space while limited to syntax checking (Journalist)
- **Evidence for A**: Docker Compose v5 feature expansion trajectory
- **Evidence for B**: Current dry-run limitations documented
- **Resolution**: Time-horizon dependent; rfapps-cli's historical-state comparison permanently beyond dry-run's reach

### Podman Support Urgency

- **Position A**: 7.3% adoption; engineering vanity (Contrarian)
- **Position B**: Diversifying landscape; hedge architecturally (Futurist, Historian)
- **Resolution**: Converged -- define interface, don't implement (both recommend this at different specificity levels)
