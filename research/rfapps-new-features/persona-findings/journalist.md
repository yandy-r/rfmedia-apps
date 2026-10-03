# The Journalist: Current State of Docker Orchestration CLI Tools & Self-Hosting Platform Management (2024-2026)

## Executive Summary

The self-hosting ecosystem in 2025-2026 is experiencing a maturation wave. Docker Compose remains the dominant orchestration method (87.6% adoption per the 2025 Self-Host Survey), but the tools wrapping it have diversified significantly. Portainer retains market leadership at 40.8% adoption among container management helpers, yet a clear fragmentation trend is underway: Dockge (14.9%) has carved out a compose-first niche, Coolify (50.5k GitHub stars) is redefining PaaS self-hosting, and newcomers like Komodo (10.1k stars) and Arcane (4.5k stars) are gaining rapid traction. Meanwhile, Docker Inc. has pivoted hard into AI/MCP integration, and the community increasingly demands simplicity over feature density. The plan/apply workflow pattern that rfapps-cli implements remains rare in the self-hosting space -- no major competitor has adopted a Terraform-style preview model for Docker Compose deployments, representing a genuine differentiator.

**Confidence**: High -- based on multiple authoritative sources including the 2025 Self-Host User Survey (4,081 respondents via selfh.st, 850+ via deployn.de), GitHub repository metrics, and extensive community discourse.

---

## Current State of the Art

### Container Management Adoption (2025 Self-Host Survey)

The deployn.de Self-Hosted Survey 2025 (850+ respondents) provides the clearest snapshot of the ecosystem:

| Technology          | Adoption Rate |
| ------------------- | ------------- |
| Docker Compose      | 87.6%         |
| Docker (standalone) | 73.6%         |
| LXC                 | 30.1%         |
| Kubernetes          | 9.6%          |
| Podman              | 7.3%          |

**Container Management Helpers:**

| Tool            | Adoption Rate |
| --------------- | ------------- |
| Portainer       | 40.8%         |
| None (CLI only) | 31.7%         |
| Watchtower      | 21.9%         |
| Dockge          | 14.9%         |
| Cockpit         | 6.6%          |
| Lazydocker      | 2.5%          |
| Rancher         | 2.3%          |
| Coolify         | 2.0%          |

**Confidence**: High -- primary survey data from 2025 with large sample sizes.

Source: [Self-Hosted Survey 2025](https://selfhosted-survey-2025.deployn.de/), [selfh.st 2025 Results](https://selfh.st/survey/2025-results/)

### Reverse Proxy Landscape

| Reverse Proxy       | Adoption Rate |
| ------------------- | ------------- |
| Nginx Proxy Manager | 36.0%         |
| Traefik             | 29.1%         |
| Caddy               | 23.2%         |
| Nginx (raw)         | 17.6%         |

Pangolin is the notable newcomer of 2025 -- a self-hosted tunneled reverse proxy combining WireGuard VPN tunnels with reverse proxy capabilities, serving as a Cloudflare Tunnel alternative. It has been described as "dominating since January" in the selfh.st 2025 favorites list.

**Confidence**: High -- survey data corroborated by multiple community sources.

Sources: [Self-Hosted Survey 2025](https://selfhosted-survey-2025.deployn.de/), [Pangolin GitHub](https://github.com/fosrl/pangolin), [Pangolin noted.lol](https://noted.lol/pangolin/)

---

## Key Players and Their Features

### Tier 1: Established Leaders

#### Portainer (36.5k GitHub Stars, est. 2017)

**Status**: Market leader, increasingly enterprise-focused.

| Attribute    | Detail                            |
| ------------ | --------------------------------- |
| Stars        | 36,484                            |
| Architecture | Go backend, React frontend        |
| License      | Zlib (CE), Proprietary (BE)       |
| Target       | Teams, enterprises, multi-cluster |

**Key Features:**

- Full Docker, Swarm, and Kubernetes management from a single interface
- Role-based access control (RBAC) with team management
- Git integration and GitOps workflows
- Template marketplace with 1-click deployments
- Multi-environment management (local, remote, cloud)
- Docker Hub browser, image management, and registry integration
- Network and volume management with visual dashboards
- User permissions, audit logs, and compliance features (Business Edition)

**Business Edition Premium Features:**

- Registry management with vulnerability scanning
- External authentication (LDAP, OAuth, SAML)
- Activity logs and RBAC at enterprise scale
- Automated edge device management

**Community Sentiment**: Still the default recommendation for beginners, but experienced homelabbers increasingly see it as "bloated" for simple compose workflows. Multiple articles titled "I ditched Portainer" or "Forget about Portainer" indicate a sentiment shift toward lighter alternatives. Resource consumption (150-300 MB RAM) is a frequent complaint for Raspberry Pi users.

**Confidence**: High -- multiple authoritative sources, direct GitHub data.

Sources: [Portainer GitHub](https://github.com/portainer/portainer), [BetterStack Comparison](https://betterstack.com/community/comparisons/docker-ui-alternative/), [homelabsec.com](https://homelabsec.com/posts/portainer-vs-dockge/)

#### Dockge (22k GitHub Stars, est. Late 2023)

**Status**: Fastest-growing compose management tool, community darling.

| Attribute    | Detail                      |
| ------------ | --------------------------- |
| Stars        | 22,000                      |
| Architecture | TypeScript/Vue, Socket.io   |
| License      | MIT                         |
| Target       | Compose-centric homelabbers |
| Latest       | v1.5.0 (March 2025)         |

**Key Features:**

- Compose-centric design with interactive YAML editor
- File-system-based storage (not database) -- compose files remain accessible to other tools
- Real-time reactive UI with live progress updates
- Multi-host management via agent support (v1.4.0+)
- Convert `docker run` commands to compose.yaml
- Web-based terminal interface
- Lightweight: 50-100 MB RAM (vs Portainer's 150-300 MB)
- Runs on Raspberry Pi 3 and similar low-power devices

**What Dockge Does NOT Do:**

- No Kubernetes support
- No RBAC or multi-user management
- No standalone container management (stacks only)
- No built-in monitoring graphs
- No image management or Docker Hub browsing

**Community Sentiment**: Overwhelmingly positive. Created by Louis Lam (Uptime Kuma creator), which gives it credibility. The philosophy of "your compose files, on your filesystem" resonates strongly with users who want tools that don't create vendor lock-in. Multiple XDA Developers and tech blog articles document users switching from Portainer to Dockge.

**Confidence**: High -- GitHub metrics, extensive community coverage, direct comparison articles.

Sources: [Dockge GitHub](https://github.com/louislam/dockge), [XDA Developers](https://www.xda-developers.com/forget-portainer-simple-tool-dockge/), [BigMike.help](https://bigmike.help/en/posts/dockge-why-i-switched-from-portainer-to-this-lightweight-tool-and-recomme-2f9da9/)

### Tier 2: Rising Challengers

#### Coolify (50.5k GitHub Stars, est. 2022)

**Status**: Dominant open-source PaaS, Heroku/Vercel alternative.

| Attribute    | Detail                                |
| ------------ | ------------------------------------- |
| Stars        | 50,500                                |
| Architecture | PHP/Laravel backend, JS/Vite frontend |
| License      | Apache 2.0                            |
| Target       | Developers wanting PaaS experience    |

**Key Features:**

- Full PaaS: git push to deploy, automated builds, SSL, domains
- 280+ one-click service deployments
- Multi-server management via SSH
- Git integration (GitHub, GitLab, Bitbucket, Gitea)
- Database management (MySQL, PostgreSQL, MongoDB, MariaDB, Redis)
- Automated backups and environment management
- Preview deployments for pull requests
- Webhook-based auto-deploy on git push
- Notification integrations (Slack, Discord, Telegram, Email)
- Centralized logging, encrypted secrets, persistent volumes

**Important Distinction**: Coolify is NOT a Docker management tool like Portainer -- it is a deployment platform. It abstracts Docker away rather than exposing it. This makes it more comparable to Vercel/Railway than to Portainer/Dockge.

**Community Sentiment**: Extremely positive. 50.5k stars makes it the most-starred project in the self-hosting platform category. However, only 2.0% adoption in the self-hosted survey suggests many users star it but don't deploy it for homelab use. Its value proposition is stronger for VPS-based deployments and developer workflows than for traditional homelab docker-compose management.

**Confidence**: High -- GitHub data, extensive documentation, multiple comparison articles.

Sources: [Coolify GitHub](https://github.com/coollabsio/coolify), [Coolify.io](https://coolify.io/), [Northflank Alternatives](https://northflank.com/blog/coolify-alternatives-in-2026)

#### Komodo (10.1k GitHub Stars, est. 2023)

**Status**: Rapidly growing multi-server Docker management platform.

| Attribute    | Detail                            |
| ------------ | --------------------------------- |
| Stars        | 10,100                            |
| Architecture | Rust backend, TypeScript frontend |
| License      | GPL-3.0                           |
| Target       | Multi-server Docker/Podman users  |
| Latest       | v1.19.5 (September 2025)          |

**Key Features:**

- Multi-server management with core-periphery architecture (lightweight agents)
- Docker and Podman support
- Build system: auto-versioned images from Git repos, webhook triggers
- Docker Compose stack deployment from UI, files, or Git repos
- User management with OIDC/OAuth integration (GitHub, Google)
- Server performance monitoring and alerting
- Automated deployment procedures
- API-driven automation with no artificial limits
- No "Business Edition" -- all features free and open-source

**What Makes Komodo Distinctive**: Written in Rust for performance, no premium tier, and explicit "no limit" philosophy on servers, API access, and features. Positions itself against Portainer's freemium model.

**Community Sentiment**: Growing enthusiasm, especially from users frustrated with Portainer's business edition limitations. The Rust backend appeals to performance-conscious users.

**Confidence**: Medium-High -- GitHub metrics are strong, community coverage increasing but still limited compared to established players.

Sources: [Komodo GitHub](https://github.com/moghtech/komodo), [komo.do](https://komo.do/), [noted.lol](https://noted.lol/komodo/)

#### Cosmos-Server (5.7k GitHub Stars, est. 2023)

**Status**: Security-first all-in-one home server platform.

| Attribute    | Detail                          |
| ------------ | ------------------------------- |
| Stars        | 5,700                           |
| Architecture | Go backend, JavaScript frontend |
| License      | Apache 2.0 + Commons Clause     |
| Target       | Security-conscious self-hosters |
| Latest       | v0.20.2 (January 2026)          |

**Key Features:**

- SmartShield: AI-driven anti-bot, anti-DDOS, behavioral rate limiting
- Built-in reverse proxy with automatic HTTPS (Let's Encrypt, wildcard DNS)
- OpenID/SSO authentication server with 2FA for any container
- Constellation VPN (WireGuard-based mesh networking)
- App Store with automatic updates and security checks
- Docker container orchestration with compose import
- Incremental encrypted backups (Restic-based)
- Disk management (parity drives, MergerFS)
- Real-time monitoring with historical data
- Network storage management (RClone, NFS, FTP, Dropbox)
- User invitation system for family/friends

**Security Philosophy**: Cosmos assumes deployed applications cannot be trusted. SmartShield implements dynamic rate limiting, adaptive throttling, automatic strike/ban systems, and global request queuing -- features no other self-hosting platform offers.

**What Makes Cosmos Distinctive**: It is the only platform combining reverse proxy, authentication, VPN, monitoring, backups, and container management in a single deployment. Aimed at users who want a "one stop shop" without stitching together Traefik + Authentik + WireGuard + Portainer separately.

**Community Sentiment**: Strong praise from users seeking simplicity, some concern about the Commons Clause license restricting commercial use. January 2026 review from VirtualizationHowto called it potentially "the best home server OS."

**Confidence**: Medium -- solid GitHub metrics but smaller community; the Commons Clause license limits broader adoption.

Sources: [Cosmos-Server GitHub](https://github.com/azukaar/Cosmos-Server), [cosmos-cloud.io](https://cosmos-cloud.io/), [XDA Developers](https://www.xda-developers.com/cosmos-server-best-manage-server-deploy-apps/)

#### Arcane (4.5k GitHub Stars, est. 2024)

**Status**: Fast-moving modern Portainer alternative.

| Attribute    | Detail                      |
| ------------ | --------------------------- |
| Stars        | 4,500                       |
| Architecture | Go backend, Svelte frontend |
| License      | Open source                 |
| Target       | Modern Docker management    |
| Latest       | v1.14.1 (February 2026)     |

**Key Features:**

- Docker Compose stack management with templates
- Multi-environment remote Docker host management
- Live container status, resource usage, and log monitoring
- Docker event viewer with details dialog
- Automatic image updates (Watchtower-like)
- OIDC authentication support
- Mobile-responsive interface
- Native pruning tools for housekeeping
- Docker events visible in UI

**What Makes Arcane Distinctive**: Backend rewritten to Go in v1.0 (September 2025), Svelte frontend for modern reactive UI. Rapid development velocity with 56 releases. Mobile-first design. Listed in selfh.st 2025 favorites as a notable new app.

**Community Sentiment**: Early enthusiasm. Seen as a "fresh" alternative to Portainer without the legacy complexity. Named by selfh.st as one of the favorite self-hosted apps launched in 2025.

**Confidence**: Medium -- young project with strong momentum but limited production adoption data.

Sources: [Arcane GitHub](https://github.com/getarcaneapp/arcane), [noted.lol](https://noted.lol/arcane/), [selfh.st](https://selfh.st/post/2025-favorite-new-apps/)

### Tier 3: Niche/Platform Players

#### CasaOS

An open-source "home cloud" interface built on Docker, targeting complete beginners. Users report deploying complex stacks in under 5 minutes. App-store-first model. Less relevant for power users who manage compose files directly.

**Confidence**: Medium -- well-known but limited recent technical coverage.

#### Yacht

A modern, clean Docker management UI focusing on simplicity with one-click deployment templates and a mobile-friendly interface. Limited user permission controls. Development appears slower than competitors.

**Confidence**: Medium -- older project, less recent community activity.

#### Runtipi (est. 2022)

A personal homeserver orchestrator with nearly 300 apps, web dashboard management, one-click installs, and automated SSL. Recently added native docker-compose.yml syntax support with x-runtipi meta tags. Targets the "personal cloud" use case more than Docker management.

**Confidence**: Medium -- active project but niche positioning.

Sources: [Runtipi.io](https://runtipi.io/), [Runtipi GitHub](https://github.com/runtipi/runtipi)

#### Dokploy

Open-source PaaS alternative to Vercel/Netlify/Heroku. Supports Docker, Nixpacks, Heroku Buildpacks. Traefik integration. Multi-server deployment. Competes directly with Coolify. Gaining traction in 2025.

**Confidence**: Medium -- growing but smaller than Coolify.

Sources: [Dokploy GitHub](https://github.com/Dokploy/dokploy), [Dokploy.com](https://dokploy.com/)

#### Lazydocker

Terminal UI for Docker management with minimal resource consumption. Keyboard-driven workflows, real-time resource monitoring. 37.9k GitHub stars but only 2.5% adoption in the self-hosted survey. Appeals to CLI purists but lacks compose-centric workflows and multi-server management.

**Confidence**: High -- well-established project with clear metrics.

Sources: [Lazydocker GitHub](https://github.com/jesseduffield/lazydocker), [Self-Hosted Survey 2025](https://selfhosted-survey-2025.deployn.de/)

---

## Latest Developments (Past 12 Months)

### Docker Compose v2 Evolution

Docker Compose continues to evolve with significant new features:

| Feature                | Status           | Details                                                                         |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `docker compose watch` | Production-ready | Real-time file sync for development. `initial_sync` added September 2025        |
| `--dry-run` flag       | Stable           | Tests commands without changing stack state, works with almost all commands     |
| Profiles               | Stable           | Conditional service inclusion based on deployment context                       |
| Compose Bridge         | New              | Convert Compose files to Kubernetes manifests or Helm charts                    |
| Docker Offload         | New              | Shift workloads to cloud environments                                           |
| AI/LLM support         | New              | Native support for LangGraph, Vercel AI SDK; Docker Model Runner for local LLMs |
| GPU acceleration       | New              | LLM deployment with GPU passthrough                                             |
| Cloud Deploy           | New              | Direct deployment to Google Cloud Run or Azure Container Apps                   |

**Current Version**: Docker Compose v2.40 (as of February 2026 on GitHub Actions runners). Requires Docker Engine/CLI 28.3.3+ as of v2.39.2 (August 2025).

**Key Change**: The `version` field in docker-compose.yml is fully deprecated and ignored. The unified Compose Specification merges all 2.x and 3.x format features.

**Confidence**: High -- Docker official documentation and release notes.

Sources: [Docker Compose Releases](https://github.com/docker/compose/releases), [Docker Compose Docs](https://docs.docker.com/compose/), [Docker Blog](https://www.docker.com/blog/new-docker-compose-v2-and-v1-deprecation/)

### Docker Desktop MCP and AI Integration

Docker Desktop 4.50 (November 2025) marked a major pivot toward AI-native development:

- **Gordon AI Assistant**: Built-in AI for containerizing apps, with DevSecOps beta features
- **MCP Catalog**: 270+ MCP servers in Docker Hub, 60+ remote servers with OAuth
- **Dynamic MCPs**: Agents can discover, configure, and compose tools autonomously via mcp-find, mcp-add, code-mode
- **MCP Gateway**: Secure enforcement point between AI agents and external tools
- **Docker Model Runner**: Pull and run open-weight LLMs locally
- **MCP Toolkit Walkthroughs**: Step-by-step guides for AI-powered workflows

**Relevance to rfapps-cli**: The MCP server mode already implemented in rfapps-cli aligns perfectly with Docker's strategic direction. Docker is explicitly building infrastructure for AI agents to manage containers, making rfapps-cli's MCP integration forward-looking.

**Confidence**: High -- Docker official blog posts and documentation from November 2025.

Sources: [Docker Desktop 4.50](https://www.docker.com/blog/docker-desktop-4-50/), [Docker MCP Blog](https://www.docker.com/blog/build-ai-agents-with-docker-compose/), [InfoQ](https://www.infoq.com/news/2025/11/docker-desktop-ai/)

### New Tools Emerged in 2025

Notable new entrants to the self-hosting tool ecosystem:

1. **Pangolin** -- Self-hosted tunneled reverse proxy with WireGuard, identity-aware access control. Became the breakout hit of 2025 in the self-hosting community.
2. **Arcane** -- Modern Docker management with Go backend and Svelte frontend, rapid release cadence.
3. **Docker Compose Maker** -- Tool for generating compose files for users unfamiliar with Docker.
4. **LoggiFly** -- Log pattern-based notification service with Apprise integration.
5. **PatchMon** -- Linux patch monitoring with centralized management.
6. **Tinyauth** -- Simplified authentication middleware as an alternative to Authentik/Authelia.
7. **Media Manager alternatives** (Cinephage, MediaManager, Mydia) -- attempting to consolidate the \*arr suite into single applications.

**Confidence**: High -- selfh.st editorial coverage and GitHub data.

Sources: [selfh.st Favorites 2025](https://selfh.st/post/2025-favorite-new-apps/), [noted.lol Pangolin](https://noted.lol/pangolin/)

---

## Emerging Trends

### 1. The Compose-First Movement

The self-hosting community has consolidated around Docker Compose as the standard deployment method (87.6% adoption). Tools that work WITH compose files (Dockge, Komodo) are gaining over tools that abstract them away (Portainer, CasaOS). The key insight: power users want their compose files on the filesystem, version-controllable, and portable -- not locked in a tool's database.

**Relevance to rfapps-cli**: rfapps-cli already operates on compose.yml directly, aligning with this trend perfectly.

**Confidence**: High -- survey data and community sentiment align.

### 2. AI Integration in Container Management

Docker Inc.'s MCP pivot is the most significant platform shift in container tooling since Docker Compose v2. Key patterns emerging:

- AI agents managing containers via MCP servers
- Natural language to Docker Compose generation
- Automated troubleshooting and log analysis
- AI-driven scaling and resource optimization predictions
- Agent-to-agent workflows for complex deployments

Docker's MCP Catalog (270+ servers) and Gateway create infrastructure for AI-first container management. This is moving from experimental to mainstream rapidly.

**Confidence**: Medium-High -- Docker is investing heavily, but real-world adoption of AI container management is still early.

### 3. Security-by-Default

Cosmos-Server's SmartShield, Pangolin's identity-aware access, and the rise of Authentik (as the go-to SSO solution) reflect a community-wide shift toward security-first self-hosting. The 2025 survey shows 43.3% use 2FA and 31.1% use Fail2Ban. Community discourse increasingly emphasizes that security should be built into platforms, not bolted on.

**Confidence**: High -- multiple data points align.

### 4. Multi-Server Management

The homelab has grown beyond a single machine. Komodo, Arcane, and Coolify all emphasize multi-server management. Dockge added agent support in v1.4.0. Even self-hosters are now managing 2-5 machines (home server + VPS + Raspberry Pi endpoints). This creates demand for centralized control planes.

**Confidence**: Medium-High -- feature direction of major tools confirms this, but survey data on average server count is limited.

### 5. The "Simplicity Premium"

A clear backlash against complexity is visible:

- Dockge's growth is driven by being "not Portainer" (simpler, lighter)
- Tinyauth emerged as "not Authentik" (simpler auth)
- Sync-in emerged as "not Nextcloud" (simpler file sharing)
- CasaOS and Runtipi target "5-minute setup" experiences

The community values tools that do one thing well over platforms that do everything mediocrely. This is the strongest recurring theme in 2025 discourse.

**Confidence**: High -- consistent across all sources reviewed.

### 6. Podman as Emerging Alternative

Podman adoption is at 7.3% and growing. Komodo already supports Podman alongside Docker. The container runtime abstraction issue (rfapps-cli #72) is forward-looking as Podman gains traction, especially in enterprise/security-conscious environments where rootless containers matter.

**Confidence**: Medium -- adoption is still low but trajectory is upward.

---

## Contemporary Debates

### 1. Portainer vs. Everything Else

The most active debate in self-hosting communities. The community has split into:

- **Portainer defenders**: "It does everything, multi-cluster, RBAC, templates"
- **Portainer critics**: "It's bloated, locks compose in its database, Business Edition gates features"
- **Dockge converts**: "I just want compose management that stays out of my way"
- **CLI purists**: "I don't need a GUI, just give me better terminal tools"

Multiple "I replaced Portainer with X" articles from XDA Developers, noted.lol, and personal blogs document this shift. Portainer's 40.8% adoption is stable but the growth is in alternatives.

**Confidence**: High -- extensive discourse across multiple platforms.

Sources: [XDA (Dockge)](https://www.xda-developers.com/forget-portainer-simple-tool-dockge/), [XDA (Arcane)](https://www.xda-developers.com/replaced-portainer-with-modern-docker-manager-on-my-home-server/), [lucasduete.dev](https://lucasduete.dev/posts/why-ditched-portainer-to-dockge/)

### 2. GUI vs. CLI vs. Hybrid

No clear winner. The survey shows 31.7% use NO container management helper (CLI-only). But GUI tools are growing. The hybrid approach -- CLI for daily operations, GUI for monitoring and troubleshooting -- is emerging as the pragmatic consensus.

**Relevance to rfapps-cli**: Being a CLI tool puts it in the minority but power-user segment. Adding TUI (terminal UI) capabilities could bridge the gap.

**Confidence**: Medium -- inference from survey data and community patterns.

### 3. All-in-One vs. Unix Philosophy

- **All-in-one camp** (Cosmos, CasaOS, Runtipi): "One tool for reverse proxy + auth + management + monitoring"
- **Unix philosophy camp** (Traefik + Authentik + Dockge + Grafana): "Best tool for each job, compose them yourself"

Both approaches have vocal advocates. All-in-one tools are growing faster for new users, but experienced homelabbers tend to prefer composable stacks.

**Confidence**: High -- clear from tool positioning and community discussions.

### 4. Plan/Apply Workflow: Terraform Model for Docker

The Terraform-style plan/apply pattern is virtually absent from self-hosting tools. No major competitor (Portainer, Dockge, Coolify, Komodo, Arcane, Cosmos) implements deployment preview with diff analysis. Docker Compose's own `--dry-run` flag is the closest native feature, but it only validates syntax and configuration -- it doesn't show what will change.

rfapps-cli's plan command (showing image, env, port, volume, network diffs before deployment) is genuinely unique in the self-hosting space. This is both a competitive advantage and a potential signal that the market hasn't demanded this feature -- possibly because most homelab deployments are low-risk enough that "just deploy it" is acceptable.

**Confidence**: High -- extensive search across all major tools found no equivalent feature.

---

## Community Sentiment (Key Themes from 2025 Discourse)

### What People Love

1. **Docker Compose as lingua franca** -- it works, it's portable, it's understood
2. **Dockge's philosophy** -- filesystem-based, lightweight, compose-centric
3. **Coolify for deployment** -- git push to deploy without managing infrastructure
4. **Pangolin for access** -- self-hosted alternative to Cloudflare Tunnel
5. **Jellyfin winning** -- open source media server overtaking Plex (53.5% vs 24.5%)

### What People Hate

1. **Portainer's Business Edition gates** -- features behind paywalls frustrate homelabbers
2. **Complexity creep** -- tools adding features nobody asked for
3. **Database lock-in** -- tools storing configs in databases instead of files
4. **Resource bloat** -- management tools consuming too much RAM on small hardware
5. **Plex monetization** -- pushing users to Jellyfin

### What People Want But Don't Have

1. **Unified \*arr suite** -- a single app replacing Sonarr + Radarr + Prowlarr + Bazarr
2. **Better calendar self-hosting** -- Google Calendar equivalent that actually works
3. **Simpler authentication** -- Authentik is powerful but complex; Tinyauth is emerging
4. **Deployment previews** -- knowing what will change before deploying (the rfapps-cli niche)
5. **Cross-platform container management** -- works on Docker AND Podman
6. **Automated rollback** -- reverting to previous state when deployments fail

**Confidence**: Medium-High -- aggregated from survey data, community articles, and tool feature requests.

Sources: [Self-Hosted Survey 2025](https://selfhosted-survey-2025.deployn.de/), [Missing Self-hosted Alternatives Survey](https://selfhosted-survey-2025.deployn.de/unfound/)

---

## Key Insights for rfapps-cli

### 1. The Plan/Apply Workflow is a Genuine Differentiator

No competing tool in the self-hosting space implements Terraform-style deployment preview. This is rfapps-cli's strongest unique selling point. Docker Compose's --dry-run validates config but doesn't show diffs. The feature gap is real.

### 2. Filesystem-First Philosophy Wins

Dockge's explosive growth (0 to 22k stars in ~2 years) is driven primarily by working WITH compose files on the filesystem rather than abstracting them. rfapps-cli already does this -- working directly with compose.yml. This alignment should be emphasized.

### 3. Multi-Server is the Next Frontier

Komodo, Arcane, and Dockge v1.4+ all added multi-server/agent support. Single-server tools are increasingly insufficient as homelabs grow.

### 4. MCP/AI Integration is Strategic

Docker's massive investment in MCP (270+ servers, gateway, toolkit) validates rfapps-cli's existing MCP server mode. This should be expanded.

### 5. The 31.7% CLI-Only Market

Nearly a third of self-hosters use no container management helper. These are the most likely rfapps-cli users -- power users who prefer CLI but want more capability than raw Docker commands.

### 6. Security Features Are Expected

SmartShield (Cosmos), OIDC (Komodo, Arcane), 2FA (all platforms) -- security is table stakes. rfapps-cli's security story (secrets management via dotenvx/1Password) is good but audit logging and service conflict detection (#64) would strengthen it.

### 7. Simplicity Beats Features

The strongest community signal in 2025 is demand for simplicity. Feature-rich tools lose to focused ones. rfapps-cli should resist feature creep and maintain its focused CLI identity.

---

## Evidence Quality Assessment

| Source Category                      | Quality     | Notes                                                 |
| ------------------------------------ | ----------- | ----------------------------------------------------- |
| Self-Hosted Survey 2025 (deployn.de) | High        | 850+ respondents, quantitative data                   |
| selfh.st Survey 2025                 | High        | 4,081 respondents, largest community survey           |
| GitHub Repository Metrics            | High        | Direct data, verified February 2026                   |
| Docker Official Documentation        | High        | Primary source, regularly updated                     |
| XDA Developers articles              | Medium-High | Editorial coverage, potentially biased toward novelty |
| noted.lol coverage                   | Medium-High | Focused self-hosting publication                      |
| BetterStack comparison               | Medium      | Commercial context but technically sound              |
| Reddit/community sentiment           | Medium      | Anecdotal but directionally accurate                  |
| Medium/blog articles                 | Medium-Low  | Individual perspectives, may not be representative    |

### Gaps and Uncertainties

1. **Adoption vs. Stars discrepancy**: Coolify has 50.5k stars but only 2.0% survey adoption. Stars correlate with awareness, not deployment.
2. **Enterprise adoption data**: Limited public data on Portainer Business Edition actual deployments.
3. **Podman trajectory**: Growing but 7.3% is still small. Unclear if it will reach critical mass in the homelab space.
4. **AI container management maturity**: Docker's MCP investment is clear, but real-world usage data for AI-driven container management is absent.
5. **Plan/apply demand signal**: No competing tool has built it, which could mean either untapped opportunity or insufficient demand. Community articles requesting "deployment previews" exist but are not common.

---

## Search Queries Executed

1. "best self-hosting management tools 2025 2026 comparison"
2. "Portainer vs Dockge vs CasaOS features comparison 2025"
3. "Docker Compose v2 new features 2025 2026"
4. "lazydocker alternatives Docker CLI tools 2025"
5. "Coolify self-hosting features deployment 2025"
6. "Cosmos-Server Docker management security features self-hosting 2025"
7. "Reddit selfhosted homelab management tools recommended 2025 2026"
8. "Docker container management AI integration 2025 2026"
9. "self-hosting platform features wishlist community requests 2025"
10. "Docker orchestration CLI innovations trends 2025 plan apply workflow"
11. "Komodo Docker management tool features 2025 GitHub"
12. "Docker Compose watch dry-run profiles features production 2025"
13. "Runtipi self-hosting platform features 2025"
14. "Dokploy self-hosted PaaS Docker management features 2025"
15. "Arcane Docker management platform features 2025 GitHub"
16. "docker compose plan apply preview deployment workflow tool 2025"
17. "Docker GitHub stars comparison Portainer Dockge Coolify 2025 popularity trends"
18. "selfh.st newsletter self-hosted survey 2025 results tools popularity"
19. "Docker desktop 4.50 MCP Model Context Protocol agent features 2025"
20. "selfhosted survey 2025 container management Portainer Dockge usage percentage reverse proxy"
21. "Pangolin reverse proxy tunnel VPS self-hosting 2025"
22. "docker compose MCP server AI agent container management automation 2025"
23. "Portainer GitHub stars 2026 users enterprise adoption"

**Deep-dive URLs fetched:**

- BetterStack Portainer Alternatives comparison
- 2026 Homelab Stack blog post (elest.io)
- Portainer vs Dockge detailed comparison (homelabsec.com)
- Komodo GitHub repository
- Cosmos-Server GitHub repository
- Arcane GitHub repository
- Dockge GitHub repository
- Coolify GitHub repository
- Self-Hosted Survey 2025 (deployn.de)
- selfh.st 2025 Favorite New Apps
- selfh.st 2025 Survey Results

---

## Appendix: GitHub Stars Comparison (February 2026)

| Tool          | Stars   | Category                | Trend       |
| ------------- | ------- | ----------------------- | ----------- |
| Coolify       | 50,500  | PaaS                    | Rising fast |
| Lazydocker    | ~38,000 | Terminal UI             | Stable      |
| Portainer     | 36,484  | Full management         | Stable      |
| Dockge        | 22,000  | Compose management      | Rising fast |
| Komodo        | 10,100  | Multi-server management | Rising      |
| Cosmos-Server | 5,700   | All-in-one platform     | Rising      |
| Arcane        | 4,500   | Modern Docker UI        | Rising fast |
| Runtipi       | ~3,000+ | Homeserver orchestrator | Stable      |
| Yacht         | ~3,000+ | Simple Docker UI        | Declining   |

Note: Stars measure awareness and interest, not necessarily production adoption. The Self-Hosted Survey 2025 adoption data provides a more accurate picture of actual deployment.
