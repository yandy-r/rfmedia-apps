# Negative Space Explorer: What's Missing from Docker CLI Tools

## Executive Summary

This research investigates the absences -- features everyone wants but nobody is building, adoption barriers that remain unaddressed, and knowledge gaps that prevent self-hosters from moving beyond basic Docker Compose workflows. The findings reveal that Docker orchestration CLI tools like rfapps-cli operate in a space with significant unmet needs: native backup/disaster recovery, configuration drift detection, multi-host management, vulnerability scanning integration, and production-readiness automation are conspicuously absent from virtually all Docker Compose-oriented CLI tools. The gap between what Kubernetes users take for granted and what Docker Compose users actually have access to is vast and largely unbridged. Most critically, the tooling ecosystem fails to address the operational knowledge gap -- users do not know what they do not know about running containers in production, and no CLI tool helps them discover these gaps.

---

## 1. Missing Features

### 1.1 Native Backup and Disaster Recovery

**What's Missing:** No Docker Compose CLI tool provides integrated backup orchestration. Users must cobble together custom scripts using cron, rclone, tar, and database-specific dump utilities. Docker's default volume management lacks user-friendly backup abstraction entirely.

**Why It Matters:** Database consistency during backup is not guaranteed by filesystem-level approaches. As documented by multiple self-hosting guides, standard Docker tooling does not provide straightforward, reliable backup mechanisms for stateful applications -- particularly relational databases like PostgreSQL and MariaDB that require application-level quiescing before backup.

**User Demand:** High. Every self-hosting guide addresses backup as a critical concern, yet every solution is bespoke. The community tool `docker-backup` by muesli exists but has limited adoption.

**Specific Gaps:**

- No CLI command to snapshot all volumes for a service group atomically
- No database-aware backup that pauses writes before filesystem copy
- No backup verification (checksums, test restores)
- No backup scheduling integrated with service lifecycle
- No backup manifest tracking what was backed up, when, and where

**Confidence**: High -- Multiple independent sources confirm this gap. ([insecuredisaster.com](https://insecuredisaster.com/backing-up-self-hosted-docker-environments/), [xda-developers.com](https://www.xda-developers.com/self-hosted-docker-backup/), [techtarget.com](https://www.techtarget.com/searchdisasterrecovery/tip/The-reality-of-Docker-disaster-recovery-in-practice))

### 1.2 Configuration Drift Detection

**What's Missing:** No Docker Compose CLI tool detects when running containers have drifted from their declared compose.yml configuration. Kubernetes has dedicated tools like Komodor for drift management; Docker Compose has nothing.

**Why It Matters:** Configuration drift leads to security vulnerabilities, compliance violations, operational inefficiencies, and system outages. Manual changes, ad-hoc updates, or environment variable differences between what's declared and what's running create invisible inconsistencies.

**User Demand:** Medium-High. Enterprise tools (CimTrak, Komodor) address this for Kubernetes, but the Docker Compose ecosystem has zero tooling for drift detection.

**Specific Gaps:**

- No command to compare running container state against compose.yml declaration
- No detection of manually-modified environment variables inside running containers
- No alerting when mounted volumes contain unexpected file changes
- No audit trail of who changed what and when

**Confidence**: High -- Komodor and CimTrak address this for Kubernetes, confirming the need exists. The Docker Compose ecosystem simply has no equivalent. ([ai-infra-link.com](https://www.ai-infra-link.com/mastering-config-drift-detection-top-open-source-tools-for-2025/), [komodor.com](https://komodor.com/blog/drift-away-the-hidden-risk-of-large-scale-kubernetes-environments/))

### 1.3 Rollback with Version History

**What's Missing:** Docker Compose has no native rollback mechanism. Docker Swarm has `docker service rollback`, but standalone Compose requires manual image tag switching, volume restoration, and compose.yml file replacement. No CLI tool maintains a version history of deployments that can be browsed and rolled back to.

**Why It Matters:** When an update breaks a service, recovery time is entirely dependent on the operator's preparation. Without automated rollback, mean time to recovery (MTTR) is measured in the operator's ability to remember or find what the previous working configuration was.

**User Demand:** High. This is one of rfapps-cli's differentiators (SQLite-based deployment history), but the feature is incomplete without atomic rollback capability.

**Specific Gaps:**

- No single-command rollback to a previous known-good state
- No compose.yml version history with diff visualization
- No volume snapshot integration for data rollback
- No canary deployment or gradual rollout support

**Confidence**: High -- Docker's own documentation confirms Compose lacks rollback. Multiple community articles describe manual workarounds. ([kkovacs.eu](https://kkovacs.eu/docker-compose-rollback/), [Docker Forums](https://forums.docker.com/t/how-to-roll-back-docker-compose-pull/108707))

### 1.4 Vulnerability Scanning Integration

**What's Missing:** No Docker Compose CLI tool integrates vulnerability scanning into the deployment workflow. Tools like Trivy, Grype, and Clair exist as standalone scanners, but they are not integrated into plan/apply workflows.

**Why It Matters:** A Shodan scan discovered hundreds of self-hosted admin tools running Docker images over 2 years old with known CVEs. Self-hosters routinely run vulnerable images because there is no friction point in the deployment workflow that warns them.

**User Demand:** High. Trivy alone has 25k+ GitHub stars. The demand for scanning exists; the integration into deployment workflows does not.

**Specific Gaps:**

- No pre-deployment vulnerability scan in plan/apply workflows
- No CVE severity threshold that can block deployments
- No ongoing vulnerability monitoring for running containers
- No notification when a running image gets a new CVE published against it

**Confidence**: High -- Trivy, Grype, and Clair are mature tools. The gap is integration, not capability. ([trivy.dev](https://trivy.dev/), [pomerium.com](https://www.pomerium.com/blog/docker-image-scanning-tools), [danlevy.net](https://danlevy.net/docker-security-tips-for-self-hosting/))

### 1.5 Security Hardening Automation

**What's Missing:** No CLI tool automates Docker security hardening. Users must manually configure capability dropping, read-only filesystems, non-root users, network isolation, and secrets management for each service.

**Why It Matters:** Docker bypasses UFW/iptables firewall rules by default on Ubuntu/Debian, rendering host firewalls useless for containerized services. The Docker socket mounted with `:ro` provides false security -- read-only does not affect I/O sent over the socket. Most containers run with excessive Linux capabilities.

**User Demand:** High. Security is consistently cited as the top concern for self-hosters, yet no tool automates the hardening process.

**Specific Gaps:**

- No security audit command that checks compose.yml against best practices
- No automatic capability dropping (`cap_drop: [ALL]`) with selective re-addition
- No Docker socket access audit
- No firewall rule verification for container port exposure
- No secrets-in-environment-variables detection and warning

**Confidence**: High -- OWASP Docker Security Cheat Sheet, multiple security guides confirm these gaps. ([danlevy.net](https://danlevy.net/docker-security-tips-for-self-hosting/), [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html), [spacelift.io](https://spacelift.io/blog/docker-security))

### 1.6 Multi-Host and Remote Management

**What's Missing:** Docker contexts exist for remote management, but no CLI tool provides a unified multi-host Docker Compose orchestration experience. Each host must be managed independently.

**Why It Matters:** Self-hosters increasingly run services across multiple machines (NAS, dedicated server, Raspberry Pi cluster). Managing each independently creates operational overhead and inconsistency.

**Specific Gaps:**

- No single CLI that orchestrates compose stacks across multiple Docker hosts
- No service placement decisions based on host resources
- No cross-host networking setup automation
- No centralized state view across hosts

**Confidence**: Medium -- Docker contexts and SSH-based remote management exist but are primitive. No CLI tool builds a compelling multi-host experience on top of them. ([collabnix.com](https://collabnix.com/how-to-connect-to-remote-docker-using-docker-context-cli/), [oneuptime.com](https://oneuptime.com/blog/post/2026-01-16-docker-contexts-remote-management/view))

### 1.7 Resource Monitoring and Alerting

**What's Missing:** No Docker Compose CLI tool provides built-in resource monitoring or alerting. Users must deploy separate monitoring stacks (Prometheus + Grafana, Netdata, etc.) and configure them independently.

**Why It Matters:** Without monitoring, operators cannot detect resource exhaustion, memory leaks, or performance degradation until services fail. The monitoring gap is especially acute because Docker Compose does not enforce resource limits by default.

**Specific Gaps:**

- No `rfapps monitor` command showing real-time resource usage
- No alerting when a container exceeds memory/CPU thresholds
- No disk space monitoring for volumes
- No log analysis or error rate tracking
- No performance baseline and anomaly detection

**Confidence**: High -- Prometheus, Grafana, Netdata exist as solutions but require separate deployment and configuration. No Compose CLI integrates this. ([betterstack.com](https://betterstack.com/community/comparisons/docker-monitoring-addons/), [sematext.com](https://sematext.com/blog/docker-container-monitoring/))

### 1.8 Production-Readiness Validation

**What's Missing:** No tool validates whether a compose.yml is production-ready. Common production requirements (log rotation, resource limits, health checks, restart policies, named volumes) are frequently omitted.

**Why It Matters:** Teams deploy development Docker Compose configurations directly to production without modification. Docker Compose defaults (no log rotation, no resource limits, no health checks) are explicitly unsafe for production.

**Specific Gaps:**

- No lint/validate command checking for production best practices
- No warning when `json-file` log driver has no rotation configured
- No check for missing resource limits (memory, CPU)
- No verification that health checks are defined for critical services
- No detection of bind mounts that should be named volumes

**Confidence**: High -- Docker's own documentation acknowledges Compose is not production-ready by default. Multiple guides enumerate the same production gaps. ([bunnyshell.com](https://www.bunnyshell.com/blog/is-docker-compose-production-ready/), [dflow.sh](https://dflow.sh/blog/stop-misusing-docker-compose-in-production-what-most-teams-get-wrong), [Docker Docs](https://docs.docker.com/compose/production/))

---

## 2. Adoption Barriers

### 2.1 Complexity Cliff

**Type:** Cognitive | **Impact:** High | **Severity:** Critical | **Addressable:** Yes

Users can copy-paste a Docker Compose file and have software running in minutes, but the moment they need to customize, debug, or operate beyond basic `docker compose up/down`, they hit a steep learning curve. The gap between "it works" and "I understand why it works" is enormous.

**Evidence:** Multiple articles document initial enthusiasm followed by complexity-driven retreat to managed services. ([xda-developers.com](https://www.xda-developers.com/services-stopped-self-hosting-in-2025-what-im-doing-instead/), [virtualizationhowto.com](https://www.virtualizationhowto.com/2025/12/things-i-stopped-self-hosting-and-why-cloud-or-managed-won/))

### 2.2 Security Knowledge Gap

**Type:** Knowledge | **Impact:** High | **Severity:** Critical | **Addressable:** Partially

Users do not know how to secure self-hosted deployments and "the more they learn, the more questions they have." Professional hosting providers have dedicated security teams; homelab operators have their available free time and current security knowledge.

**Evidence:** Docker bypassing UFW is described as a "painful and somewhat easily missed quirk" -- a critical security issue that most guides bury in footnotes. ([danlevy.net](https://danlevy.net/docker-security-tips-for-self-hosting/), [pentestpartners.com](https://www.pentestpartners.com/security-blog/hardening-your-home-lab/))

### 2.3 Operational Maintenance Burden

**Type:** Time/Effort | **Impact:** High | **Severity:** High | **Addressable:** Yes

Self-hosting requires ongoing maintenance: security patches, version updates, backup verification, log monitoring. Users report anxiety about critical services (password managers, file sync) where the maintenance burden exceeds the privacy benefit.

**Evidence:** Users specifically stopped self-hosting password managers because "I couldn't trust myself to always be on point with managing updates." ([xda-developers.com](https://www.xda-developers.com/services-stopped-self-hosting-in-2025-what-im-doing-instead/))

### 2.4 Documentation and Onboarding Gaps

**Type:** Information | **Impact:** Medium | **Severity:** Medium | **Addressable:** Yes

Homelab guides teach how to deploy services but not how to operate them. The gap between "install Sonarr" and "maintain a production-quality Sonarr deployment" is undocumented. Configuration changes are not version-controlled, and when systems crash, all institutional knowledge is lost.

**Evidence:** "Not version controlling configurations: handcrafting Docker Compose files without saving them can result in losing all work when systems crash or fail." ([howtogeek.com](https://www.howtogeek.com/homelab-mistakes-almost-ruined-self-hosting-dreams/))

### 2.5 Plan/Apply Workflow Unfamiliarity

**Type:** Skill | **Impact:** Medium | **Severity:** Medium | **Addressable:** Yes

The Terraform-inspired plan/apply workflow is powerful but unfamiliar to most self-hosters who come from a `docker compose up -d` mental model. The concept of previewing changes before applying them requires a shift in operational thinking.

**Evidence:** No direct source; inferred from the fact that Terraform adoption itself took years to reach mainstream despite obvious benefits, and self-hosters are a less technically sophisticated audience than DevOps engineers.

**Confidence**: Medium -- Logical inference rather than direct evidence.

---

## 3. Undiscussed Topics

### 3.1 Container Image Supply Chain Security

Nobody in the self-hosting community is systematically verifying image provenance, signatures, or build reproducibility. Container images are pulled from Docker Hub on trust alone. The recent CVE-2025-62725 (Docker Compose `ps` command leading to system compromise) demonstrates that even Docker tooling itself can be a vector.

**Confidence**: High -- [Imperva CVE report](https://www.imperva.com/blog/cve-2025-62725-from-docker-compose-ps-to-system-compromise/)

### 3.2 Secrets Rotation and Lifecycle

Docker Compose secrets (file-based, mounted at `/run/secrets/`) cannot be rotated without restarting services. No self-hosting tool provides secrets rotation automation. Environment variables remain the dominant (and insecure) secrets mechanism because they are easier.

**Confidence**: High -- Docker documentation explicitly notes this limitation. ([Docker Docs](https://docs.docker.com/compose/how-tos/use-secrets/), [Docker Forums](https://forums.docker.com/t/understanding-security-implications-of-secrets-vs-env-vars-in-docker-compose/145903))

### 3.3 Compliance and Audit Trails

Self-hosters handling personal data (photos, documents, health records) may need to comply with GDPR, HIPAA, or other frameworks. No self-hosting tool provides audit logging, access tracking, or compliance reporting. Portainer Business Edition offers activity audit logging -- but only in the paid tier.

**Confidence**: Medium -- Regulatory requirements exist but are rarely discussed in self-hosting contexts.

### 3.4 Network Disaster Recovery

Networking is described as "critical and can be a nightmare to fix in a disaster." Recreating network interdependencies in a DR scenario is one of the hardest problems, yet no CLI tool captures or restores Docker network configurations.

**Confidence**: High -- [TechTarget](https://www.techtarget.com/searchdisasterrecovery/tip/The-reality-of-Docker-disaster-recovery-in-practice)

### 3.5 Watchtower's Death and the Update Vacuum

Watchtower, the most popular automatic Docker image updater, was archived on December 17, 2025, and is incompatible with Docker 28+. This leaves a vacuum in the automatic update space. Alternatives (Diun, WUD, Tugtainer, Dockcheck) exist but are fragmented, with no clear successor achieving Watchtower's former ubiquity.

**Confidence**: High -- [GitHub Issue #2067](https://github.com/containrrr/watchtower/issues/2067), [NoCoDB Issue #12668](https://github.com/nocodb/nocodb/issues/12668)

---

## 4. Knowledge Gaps

### 4.1 Docker Networking Fundamentals

**What Users Don't Know:** Docker's default bridge network does not provide DNS resolution between containers. The `--link` flag is deprecated. Custom bridge networks are required for inter-container communication by name. Docker bypasses host firewall rules (UFW/iptables) on Ubuntu/Debian by default.

**Consequence:** Services fail to communicate, or worse, services that should be firewalled are exposed to the internet without the operator's knowledge.

### 4.2 Volume Lifecycle and Data Persistence

**What Users Don't Know:** `docker compose down -v` destroys volumes and all data. Anonymous volumes are not preserved across `docker compose up` recreations. Named volumes survive container removal but bind mounts are tied to host paths that may not exist on a new machine.

**Consequence:** Data loss during routine operations. Migration failures when moving to new hardware.

### 4.3 Image Tag Mutability

**What Users Don't Know:** The `latest` tag is mutable -- it can point to different images at different times. Pulling `latest` does not guarantee the same image. Pinning to specific version tags or SHA digests is the only way to ensure reproducible deployments.

**Consequence:** Unexpected breaking changes after `docker compose pull`. Inability to reproduce a working deployment.

### 4.4 Resource Limits Are Not Set by Default

**What Users Don't Know:** Docker containers have no memory or CPU limits by default. A single misbehaving container can consume all host resources and crash the entire system, including the SSH daemon, making remote recovery impossible.

**Consequence:** Total host unavailability requiring physical intervention.

### 4.5 Log Rotation Is Not Configured by Default

**What Users Don't Know:** The default `json-file` log driver has no size limits. Long-running containers will eventually fill the disk with logs.

**Consequence:** Disk exhaustion causing cascading failures across all services.

---

## 5. Feature Gap Comparisons

### 5.1 Docker Compose vs. Kubernetes

| Capability                             | Kubernetes                          | Docker Compose                              | Gap Severity |
| -------------------------------------- | ----------------------------------- | ------------------------------------------- | ------------ |
| Self-healing (auto-restart on failure) | Pods rescheduled across nodes       | Container restart on same host only         | High         |
| Rolling updates                        | Native, zero-downtime               | Manual, requires downtime                   | Critical     |
| Horizontal auto-scaling                | HPA based on metrics                | Manual `docker compose up --scale`          | High         |
| Service discovery                      | CoreDNS, native                     | Custom bridge network DNS only              | Medium       |
| RBAC                                   | Namespaces, roles, bindings         | None                                        | Critical     |
| Config/Secret management               | ConfigMaps, Secrets with rotation   | .env files, file-based secrets, no rotation | High         |
| Health checks                          | Liveness, readiness, startup probes | Health check only (single type)             | Medium       |
| Network policies                       | Native ingress/egress rules         | None                                        | High         |
| Observability                          | Service mesh, metrics API           | None built-in                               | Critical     |
| Multi-host                             | Native clustering                   | Single host only                            | Critical     |
| Drift detection                        | Komodor, declarative reconciliation | None                                        | High         |
| Canary/Blue-green deployments          | Native or via service mesh          | None                                        | High         |

### 5.2 Self-Hosted CLI vs. Cloud Provider Console

| Capability             | AWS/GCP/Azure Console          | Self-Hosted CLI Tools          | Gap Severity |
| ---------------------- | ------------------------------ | ------------------------------ | ------------ |
| Resource visualization | Real-time dashboards           | None (separate tools required) | High         |
| Cost tracking          | Native billing and forecasting | None                           | Medium       |
| Auto-scaling           | Policy-based, metrics-driven   | None                           | High         |
| Log aggregation        | CloudWatch, Stackdriver, etc.  | None (separate Loki/ELK stack) | High         |
| Alerting               | SNS, PagerDuty integrations    | None                           | High         |
| IAM/Access control     | Fine-grained policies          | None                           | Critical     |
| Compliance reporting   | SOC2, HIPAA, GDPR dashboards   | None                           | High         |
| Infrastructure graph   | Visual dependency mapping      | None                           | Medium       |
| One-click rollback     | Native in most services        | None                           | High         |
| Managed backups        | Automated, verified, tested    | None                           | Critical     |

### 5.3 Portainer Business vs. Open-Source CLI Tooling

| Feature                | Portainer Business            | Open-Source CLIs | Implication for rfapps-cli              |
| ---------------------- | ----------------------------- | ---------------- | --------------------------------------- |
| RBAC                   | Fine-grained, per-environment | None             | Not applicable for single-user          |
| GitOps auto-updates    | Webhook or polling-based      | None             | Opportunity for compose.yml git sync    |
| Registry management    | Browse, manage tags           | None             | Image registry browsing possible        |
| Change windows         | Configurable update windows   | None             | Scheduled deployment windows            |
| Activity audit logging | Built-in with Syslog export   | None             | Operation audit trail from SQLite state |
| Resource quotas        | Kubernetes-focused            | None             | Resource limit enforcement              |
| Cluster provisioning   | Multi-cloud K8s               | N/A              | Out of scope                            |

---

## 6. Friction Points

### 6.1 The "Works on My Machine" to "Runs in Production" Gap

Docker Compose excels at local development but does not enforce any production requirements. The same compose.yml that runs perfectly on a laptop will run on a server -- without log rotation, resource limits, health checks, or security hardening. Nothing in the toolchain warns the user.

### 6.2 The Update Notification Fragmentation

With Watchtower archived (Dec 2025) and incompatible with Docker 28+, the update notification space is fragmented across Diun (notify-only), WUD (web UI), Tugtainer (web UI), and Dockcheck (CLI). None integrate with Docker Compose CLI workflows.

### 6.3 The Backup Black Hole

Every self-hosting guide says "back up your data" but none provide tooling that works. Users must learn tar, rsync, rclone, database dump commands, cron scheduling, and verification -- all separately, all manually. The Docker ecosystem treats data as an afterthought.

### 6.4 The Security Configuration Burden

Each service requires individual security configuration: capabilities, user mapping, network isolation, secrets, volume permissions. With 47+ services, this is hundreds of security decisions with no automation, validation, or auditing.

### 6.5 The Single-Host Ceiling

Docker Compose fundamentally cannot manage services across multiple hosts. As self-hosting deployments grow, users hit a ceiling that requires either Docker Swarm (limited future), Kubernetes (massive complexity), or accepting the constraint.

---

## 7. Conspicuous Absences

### 7.1 No "Doctor" Command

No Docker CLI tool provides a diagnostic command that examines the entire deployment and reports issues: outdated images, missing health checks, absent resource limits, insecure configurations, unused volumes, orphaned networks, excessive log sizes. This is the most obviously missing feature across all tools surveyed.

### 7.2 No Dependency Graph Visualization

Despite Docker Compose supporting `depends_on`, `links`, `volumes_from`, and `network_mode` dependencies, no CLI tool visualizes the service dependency graph. Understanding how 47 services relate to each other requires reading YAML.

### 7.3 No Cost/Resource Estimation

No tool estimates the resource requirements of a compose stack before deployment. Users discover their server lacks sufficient memory only after services start crashing.

### 7.4 No Migration Assistant

No tool assists in migrating a Docker Compose deployment from one host to another. Volume data, network configurations, environment variables, and service dependencies must all be manually transferred.

### 7.5 No Operational Runbook Generation

No tool generates operational documentation from a compose.yml -- what services exist, how they depend on each other, what ports are exposed, what volumes contain data, what environment variables are required. This documentation is always manual and always incomplete.

### 7.6 No Scheduled Maintenance Windows

No Docker Compose CLI tool supports scheduling operations (updates, restarts, backups) during defined maintenance windows. Every operation is immediate or requires external scheduling via cron.

---

## 8. Key Insights

1. **The Biggest Gap Is Not Features -- It's Operational Knowledge.** Self-hosters lack the operational expertise that enterprise teams have. A CLI tool that teaches best practices through its workflow (warning about missing health checks, flagging insecure configurations, suggesting resource limits) would be more valuable than any single feature.

2. **Backup Is the Most Dangerous Gap.** Every other missing feature causes inconvenience; missing backups cause data loss. No Docker Compose CLI tool addresses this, and the community solutions are fragmented and unreliable for database-backed services.

3. **Security Hardening Should Be Automated, Not Documented.** Guides exist explaining Docker security best practices. Nobody follows them because they require manual effort per-service. A `rfapps audit` or `rfapps harden` command that automatically applies security best practices would be transformative.

4. **The Watchtower Vacuum Creates an Integration Opportunity.** With Watchtower dead and no clear successor, rfapps-cli's existing image update detection feature could be expanded into a complete update management workflow (detect, notify, plan, apply, verify, rollback).

5. **Configuration Drift Detection Is an Untapped Market.** Kubernetes has Komodor. Docker Compose has nothing. A CLI tool that compares running state against declared state would be unique and immediately valuable.

6. **Production-Readiness Validation Is Low-Hanging Fruit.** A `rfapps lint` command that checks for missing log rotation, resource limits, health checks, restart policies, and security configurations would prevent the most common production failures.

---

## 9. Evidence Quality Assessment

| Finding                                | Evidence Type                              | Source Count | Confidence  |
| -------------------------------------- | ------------------------------------------ | ------------ | ----------- |
| Backup/DR gaps                         | Primary (docs, guides, tools)              | 5+           | High        |
| Config drift absence                   | Primary (tool comparisons)                 | 3+           | High        |
| Rollback missing from Compose          | Primary (Docker docs, forums)              | 4+           | High        |
| Vulnerability scanning integration gap | Primary (tool docs) + secondary (articles) | 5+           | High        |
| Security hardening gaps                | Primary (OWASP, security audits)           | 5+           | High        |
| Multi-host management gap              | Primary (Docker docs) + secondary          | 3+           | Medium-High |
| Adoption barriers                      | Secondary (articles, blog posts)           | 5+           | High        |
| Knowledge gaps                         | Secondary (guides, mistake lists)          | 5+           | Medium-High |
| Watchtower vacuum                      | Primary (GitHub issues, archive notice)    | 3+           | High        |
| Production-readiness gaps              | Primary (Docker docs) + secondary          | 5+           | High        |

---

## 10. Search Queries Executed

1. `Docker Compose missing features limitations users want 2025 2026`
2. `self-hosting tools barriers adoption problems friction homelab 2025`
3. `Docker management backup disaster recovery missing features self-hosted`
4. `homelab Docker security hardening gaps overlooked self-hosting 2025`
5. `Docker Compose vs Kubernetes missing features gap self-hosting`
6. `self-hosting config drift detection compliance Docker containers 2025`
7. `Docker remote management multi-host tools missing CLI orchestration`
8. `Portainer feature requests community wishlist missing features 2025`
9. `Docker container monitoring alerting self-hosted solutions gaps limitations`
10. `self-hosting data migration portability tools missing Docker volume`
11. `"docker compose" "feature request" OR "wish" OR "need" reddit self-hosting 2025`
12. `Dockge CasaOS Cosmos-Server limitations compared Portainer Docker management 2025`
13. `Docker Desktop Business enterprise features not available open source self-hosting`
14. `Terraform plan apply workflow Docker infrastructure as code missing features gaps`
15. `docker compose rollback version history undo changes missing feature`
16. `homelab self-hosting common mistakes problems what people don't know Docker 2025`
17. `Docker Compose secret management limitations environment variables security`
18. `Docker Compose dependency management service ordering startup problems limitations`
19. `Kubernetes features self-hosters need but Docker Compose lacks: service mesh observability RBAC`
20. `Docker image vulnerability scanning CVE detection self-hosted CLI tools open source 2025`
21. `Docker container update notification automatic image update watchtower diun alternatives limitations 2025`
22. `self-hosting CLI tool UX developer experience improvements modern terminal TUI 2025`
23. `cloud console features missing self-hosted Docker: resource visualization cost tracking auto-scaling`
24. `Portainer Business features not in community edition: RBAC registry management GitOps`
25. `Docker Compose production deployment gaps: log rotation resource limits health monitoring automation`

**Deep-fetch targets:**

- [danlevy.net/docker-security-tips-for-self-hosting/](https://danlevy.net/docker-security-tips-for-self-hosting/)
- [insecuredisaster.com/backing-up-self-hosted-docker-environments/](https://insecuredisaster.com/backing-up-self-hosted-docker-environments/)
- [portainer.io/blog/portainer-community-edition-ce-vs-portainer-business-edition-be-whats-the-difference](https://www.portainer.io/blog/portainer-community-edition-ce-vs-portainer-business-edition-be-whats-the-difference)
- [dflow.sh/blog/stop-misusing-docker-compose-in-production-what-most-teams-get-wrong](https://dflow.sh/blog/stop-misusing-docker-compose-in-production-what-most-teams-get-wrong)
- [xda-developers.com/services-stopped-self-hosting-in-2025-what-im-doing-instead/](https://www.xda-developers.com/services-stopped-self-hosting-in-2025-what-im-doing-instead/)

---

## 11. Uncertainties and Gaps

- **Reddit-specific pain points:** Attempts to search Reddit for Docker Compose frustrations were unsuccessful due to search limitations. Direct Reddit API queries would yield more community-level sentiment data.
- **Quantitative adoption data:** No hard numbers on how many self-hosters use CLI orchestration tools vs. raw `docker compose` commands. The market size is estimated but unconfirmed.
- **rfapps-cli competitive positioning:** No direct competitors with identical feature sets were found, making competitive analysis based on adjacent tools (Portainer, Dockge, etc.) rather than direct comparisons.
- **User survey data:** No primary research (surveys, interviews) was conducted. All findings are from secondary sources and inferred from community discussions, tool documentation, and feature comparisons.
- **Cost-benefit of proposed features:** While many missing features are identified, the development effort vs. user impact for each is not quantified. A prioritization framework based on implementation complexity and user demand would strengthen these findings.
