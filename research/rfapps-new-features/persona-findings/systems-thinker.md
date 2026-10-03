# Systems Thinker: rfapps-cli System Dynamics Analysis

## Executive Summary

rfapps-cli operates within a multi-layered system where Docker's evolution, the self-hosting community's needs, and the tool's own feature trajectory create interacting feedback loops. The most critical systemic insight is the **upstream convergence risk**: Docker Compose is steadily absorbing capabilities (dry-run, watch, profiles, a Go SDK for programmatic access) that reduce the value gap wrapper tools fill. Meanwhile, each feature added to rfapps-cli creates maintenance obligations that compound over time. The highest-leverage interventions are not adding more features but rather strengthening information flows (better observability of what changed and why), reducing delays (faster feedback on deployment health), and preserving the tool's escape hatches so it never becomes the only way to manage the platform. The system rewards simplicity and punishes complexity on a delay -- feature creep feels productive today but creates maintenance debt that surfaces months later.

**Confidence**: High -- supported by multiple converging sources on Docker ecosystem evolution, systems thinking frameworks, and self-hosting community survey data.

---

## System Map

```
                    +----------------------------------+
                    |     Docker Inc. Roadmap           |
                    | (Compose v5, Go SDK, dry-run,    |
                    |  watch, profiles, MCP Catalog)   |
                    +--------+-------------------------+
                             |
                    Upstream feature additions
                             |
                             v
+----------------+   +------+------+   +------------------+
| Self-Hosting   |   | Docker      |   | Container        |
| Community      |<--| Compose     |-->| Runtime Layer    |
| (Reddit,       |   | CLI + API   |   | (Docker, Podman, |
| r/selfhosted)  |   +------+------+   | nerdctl)         |
+-------+--------+          |          +--------+---------+
        |                   |                   |
   User demands      CLI subprocess        Runtime differences
   & pain points      invocations          & compatibility gaps
        |                   |                   |
        v                   v                   v
+-------+-------------------+-------------------+---------+
|                                                         |
|                    rfapps-cli                            |
|  +--------------------------------------------------+  |
|  | Plan/Apply | State (SQLite) | Sidecar Linking    |  |
|  | Parallel   | Health Checks  | Interactive Select |  |
|  | MCP Server | Error Handling | Config Layers      |  |
|  +--------------------------------------------------+  |
|                                                         |
+-----------+------------------+--------------------------+
            |                  |
    State persistence    Docker Compose
    & history              commands
            |                  |
            v                  v
+--------+------+     +-------+--------+
| SQLite DB     |     | 47 Containerized|
| (~/.config/   |     | Services        |
|  rfapps/)     |     | (compose.yml)   |
+---------------+     +-------+--------+
                              |
                     Service health &
                     runtime behavior
                              |
                              v
                    +---------+---------+
                    | User Experience   |
                    | (uptime, updates, |
                    |  rollback safety) |
                    +-------------------+
```

---

## Feedback Loops

### Loop 1: Feature Absorption (Balancing Loop -- CRITICAL)

```
Docker Compose adds native feature (e.g., dry-run, profiles)
    --> Reduces value gap rfapps-cli fills
    --> Pressure to add new differentiating features
    --> Increases maintenance surface area
    --> Less time for tracking upstream changes
    --> Higher risk of breaking when Compose evolves
    --> [Loop back: Compose adds another native feature]
```

**Analysis**: Docker Compose v5 introduced a Go SDK that provides programmatic API access to load, validate, and manage multi-container environments without relying on the CLI. This is a direct threat to any tool that shells out to `docker compose` -- it means Docker is commoditizing the exact integration layer rfapps-cli depends on. The dry-run flag (`docker compose alpha dry-run`) partially overlaps with rfapps-cli's `plan` command, though the plan/apply workflow with state persistence goes significantly beyond what native dry-run offers.

**Confidence**: High -- Docker's official documentation confirms the Go SDK and native dry-run features. The convergence pattern is documented across IaC tooling broadly.

**Meadows Framework**: This is a Level 10 leverage point (structure of material stocks and flows). The physical architecture of how rfapps-cli integrates with Docker Compose determines vulnerability to upstream changes.

### Loop 2: Complexity Ratchet (Reinforcing Loop -- DANGEROUS)

```
New feature added (e.g., Podman support)
    --> New configuration options needed
    --> New test matrix required (Docker x Podman x versions)
    --> More edge cases in error handling
    --> More documentation to maintain
    --> More places for bugs to hide
    --> User reports bug in edge case
    --> Pressure to fix AND add next feature
    --> [Loop accelerates: more features, more surface area]
```

**Analysis**: Feature creep is consistently identified as "the most common source of cost and schedule overruns" in software development. For a solo-maintained CLI tool, this loop is especially dangerous because there is no team to distribute the burden. Each feature added creates a permanent maintenance obligation. The MoSCoW method and 80/20 rule provide proven frameworks for resisting this loop.

**Confidence**: High -- supported by multiple sources on feature creep management and the Wikipedia article on the phenomenon.

### Loop 3: State Dependency Deepening (Reinforcing Loop -- MODERATE RISK)

```
SQLite state enables new capability (history, rollback)
    --> Users start depending on state data
    --> Pressure to add more state-dependent features (drift, audit)
    --> State schema grows more complex
    --> Migration complexity increases
    --> State corruption risk grows
    --> Recovery from bad state becomes harder
    --> Users are MORE dependent on state working correctly
    --> [Loop deepens: state becomes critical path]
```

**Analysis**: SQLite is well-suited for single-node, single-writer workloads like rfapps-cli's state tracking. However, SQLite's concurrency limitations mean that as features like state locking (issue #65) are added, the system must carefully handle stale locks. Terraform's experience with state locking reveals that the core problem is "visibility gaps and uncontrolled concurrency" -- stale locks from crashed processes cause deployment pipeline blockage and team coordination breakdown. For a single-user CLI tool, the concurrency risk is lower, but stale lock recovery mechanisms are still essential.

**Confidence**: Medium -- the analogy to Terraform state locking is strong, but rfapps-cli's single-user context reduces the severity.

### Loop 4: Community Adoption Flywheel (Reinforcing Loop -- ASPIRATIONAL)

```
Tool solves real pain point
    --> User shares on r/selfhosted or GitHub
    --> New users discover tool
    --> Some users contribute (issues, PRs, docs)
    --> Tool improves
    --> More pain points solved
    --> [Flywheel accelerates]
```

**Analysis**: The 2024 Self-Host User Survey received 3,700 responses with 97% of respondents using containers. This is the target audience. Open source adoption creates a self-reinforcing cycle where "as the user base expands through broad distribution and easy adoption, the community of contributors grows correspondingly." However, this flywheel only activates if the tool crosses a minimum threshold of visibility and solves a pain point dramatically better than alternatives.

**Confidence**: Medium -- the flywheel dynamic is well-documented in open source, but whether rfapps-cli can activate it depends on execution and positioning rather than systemic properties.

### Loop 5: Monitoring Overhead Spiral (Reinforcing Loop -- SECOND-ORDER)

```
Add monitoring/observability features
    --> More logs to parse, metrics to track, dashboards to maintain
    --> Observability infrastructure needs its own maintenance
    --> Alert fatigue from non-actionable alerts
    --> Engineers spend time tuning alerts instead of improving core
    --> Monitoring becomes "so complex it's fragile"
    --> [Spiral: monitoring monitoring becomes necessary]
```

**Analysis**: Research on observability second-order effects consistently finds that "each new feature introduces more logs to parse, more metrics to track, and more dashboards to maintain." Self-hosted environments are especially vulnerable because the operator is typically a single person who cannot afford alert fatigue. The solution is adaptive observability: "consolidating related alerts, tuning thresholds based on real incidents, and suppressing expected noise during maintenance."

**Confidence**: High -- multiple authoritative sources confirm the monitoring overhead spiral.

---

## Second-Order Effects of Feature Additions

### Adding Monitoring/Health Dashboard

**First-order**: Users see service health at a glance.

**Second-order**:

- Creates expectation that rfapps-cli IS the monitoring solution, not just an orchestration tool
- Users stop checking Docker directly, losing familiarity with native tools
- Health check definitions need constant tuning per service (Plex health check differs from Traefik's)
- Every new service added to compose.yml requires health check configuration
- Dashboard becomes stale if not actively maintained, giving false confidence

**Third-order**:

- When monitoring misses a problem (false negative), trust in the entire tool erodes
- Tool scope creep toward full observability platform (competing with Uptime Kuma, which is already in the stack)

**Confidence**: Medium -- based on pattern recognition from monitoring tool evolution, not direct evidence from similar CLI tools.

### Adding Podman Support (Issue #72)

**First-order**: Broader user base, fewer Docker dependency concerns.

**Second-order**:

- Testing matrix doubles (Docker + Podman, across versions)
- Networking differences (Docker's host.docker.internal vs Podman's host.containers.internal) create subtle bugs
- Podman-compose has known issues with complex networking and volumes that differ from Docker Compose
- Documentation must cover both paths, increasing maintenance burden
- Users on Podman report issues that are Podman bugs, not rfapps-cli bugs, creating support noise

**Third-order**:

- Conditional code paths proliferate through the codebase
- Feature parity lag: new Docker Compose features may not have Podman equivalents immediately
- Some features (like the Compose Go SDK) are Docker-only, creating asymmetry

**Confidence**: High -- Podman compatibility challenges are extensively documented. "Most teams need 1-2 days of testing for migration" understates the ongoing maintenance burden for tool developers.

### Adding GitOps Integration

**First-order**: Declarative, git-tracked infrastructure state.

**Second-order**:

- Requires a git repository to be set up and maintained (new infrastructure dependency)
- GitOps tools like ArgoCD and Flux are Kubernetes-native; adapting the pattern to Docker Compose requires custom reconciliation logic
- Conflict between GitOps "git is the source of truth" and rfapps-cli's "SQLite state is the source of truth"
- Users must choose between interactive CLI usage and fully automated GitOps -- the two modes fight each other

**Third-order**:

- GitOps implies a reconciliation loop that runs continuously, transforming rfapps-cli from an on-demand tool to a daemon
- Daemon mode introduces new failure modes (crash recovery, startup ordering, resource consumption)
- Creates dependency on git hosting availability for infrastructure changes

**Confidence**: Medium -- GitOps patterns are well-understood for Kubernetes but have limited precedent for Docker Compose single-host setups.

### State Locking (Issue #65)

**First-order**: Prevents concurrent operations from corrupting state.

**Second-order**:

- Stale locks from crashed processes block ALL operations until manually cleared
- Lock timeout must be tuned: too short = false conflicts, too long = stuck deployments
- Users must learn `force-unlock` or equivalent recovery commands
- Lock metadata (who, when, why) must be stored and displayed for troubleshooting

**Third-order**:

- Terraform's experience shows that lock problems "stem from visibility gaps and uncontrolled concurrency, not lock mechanisms themselves"
- For a primarily single-user tool, locking adds ceremony without proportional benefit
- DynamoDB TTL pattern (auto-expiring locks) is the best practice but requires careful implementation in SQLite

**Confidence**: High -- Terraform's extensive experience with state lock issues is directly applicable.

---

## Stakeholder Analysis

### Persona 1: Solo Self-Hoster (Primary User)

**Real pain points** (validated by 2024/2025 surveys):

- Update uncertainty: "Will this update break my running services?" -- Plan/apply workflow directly addresses this
- Configuration complexity: "Debugging YAML errors, dependencies, and network configurations"
- Recovery from failures: "How do I get back to what was working?" -- Rollback capability directly addresses this
- Time scarcity: Managing 47 services is a part-time hobby, not a job

**Perceived needs vs. actual needs**:

- Perceived: "I need a web dashboard" -- Actual: They need confidence that deploys are safe
- Perceived: "I need Podman support" -- Actual: They need Docker to keep working reliably
- Perceived: "I need GitOps" -- Actual: They need to not forget what they changed and why

**What actually helps this persona**:

- Fast, safe updates with easy rollback (already implemented)
- Clear diff of what will change before it happens (plan command -- already implemented)
- Notification when images have updates available (check-updates -- already implemented)
- History of what was deployed and when (history command -- already implemented)

**Confidence**: High -- directly supported by survey data and community pain point analysis.

### Persona 2: Power User / Homelab Enthusiast

**Characteristics**:

- Runs 20-50+ services, active on r/selfhosted
- Values control and customization over simplicity
- Will read documentation and write scripts
- Often runs custom configurations and edge cases

**Differentiation needs**:

- Essential: Reliable state management, parallel operations, programmatic access (MCP/JSON output)
- Nice to have: Smart service groups, hierarchical tagging, advanced filtering
- Low value: Tutorials, simplified UX, hand-holding

**What drives adoption**: Tool must be strictly better than their existing bash scripts AND work alongside (not replace) Docker Compose CLI for edge cases.

**Confidence**: Medium -- inferred from community behavior patterns, not direct survey data on power user preferences.

### Persona 3: Homelab Community

**What drives adoption**:

- Solves a "real" problem visibly better than alternatives
- Easy to try (low barrier to entry)
- Active maintainer who responds to issues
- Clear documentation with real-world examples

**What drives contribution**:

- Scratching own itch (fixing bugs they encounter)
- Clean, well-documented codebase
- Responsive maintainer who reviews PRs quickly
- Visible impact of contributions

**Community dynamics**: The 2024 survey showed the community nearly doubled participation year-over-year (3,700 responses). The trend toward Dockge (lightweight, compose-native) over Portainer (heavy, enterprise) suggests the community values simplicity and transparency. Dockge's philosophy that "your files are the source of truth" resonates strongly.

**Confidence**: Medium -- community preference patterns are observable but community adoption drivers are multi-factorial.

### Persona 4: AI Agents (MCP Integration)

**What AI agents actually need**:

- Structured output (JSON/YAML) for reliable parsing -- already implemented
- Service listing and status querying -- already implemented
- Safe operations with confirmation/dry-run gates
- Error messages with sufficient context for self-correction
- Deterministic behavior (same input = same output)

**What AI agents do NOT need**:

- Interactive UX (Ink-based selection)
- Color-coded terminal output
- Progress bars and spinners
- Human-readable error formatting

**Docker's MCP vision**: Docker launched the MCP Catalog with 100+ MCP servers, packaging each as an isolated container. AI agents can "detect a new commit, use a Docker MCP server to build an image, then deploy." This positions Docker itself as the MCP integration point, potentially reducing the need for per-tool MCP servers.

**Confidence**: Medium -- MCP is rapidly evolving; Docker's MCP Catalog was announced in 2025 and the integration patterns are still stabilizing.

---

## Leverage Points (Applying Meadows' Framework)

### Highest Leverage: Information Flows (Level 6)

**What this means for rfapps-cli**: The most impactful improvements are about showing the right information at the right time, not adding more operational capabilities.

**Specific interventions**:

1. **Deployment context in `plan` output**: Show not just what will change, but WHY (e.g., "image updated 3 days ago", "config drift detected")
2. **Post-deploy health summary**: After a deploy, immediately show "3 healthy, 1 starting, 0 failed" instead of requiring a separate `status` call
3. **Proactive drift detection**: Notify when running state diverges from compose.yml without being asked
4. **History context in rollback**: Show what changed between the current state and the rollback target

**Why this is high leverage**: Missing feedback is "one of the most common causes of system malfunction" (Meadows). Information flow improvements are inexpensive to implement and create compound value.

**Confidence**: High -- systems thinking framework is well-established and applies directly to CLI UX design.

### High Leverage: Reducing Delays (Level 9)

**What this means for rfapps-cli**: Shorten the time between action and feedback.

**Specific interventions**:

1. **Faster health checks**: Reduce time from `deploy` to "confirmed healthy" through better TCP probe strategies
2. **Streaming output during parallel operations**: Show progress per-service rather than waiting for all to complete
3. **Instant validation**: Catch config errors before any Docker operations begin (validate command -- exists but could be more proactive)
4. **Quick status**: Cache service status briefly to avoid repeated Docker queries in multi-command workflows

**Why this is high leverage**: Long delays between action and feedback cause users to make incorrect mental models of system state.

**Confidence**: Medium -- the principle is sound but specific implementation impact depends on current delay magnitudes.

### Moderate Leverage: System Rules (Level 5)

**What this means for rfapps-cli**: The rules about how services are managed, grouped, and targeted.

**Specific interventions**:

1. **Smart service groups (issue #62)**: Dynamic grouping by criteria (image base, update frequency, resource usage) -- this creates compound value because groups can be used in monitoring, updates, and deployment
2. **Conflict detection (issue #64)**: Prevent deploying services that would conflict on ports or volumes -- this prevents errors rather than handling them
3. **Exit code standardization (issue #68)**: Consistent exit codes enable scripting and CI/CD integration -- this is a "rule" that unlocks entire use case categories

**Why this is moderate leverage**: Rules shape behavior but require adoption and learning.

**Confidence**: High -- these are concrete, well-scoped features with clear value propositions.

### Lower Leverage: Parameters and Numbers (Level 12)

**What to avoid over-investing in**:

- Tuning health check timeouts and retries (diminishing returns)
- Configuring output format options beyond what exists
- Adding more configuration layers or override mechanisms
- Fine-grained concurrency controls

**Why this is low leverage**: These are "diddling adjustments" that rarely change system behavior fundamentally.

**Confidence**: High -- consistent with Meadows' framework and practical observation.

---

## Unintended Consequences

### 1. The Tool Becomes the Only Way to Manage Services

**Risk**: As users rely on rfapps-cli for state tracking, rollback, and deployment history, they lose the ability to use Docker Compose directly without creating state inconsistencies.

**Cascade**:

- User manages service directly with `docker compose up -d` in an emergency
- rfapps-cli state database now has stale data
- Next `plan` shows phantom drift
- User either ignores drift warnings (eroding trust in the tool) or must reconcile manually
- Drift detection (already implemented) partially addresses this but cannot capture all out-of-band changes

**Mitigation**: Always allow escape to native Docker Compose. The `drift` command should be framed as "reconcile" not "you did something wrong." Import external changes into state rather than flagging them as errors.

**Confidence**: High -- this is a well-documented pattern in IaC tools. Terraform users frequently encounter state drift from manual changes.

### 2. SQLite State Becomes a Single Point of Failure

**Risk**: The state database at `~/.config/rfapps/state.db` becomes critical infrastructure. If it's corrupted, lost, or out of sync, core features (rollback, history, plan validation) stop working.

**Cascade**:

- Database corruption from unclean shutdown during write
- User loses deployment history
- Rollback becomes impossible
- Plan validation fails (no baseline to compare against)
- User must rebuild state from scratch or abandon state-dependent features

**Mitigation**:

- Implement automatic state backup before writes (WAL mode helps but does not eliminate risk)
- Design all features to degrade gracefully when state is unavailable (not error out)
- Provide `state import` and `state rebuild` commands to reconstruct from Docker's actual state
- Never make state the ONLY source of truth -- always allow re-derivation from Docker runtime

**Confidence**: High -- SQLite single-writer constraints and corruption scenarios are well-documented.

### 3. Docker Compose Absorbs rfapps-cli's Differentiators

**Risk**: Docker Compose v5 already has dry-run, profiles, watch, and a Go SDK. As Compose adds more features (potentially health-check-aware deployment, state tracking, rollback), rfapps-cli's unique value erodes.

**Specific overlaps emerging**:

- `docker compose alpha dry-run` overlaps with `rfapps plan`
- Docker Compose profiles overlap with rfapps-cli profiles management
- Docker Compose watch overlaps with potential live-reload features
- The Go SDK enables any tool to embed Compose functionality natively

**Strategic response options**:

1. **Embrace and extend**: Use the Go SDK (if ever porting to Go) or continue subprocess integration but focus on VALUE-ADD features that Compose cannot provide (state history, rollback, sidecar linking, multi-compose orchestration)
2. **Move up the stack**: Become a platform-level tool that orchestrates multiple compose files, manages secrets, handles backup scheduling -- things that are inherently multi-concern
3. **Accept niche**: Focus on the specific use case (self-hosting platform with sidecars and complex deployment groups) rather than trying to be general-purpose

**Confidence**: High -- Docker's roadmap is publicly documented and the Compose Go SDK is already available.

### 4. Podman Support Creates Maintenance Parity Pressure

**Risk**: Once Podman is supported (issue #72), users expect every feature to work identically on both runtimes. This is not always possible due to architectural differences.

**Specific incompatibilities**:

- Docker uses a persistent daemon; Podman is daemonless (child processes of CLI)
- Docker's internal DNS (`host.docker.internal`) vs Podman's (`host.containers.internal`)
- Podman-compose has known limitations with complex networking and volumes
- Docker socket path expectations differ (`/var/run/docker.sock` vs `podman.socket`)
- The Compose Go SDK is Docker-specific

**Cascade**: Supporting two runtimes means every feature must be tested on both, every bug report must be triaged for runtime, and documentation must cover divergent paths. This effectively doubles the maintenance burden for limited user gain (the 2024 survey shows Docker dominance in self-hosting).

**Confidence**: High -- Podman compatibility challenges are extensively documented across multiple sources.

### 5. MCP Server Mode Creates API Stability Expectations

**Risk**: Once AI agents rely on rfapps-cli's MCP interface, any change to tool schemas, output formats, or command behavior becomes a breaking API change.

**Cascade**:

- AI agents are configured with tool schemas
- Schema change breaks agent workflows silently (agents get unexpected output)
- Unlike human users, agents cannot adapt to "slightly different" output
- Versioning MCP schemas adds maintenance overhead
- Docker's own MCP Catalog may become the preferred integration point, making per-tool MCP servers redundant

**Confidence**: Medium -- MCP is too new to have established patterns for backward compatibility, but the general principle of API stability is well-understood.

---

## Key Insights

### Insight 1: The Highest Value Is Not In Features, It's In Feedback

The systems analysis consistently points to information flow (Meadows Level 6) as the highest-leverage intervention point. rfapps-cli already has strong operational capabilities. The gap is in showing users the right information at the right time: what changed, why, what's healthy, what needs attention. This is cheaper to build and harder for upstream tools to replicate because it requires domain knowledge about self-hosting workflows.

### Insight 2: Simplicity Is a Feature That Compounds

The homelab community's migration from Portainer to Dockge signals a strong preference for tools where "your files are the source of truth" and complexity is minimized. Every feature added to rfapps-cli should be evaluated not just for its value but for the maintenance burden it creates and the conceptual complexity it adds. The Dockge philosophy -- lightweight, transparent, compose-native -- is winning.

### Insight 3: Escape Hatches Are Essential Infrastructure

The most dangerous unintended consequence is rfapps-cli becoming the ONLY way to manage the platform. Every feature should preserve the ability to fall back to raw `docker compose` commands. State should be re-derivable, not precious. Drift detection should reconcile, not punish. The tool should make Docker Compose easier, not replace it.

### Insight 4: The Docker Compose Go SDK Changes the Game

The introduction of `github.com/docker/compose/v5/pkg/api` as a stable Go SDK means the subprocess-based integration model has a shelf life. While rfapps-cli is TypeScript (not Go), this signals Docker's intent to make Compose embeddable. The EventProcessor interface for monitoring operations in real-time is exactly the kind of capability that wrapper tools currently build via output parsing. Long-term, the strategic question is whether to accept subprocess integration with its parsing fragility or explore alternative integration paths.

### Insight 5: State Locking Needs TTL, Not Just Locks

Terraform's hard-won lessons show that lock mechanisms are the easy part; lock recovery is the hard part. For rfapps-cli's state locking (issue #65), the implementation should include: automatic TTL-based lock expiration, lock metadata (who, when, PID), graceful recovery from stale locks, and the ability to force-unlock with appropriate warnings. Implementing locking without these recovery mechanisms creates more problems than it solves.

### Insight 6: Feature Prioritization Should Favor Compound Value

Features that unlock multiple use cases create more value per maintenance dollar than features that serve a single purpose. Examples:

- **Exit code standardization** (#68): Unlocks scripting, CI/CD, MCP reliability, testing -- high compound value
- **Smart service groups** (#62): Unlocks targeted monitoring, batch updates, selective deploys -- high compound value
- **Interactive tutorial** (#75): Helps onboarding but serves a single moment -- low compound value
- **Podman support** (#72): Serves a different runtime but doubles testing -- negative compound value

---

## Evidence Quality Assessment

| Finding                            | Confidence | Source Quality                       | Freshness |
| ---------------------------------- | ---------- | ------------------------------------ | --------- |
| Docker Compose Go SDK threat       | High       | Primary (Docker docs)                | 2025      |
| Feature creep dynamics             | High       | Multiple academic & industry         | Evergreen |
| Terraform state locking lessons    | High       | Primary (Terraform docs + community) | 2024-2025 |
| Self-hosting community preferences | Medium     | Survey data (3,700+ responses)       | 2024      |
| Podman compatibility burden        | High       | Multiple technical comparisons       | 2025      |
| MCP integration landscape          | Medium     | Rapidly evolving, early stage        | 2025      |
| Monitoring overhead spiral         | High       | Multiple observability sources       | 2024-2025 |
| Meadows leverage point framework   | High       | Academic, peer-reviewed              | Evergreen |
| Community adoption flywheel        | Medium     | Industry patterns, not direct        | 2024-2025 |
| GitOps for Docker Compose          | Low        | Limited precedent                    | 2024      |

### Gaps and Uncertainties

1. **No direct data on Docker Compose wrapper tool adoption rates** -- cannot quantify how many people use tools like rfapps-cli vs. raw Compose
2. **MCP ecosystem is too new for established patterns** -- current MCP analysis may be obsolete within 12 months
3. **No comparative data on rfapps-cli vs. competitors** (Portainer CLI, Dockge, CasaOS) for the specific use case of Compose orchestration with state
4. **Docker's roadmap beyond Go SDK is speculative** -- we do not know if Compose will add native rollback or state tracking
5. **Self-hosting survey data covers tool usage but not satisfaction or abandonment reasons**

---

## Search Queries Executed

1. "Docker Compose wrapper tool maintenance burden ecosystem 2024 2025"
2. "self-hosting tool complexity vs simplicity tradeoff homelab"
3. "Docker orchestration feedback loops dependencies breaking changes wrapper tools"
4. "homelab self-hosting user personas pain points 2024 2025"
5. "CLI tool feature creep management strategies software development"
6. "Docker Compose breaking changes impact downstream tools v2 migration plugin"
7. "infrastructure tool lock-in risks self-hosting SQLite state custom configuration"
8. "leverage points software tool development prioritization Donella Meadows systems thinking"
9. "self-hosting community what features actually used vs wanted survey Reddit 2024"
10. "Docker management AI agent MCP integration model context protocol use cases 2025"
11. "Portainer Dockge CasaOS feature comparison Docker management what users actually need 2025"
12. "Terraform state locking stale locks problems solutions DynamoDB"
13. "GitOps self-hosting homelab infrastructure requirements overhead ArgoCD Flux"
14. "Podman Docker compatibility testing burden wrapper tools differences 2025"
15. "second order effects adding monitoring observability self-hosted maintenance burden alert fatigue"
16. "Docker Compose v5 Go SDK programmatic API integration 2025 compose-go library"
17. "software tool becoming single point of failure infrastructure management bus factor risk"
18. "Docker Compose new features 2024 2025 watch include merge profiles dry-run native"
19. "open source project wrapper tool upstream feature parity obsolescence risk maintenance strategy"
20. "reinforcing feedback loop open source tool adoption community contributions ecosystem growth"
21. "infrastructure as code abstraction layer when upstream catches up overlap redundancy"

## Sources

- [Docker Compose: What's New, What's Changing, What's Next](https://www.docker.com/blog/new-docker-compose-v2-and-v1-deprecation/)
- [Docker Compose SDK Documentation](https://docs.docker.com/compose/compose-sdk/)
- [Docker MCP Catalog and Toolkit Announcement](https://www.docker.com/blog/announcing-docker-mcp-catalog-and-toolkit-beta/)
- [2024 Self-Host User Survey Results](https://selfh.st/survey/2024-results/)
- [2025 Self-Host User Survey Results](https://selfh.st/survey/2025-results/)
- [Donella Meadows: Leverage Points](https://donellameadows.org/archives/leverage-points-places-to-intervene-in-a-system/)
- [Terraform State Lock Errors: Emergency Solutions](https://scalr.com/learning-center/terraform-state-lock-errors-emergency-solutions-prevention-guide/)
- [Feature Creep in Software Development](https://qat.com/feature-creep-in-software-development/)
- [Avoiding Feature Creep: Tips to Keep Your Product Focused](https://productschool.com/blog/product-strategy/avoiding-feature-creep-tips-to-keep-your-product-focused)
- [Feature Creep - Wikipedia](https://en.wikipedia.org/wiki/Feature_creep)
- [Portainer vs CasaOS vs Dockge](https://community.bigbeartechworld.com/t/portainer-vs-casaos-vs-dockge/636)
- [Forget Portainer, Use Dockge](https://www.xda-developers.com/forget-portainer-simple-tool-dockge/)
- [Portainer Made Docker Approachable, Dockge Made Me Uninstall Portainer](https://www.xda-developers.com/uninstalled-portainer-for-dockge-to-manage-docker/)
- [Podman vs Docker: Complete 2026 Comparison Guide](https://www.xurrent.com/blog/podman-vs-docker-complete-2025-comparison-guide-for-devops-teams)
- [Containers in 2025: Docker vs. Podman](https://www.linuxjournal.com/content/containers-2025-docker-vs-podman-modern-developers)
- [Docker vs Podman 2025: The Honest Truth](https://sanj.dev/post/container-runtime-showdown-2025)
- [From Alert Fatigue to Agent-Assisted Intelligent Observability](https://www.infoq.com/articles/agent-assisted-intelligent-observability/)
- [Cutting Through the Noise: Adaptive Observability](https://www.itrsgroup.com/blog/cutting-through-noise-why-adaptive-observability-antidote-alert-fatigue-0)
- [Flux vs Argo CD: Which GitOps Tool](https://northflank.com/blog/flux-vs-argo-cd)
- [Self-Hosting like it's 2025 - Hacker News Discussion](https://news.ycombinator.com/item?id=43544979)
- [My Self-Hosting Journey in 2024](https://akashrajpurohit.com/blog/my-self-hosting-journey-in-2024/)
- [Docker 2025 State of Application Development Report](https://www.docker.com/blog/2025-docker-state-of-app-dev/)
- [Single Point of Failure - Wikipedia](https://en.wikipedia.org/wiki/Single_point_of_failure)
- [Bus Factor - Wikipedia](https://en.wikipedia.org/wiki/Bus_factor)
- [IaC Pitfalls and How to Avoid Them](https://www.env0.com/blog/infrastructure-as-code-pitfalls-and-how-to-avoid-them)
- [Rethinking Infrastructure as Code from Scratch](https://nathanpeck.com/rethinking-infrastructure-as-code-from-scratch/)
- [Docker Compose Profiles](https://event-driven.io/en/docker_compose_profiles/)
- [Docker Compose v5 Release Notes](https://docs.docker.com/compose/releases/release-notes/)
- [Mitigating Open-Source Software Risks](https://www.castsoftware.com/pulse/mitigating-open-source-software-risks-common-vulnerabilities-exposures-and-component-obsolescence)
- [How Open Source Metrics Influence Tool Adoption](https://business.daily.dev/resources/how-open-source-metrics-influence-tool-adoption)
- [CVE-2025-62725: From docker compose ps to System Compromise](https://www.imperva.com/blog/cve-2025-62725-from-docker-compose-ps-to-system-compromise/)
