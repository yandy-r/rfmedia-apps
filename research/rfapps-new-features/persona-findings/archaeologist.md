# The Archaeologist: Past Solutions for Server & Service Management

## Executive Summary

This research excavates server management, service orchestration, and self-hosting approaches from roughly 2005-2020, identifying patterns and features that predate current Docker tooling. The investigation spans pre-container configuration management (CFEngine, Puppet, Chef), early Docker-era tools (Fig, Shipyard, Kitematic, Tutum, Rancher 1.x), early self-hosting platforms (Sandstorm, Sovereign, Cloudron, Dokku, Flynn, Deis), and process supervision systems (Monit, supervisord, systemd, Upstart).

The core finding is that several patterns from this era -- particularly Puppet's idempotent desired-state model, Monit's lightweight process supervision with automatic remediation, Rancher 1.x's catalog template system with rollback, NixOS's generation-based rollback, and Sandstorm's capability-based security sandboxing -- contain ideas that are either absent from or underdeveloped in modern Docker Compose CLI tools. These patterns could meaningfully enhance rfapps-cli's plan/apply workflow, health monitoring, rollback capabilities, and security posture.

**Key actionable findings for rfapps-cli:**

1. **Configuration drift detection** (from Puppet/CFEngine) -- periodically compare running container state against declared compose.yml and alert on divergence
2. **Lightweight health monitoring with auto-remediation** (from Monit) -- simple daemon-style checks that restart unhealthy containers without requiring a full Prometheus/Grafana stack
3. **Catalog templates with versioned rollback** (from Rancher 1.x) -- service templates with explicit upgrade/rollback workflows and configuration question prompts
4. **Generation-based state snapshots** (from NixOS) -- atomic state snapshots that allow instant rollback to any previous known-good configuration
5. **Capability-based security auditing** (from Sandstorm) -- per-service visibility into network access, volume mounts, and privilege escalation

---

## Pre-Docker Server Management (2005-2013)

### CFEngine: The First Configuration Management Tool (1993-)

CFEngine, created by Mark Burgess in 1993 at Oslo University, was the first configuration management tool. It introduced two foundational concepts that remain relevant today:

- **Desired-state convergence**: Rather than scripting steps to reach a configuration, you declare what the end state should be. The tool figures out how to get there. This is the intellectual ancestor of Terraform's plan/apply model.
- **Promise theory** (formalized 2004, integrated into CFEngine 3 in 2008): Autonomous agents make promises about their own behavior rather than issuing commands to others. This decentralized model maps naturally to container orchestration where each service is an independent unit.

**Relevance to rfapps-cli**: The "promise" concept could inform a service health contract system -- each service declares what it promises (ports open, health endpoint responding, volume writable) and the CLI verifies those promises are kept.

**Confidence**: High -- well-documented historical facts from [Wikipedia](https://en.wikipedia.org/wiki/CFEngine) and [Mark Burgess's publications](http://markburgess.org/blog_cd2.html).

### Puppet: Idempotent Resource Model (2005-)

Puppet, released in 2005, popularized the idempotent resource model for infrastructure management:

- **Idempotent operations**: "If a given resource is already in the desired state, Puppet performs no actions. If a given resource is not in the desired state, Puppet takes whatever action is necessary to put the resource into the desired state." This means running Puppet twice produces the same result as running it once.
- **Configuration drift detection**: Puppet agents poll masters periodically, comparing actual state to desired state and remediating drift automatically.
- **Declarative manifests**: JSON-based manifests describe the desired state of the entire system, versioned in source control.
- **Dry-run simulation**: Puppet can simulate resource changes without performing them -- directly analogous to rfapps-cli's `plan` command.

**Relevance to rfapps-cli**: rfapps-cli already has a plan/apply workflow inspired by Terraform (which itself was inspired by Puppet). The missing piece is **continuous drift detection** -- a `rfapps watch` or `rfapps drift` command that periodically checks whether running containers match their declared configuration and reports divergence without necessarily remediating.

**Confidence**: High -- primary source from [Puppet documentation on idempotency](https://help.puppet.com/pe/2023.8/topics/understanding_idempotency.htm) and [TechTarget analysis](https://www.techtarget.com/searchitoperations/tip/What-is-the-Puppet-configuration-management-tool-and-how-does-it-work).

### Chef and Ansible: Complementary Patterns

- **Chef** (2009): Introduced "recipes" and "cookbooks" -- modular, composable configuration units. The cookbook concept maps to service groups/profiles in rfapps-cli.
- **Ansible** (2012): Brought agentless, push-based configuration management with YAML playbooks. Its approach of SSH-based execution without persistent agents is analogous to how rfapps-cli calls Docker Compose as a subprocess without a daemon.

**Relevance to rfapps-cli**: Ansible's "role-based architecture" with clear separation of tasks, handlers, templates, and variables mirrors rfapps-cli's command/action separation pattern. The Sovereign project (see below) demonstrates this applied to self-hosting.

**Confidence**: High -- well-established tools with extensive documentation from [Mezmo comparison](https://www.mezmo.com/blog/chef-puppet-ansible-configuration-management) and [Better Stack comparison](https://betterstack.com/community/comparisons/chef-vs-puppet-vs-ansible/).

### Webmin/Virtualmin: Web-Based Server Administration (1997-)

Webmin, first released in 1997, provided web-based administration for Unix servers with approximately 1,000,000 yearly installations:

- **Unified service management**: Single interface for managing Apache, MySQL, DNS, mail, firewall, cron, and dozens of other services
- **Service configuration templating**: Webmin generated correct configuration files from web form inputs, abstracting away config file syntax
- **Multi-server management**: Virtualmin extended this to manage multiple servers and virtual hosts from one panel
- **Resource monitoring**: Built-in disk quota monitoring, bandwidth tracking, and process management

**Relevance to rfapps-cli**: Webmin's approach of providing a unified interface over heterogeneous services is exactly what rfapps-cli does for Docker Compose services. The pattern of **configuration templating from structured inputs** (rather than hand-editing YAML) could be valuable -- imagine `rfapps init --template media-stack` generating a pre-configured compose service with guided questions.

**Confidence**: Medium -- Webmin is well-documented but the specific templating patterns are general knowledge rather than formally documented design patterns. Sources: [Webmin GitHub](https://github.com/webmin/webmin), [Wikipedia](https://en.wikipedia.org/wiki/Webmin).

### ISPConfig: Multi-Server Panel (2005-)

ISPConfig 3 introduced multi-server management from a single control panel:

- **Master/slave architecture**: One master server with the control panel, multiple slave servers for web, DNS, mail, and database
- **Service isolation**: Different service types on dedicated servers
- **Automated backups**: Scheduled backups of websites, databases, and emails with restore capability
- **Cluster management**: Operating several servers from a single control panel

**Relevance to rfapps-cli**: While rfapps-cli targets single-host Docker Compose, ISPConfig's concept of **service type categorization** (web, mail, DNS, database) maps directly to rfapps-cli's profile system (core, infrastructure, downloads, arr-stack, media, photos). The backup scheduling pattern could inform a `rfapps backup` command.

**Confidence**: Medium -- sources from [ISPConfig official site](https://www.ispconfig.org/) and [HowToForge tutorials](https://www.howtoforge.com/tutorial/ispconfig-multiserver-setup-debian-ubuntu).

### cPanel/WHM: Commercial Server Management

cPanel/WHM (1996-) established patterns still relevant today:

- **Account-level isolation**: Each hosting account is isolated with its own resource quotas
- **Automated software updates**: WHM manages Apache, PHP, MySQL upgrades separately from the OS package manager
- **Template-based provisioning**: Hosting packages define resource templates (disk, bandwidth, databases) applied to accounts
- **Service monitoring and restart**: Automatic restart of failed services (Apache, MySQL, DNS)

**Relevance to rfapps-cli**: The **package/template concept** where a named template defines resource allocations maps to Docker Compose resource limits. A feature like `rfapps audit resources` that checks whether services are within their declared resource constraints would bring this pattern forward.

**Confidence**: Medium -- general industry knowledge. Sources: [cPanel Wikipedia](https://en.wikipedia.org/wiki/CPanel), [SoftwareAdvice](https://www.softwareadvice.com/server-management/cpanel-whm-profile/).

### Init Systems: Service Dependency Management

#### SysVinit (1983-)

- Linear, sequential service startup via numbered scripts in `/etc/rc.d/`
- No dependency resolution -- order determined solely by script numbering
- Simple but fragile: changing one service's startup order required renumbering

#### Upstart (2006-2014)

- **Event-driven architecture**: Services start/stop in response to system events rather than fixed ordering
- **Greedy scheduling**: All available jobs whose startup events occur are started as early as possible (parallel startup)
- **Custom events**: extensible event model via `initctl` for custom triggers
- **Backward compatible**: Could run unmodified SysVinit scripts

#### systemd (2010-)

- **Declarative dependency graph**: `After=`, `Requires=`, `Wants=` directives define service relationships
- **Socket activation**: Services started on-demand when their socket receives a connection
- **Automatic restart**: Configurable restart policies (`Restart=on-failure`, `RestartSec=5s`)
- **Resource control**: cgroups-based resource limits per service
- **Journal logging**: Centralized structured logging

**Relevance to rfapps-cli**: systemd's dependency ordering (`After=`, `Requires=`, `Wants=`) maps directly to Docker Compose's `depends_on` with conditions. The pattern worth reviving is systemd's **socket activation** -- the idea that a service should only start when something actually needs it. For a homelab with 47 services, a `rfapps start --lazy` mode that only starts services when they receive incoming connections could save significant resources.

Additionally, systemd's **automatic restart with backoff** (`Restart=on-failure` with configurable delay) is simpler than container health check + restart policy combinations. A `rfapps watch --restart-failed` command that monitors and restarts failed containers with exponential backoff would be valuable.

**Confidence**: High -- primary documentation from [systemd.io](https://systemd.io/), [Red Hat documentation](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/system_administrators_guide/chap-managing_services_with_systemd), and [Ubuntu Wiki](https://wiki.ubuntu.com/SystemdForUpstartUsers).

### Monit: Lightweight Process Supervision (2001-)

Monit deserves special attention as a pattern worth reviving:

- **Autonomous operation**: No plugins, no dependencies -- "works right out of the box"
- **Cycle-based monitoring**: Runs in daemon mode, checking services at configurable intervals
- **Multi-dimensional health checks**: Process existence, CPU/memory usage, file integrity (MD5/SHA1 checksums), network connectivity, port responsiveness
- **Automatic remediation**: Can start, stop, or restart services based on conditions (not just alive/dead, but resource thresholds)
- **Built-in web interface**: Lightweight HTTP(S) dashboard for status and control
- **Alert integration**: Email notifications with configurable thresholds
- **PID 1 capability**: Can serve as init process inside containers

Monit's configuration is remarkably simple:

```
check process apache with pidfile /var/run/apache2.pid
    start program = "/etc/init.d/apache2 start"
    stop program = "/etc/init.d/apache2 stop"
    if cpu > 60% for 2 cycles then alert
    if cpu > 80% for 5 cycles then restart
    if totalmem > 200.0 MB for 5 cycles then restart
    if children > 250 then restart
    if failed host localhost port 80 then restart
```

**Relevance to rfapps-cli**: This is the most directly applicable pattern found. Modern monitoring (Prometheus + Grafana + Alertmanager) is powerful but complex. Monit's approach of **simple, declarative health rules with automatic remediation** could be implemented as a `rfapps monitor` command that:

1. Periodically checks container health (running, healthy, resource usage)
2. Automatically restarts containers that fail health checks
3. Sends notifications (webhook, email) on state changes
4. Provides a simple text-based status dashboard

This would address a gap between rfapps-cli's current `status` command (point-in-time check) and full observability stacks (Uptime Kuma, Prometheus).

**Confidence**: High -- primary source from [Monit official documentation](https://mmonit.com/monit/) and [Monit manual](https://mmonit.com/monit/documentation/monit.html).

---

## Early Docker Tools (2013-2018)

### Fig / Docker Compose Origins (2013-2014)

Fig, created by Orchard Labs in 2013, was the direct predecessor to Docker Compose:

- **YAML-based multi-container definition**: Fig introduced the pattern of defining services, their images, ports, volumes, and links in a single YAML file
- **Single-command lifecycle**: `fig up`, `fig stop`, `fig rm` managed the entire application stack
- **Link-based networking**: Before Docker networks, Fig used `links` to connect containers
- **Acquired by Docker in 2014**: Rebranded as Docker Compose; co-founders Ben Firshman and Aanand Prasad joined Docker

**Key insight**: Fig was explicitly designed for **developer workflows** (fast iteration on multi-service apps), not for production deployment. Docker Compose inherited this developer focus, which is why it lacks production-grade features like health monitoring, rollback, and drift detection that rfapps-cli adds.

**Confidence**: High -- sources from [Docker official history](https://docs.docker.com/compose/intro/history/), [DevOps.com acquisition coverage](https://devops.com/docker-acquires-orchard/), [Fig archived site](https://orchardup.github.io/fig/).

### Docker Compose Version History

The evolution of Compose file formats reveals a pattern of feature addition and consolidation:

- **Format 1 (2014)**: No top-level `services` key; simple key-value mapping. Incompatible with modern Compose v2.
- **Format 2.x (2016)**: Added `services`, `networks`, `volumes` as top-level keys. Introduced named networks and volume drivers.
- **Format 3.x (2017)**: Added Swarm-specific `deploy` options (replicas, placement constraints, rolling updates). Nearly identical to 2.x for non-Swarm use.
- **Compose Specification (2020+)**: Eliminated version numbering. The `version` key became optional/ignored.

**Features lost or diminished in transition**:

- Compose v1 to v2 changed naming conventions (underscores to hyphens), which could break DNS-based service discovery
- The `depends_on` syntax became more explicit (requiring `condition: service_healthy`), which is actually an improvement
- Some v1 CLI flags were not carried forward to v2

**Confidence**: High -- primary source from [Docker Compose history docs](https://docs.docker.com/compose/intro/history/) and [Docker blog on v2 GA](https://www.docker.com/blog/announcing-compose-v2-general-availability/).

### Shipyard: Composable Docker Management (2013-2016)

Shipyard, created by Evan Hazlett, was one of the first Docker management UIs:

- **RESTful API-first design**: Everything built on the Shipyard API -- the UI was an AngularJS client consuming the same API available to external tools
- **Cluster management**: Built on Docker Swarm for multi-host container management
- **RethinkDB backend**: Used RethinkDB for user accounts, engine addresses, events storage
- **Citadel communication layer**: Custom library for host-to-host communication and cluster events
- **Archived February 2024**: The creator noted it "formed the foundation for what became Docker Universal Control Plane"

**Relevance to rfapps-cli**: Shipyard's **API-first design** is a pattern rfapps-cli partially implements via its MCP server mode. The key lesson is that having a programmatic API enables ecosystem tooling (dashboards, bots, automation scripts) to build on top of the CLI.

**Confidence**: High -- primary source from [Shipyard GitHub](https://github.com/ehazlett/shipyard) and [Sumo Logic writeup](https://www.sumologic.com/blog/managing-containers-docker-shipyard).

### Kitematic: Visual Docker Management (2014-2019)

Kitematic was one of the first desktop GUI applications for Docker:

- **Visual container creation**: Browse Docker Hub, one-click pull and run
- **Volume management UI**: Visual mapping of host directories to container volumes
- **Log streaming**: Real-time container log viewing
- **Environment variable editing**: GUI for container environment configuration
- **Acquired by Docker in 2015**: Bundled with Docker Toolbox, later deprecated in favor of Docker Desktop

**Relevance to rfapps-cli**: Kitematic's approach of making Docker accessible through visualization informed later tools like Portainer. The pattern of **visual volume mapping** could translate to a `rfapps inspect --volumes` command that shows volume mount relationships across services.

**Confidence**: High -- source from [Kitematic GitHub archive](https://github.com/docker/kitematic).

### Tutum / Docker Cloud (2013-2018)

Tutum, founded October 2013 and acquired by Docker in October 2015, became Docker Cloud:

- **Full lifecycle management**: Create, start, terminate, redeploy containers from a dashboard
- **Cross-cloud deployment**: Deploy across multiple cloud providers from a single interface
- **Integrated monitoring**: Built-in container monitoring (not just alive/dead but performance metrics)
- **Networking and storage management**: Integrated overlay networking and volume management
- **Scheduling and placement**: Automatic scheduling of containers across infrastructure
- **24,000+ users at acquisition time**

**Relevance to rfapps-cli**: Tutum's **integrated monitoring** is the key takeaway. Rather than requiring users to set up separate monitoring tools, Tutum built basic metrics collection into the platform itself. A `rfapps stats` or `rfapps top` command that shows real-time resource usage across all services would bring this pattern to the CLI.

**Confidence**: High -- sources from [TechCrunch acquisition coverage](https://techcrunch.com/2015/10/21/docker-acquires-cloud-startup-tutum-for-container-shipping-and-management/) and [SiliconAngle](https://siliconangle.com/2015/10/22/docker-acquires-tutum-to-deliver-cross-cloud-container-management/).

### Docker Machine (2014-2021)

Docker Machine provisioned Docker hosts on virtual machines and cloud providers:

- **Multi-provider provisioning**: VirtualBox, AWS, GCP, Azure, DigitalOcean, and more
- **TLS certificate management**: Automatic TLS setup for secure Docker daemon communication
- **Environment switching**: `eval $(docker-machine env my-vm)` to switch Docker contexts
- **Deprecated in favor of Docker Desktop** (2021)

**Relevance to rfapps-cli**: The **environment switching** pattern is relevant. A `rfapps context` command that switches between different Docker hosts or compose file locations could be useful for managing staging vs production deployments.

**Confidence**: High -- source from [Docker deprecated products docs](https://docs.docker.com/retired/).

### Docker Swarm Standalone (2014-2016) and Swarm Mode (2016-)

Docker Swarm evolved in two phases:

**Standalone Swarm (pre-1.12)**:

- Separate binary that exposed the Docker API across multiple hosts
- Used external discovery backends (etcd, Consul, ZooKeeper)
- Required separate setup and management

**Swarm Mode (Docker 1.12+)**:

- Built into Docker Engine with `docker swarm init`
- Declarative service model: `docker service create --replicas 3`
- Built-in load balancing via DNS
- Rolling updates with configurable parallelism and delay
- **Simplicity advantage**: "With just docker swarm init and docker service create, you get a functional cluster"

**Relevance to rfapps-cli**: Swarm Mode's **rolling update** model (`--update-parallelism 2 --update-delay 10s`) is worth studying. For rfapps-cli's parallel deploy, configuring how many services update simultaneously and the delay between batches would add safety to large-scale deployments.

**Confidence**: High -- sources from [Docker Swarm docs](https://docs.docker.com/engine/swarm/), [CircleCI comparison](https://circleci.com/blog/docker-swarm-vs-kubernetes/).

### CoreOS fleet: Distributed Init System (2013-2017)

Fleet tied systemd and etcd into a distributed init system:

- **Architecture**: Every node ran a `fleetd` daemon containing both an engine (scheduler) and agent (executor)
- **etcd as sole datastore**: All state -- unit files, cluster presence, unit status -- stored in etcd
- **Least-loaded scheduling**: Preferred nodes running fewer units
- **Immutable units**: Unit files were treated as immutable; changes required new unit definitions
- **Leader election**: Only one engine active at a time via lease model
- **Reconciliation loops**: Both engine and agent continuously compared desired vs actual state

**Features lost when fleet was deprecated**:

- The simplicity of extending systemd unit files to cluster scope
- Zero-configuration service discovery via etcd
- Automatic rescheduling of failed units to healthy nodes

**Relevance to rfapps-cli**: Fleet's **reconciliation loop** pattern (continuously comparing desired vs actual state) is the same pattern Puppet uses for drift detection. The key lesson: services should be continuously monitored against their declared state, not just checked at deploy time.

**Confidence**: High -- primary source from [fleet architecture docs](https://github.com/coreos/fleet/blob/master/Documentation/architecture.md) and [fleet GitHub](https://github.com/coreos/fleet).

### Rancher 1.x and Cattle (2014-2018)

Rancher 1.x with its Cattle orchestrator offered features unique among early Docker management tools:

- **Catalog system**: Templates defining complete application stacks with versioning
- **Configuration questions**: Templates included typed configuration prompts (integers, booleans, passwords, service dropdowns, enums) that generated docker-compose.yml and rancher-compose.yml
- **Stack lifecycle**: Create -> Start -> Upgrade -> Rollback -> Delete, with explicit state transitions
- **Rollback capability**: If an upgrade failed, users could rollback from the stack dropdown -- reverting to the previous version
- **Preview before deploy**: Users could review generated docker-compose.yml and rancher-compose.yml files before creating stacks
- **Environment separation**: Global catalogs vs environment-specific catalogs
- **Infrastructure services**: System-level services (networking, storage drivers, DNS) deployed via the same catalog mechanism

**This is the most directly relevant historical tool for rfapps-cli.** Rancher 1.x's catalog system is essentially what rfapps-cli could become with:

1. **Service templates**: Predefined compose snippets for common services with guided configuration
2. **Explicit upgrade workflow**: Preview changes -> apply -> verify -> finalize (or rollback)
3. **Configuration questions**: Interactive prompts that generate environment variables and compose overrides

**What was lost when Rancher moved to 2.x/Kubernetes**:

- The simplicity of Docker Compose-based deployments
- The catalog template system (replaced by Helm charts, which are more complex)
- The straightforward upgrade/rollback workflow for individual stacks

**Confidence**: High -- primary source from [Rancher 1.6 catalog docs](https://www.rancher.com/docs/rancher/v1.6/en/catalog/) and [Rancher catalog building guide](https://www.suse.com/c/rancher_blog/building-rancher-catalog-templates/).

---

## Early Self-Hosting Platforms (2014-2020)

### Sandstorm: Security-First Self-Hosting (2014-2019)

Sandstorm, a self-hostable web productivity suite, took a radically different approach to self-hosting:

- **Capability-based security**: Apps run in sandboxes and cannot communicate externally without explicit user permission. This prevents data exfiltration, unauthorized network access, and apps "phoning home."
- **Grain-based isolation**: Each document, chat room, or project is a separate "grain" with its own permissions. Users see who has access and can revoke connections at any time.
- **One-click app installation**: Apps from the Sandstorm App Market install with a single click, complete with automatic updates and cryptographic verification.
- **Cross-app integration via Powerbox**: Apps connect to each other through a permission-granting UI (e.g., feeding survey data into a spreadsheet).
- **Unified notifications and search**: Single notification system and search across all apps.
- **App authenticity verification**: Creator information verified via Twitter, GitHub, domains, and PGP keys.

**Why it failed commercially**: Sandstorm Oasis (hosted version) shut down December 31, 2019. The company "mostly shut down two years prior, having run out of investor money while achieving essentially no revenue." The business model of charging for enterprise SSO features proved insufficient.

**Relevance to rfapps-cli**: Sandstorm's **capability-based security model** is profoundly relevant. Currently, Docker containers often run with more permissions than necessary. A `rfapps audit security` command could:

1. Check for containers running as root
2. Identify unnecessary capability grants (NET_ADMIN, SYS_ADMIN)
3. Flag containers with host network access
4. Report volume mounts that expose sensitive host paths
5. Detect containers that lack read-only root filesystem

This maps directly to open issue #64 (Service Conflict Detection) and could extend to a broader security audit feature.

**Confidence**: High -- sources from [Sandstorm features page](https://sandstorm.io/features), [Sandstorm GitHub](https://github.com/sandstorm-io/sandstorm), [Oasis shutdown blog](https://sandstorm.io/news/2019-09-15-shutting-down-oasis).

### Sovereign: Ansible-Based Private Cloud (2013-)

Sovereign demonstrated a complete self-hosting stack via Ansible playbooks:

- **Role-based architecture**: ~20 services organized into modular Ansible roles (common, mail, webmail, owncloud, etc.)
- **Centralized configuration**: All variables in `group_vars/sovereign/`, eliminating scattered config files
- **Automatic secret generation**: Random database passwords generated and stored locally in `secret/` folder
- **Modular opt-out**: Comment out roles in `site.yml` to exclude services without cascading failures
- **Security stack**: fail2ban, rkhunter, UFW firewall, DKIM/DMARC/SPF for email authentication
- **Monitoring integration**: Used Monit and collectd for basic health monitoring
- **Tag-based selective execution**: Run just specific roles with Ansible tags

**Relevance to rfapps-cli**: Sovereign's patterns map remarkably well:

1. **Centralized configuration** = rfapps-cli's layered YAML config
2. **Modular opt-out** = Docker Compose profiles
3. **Secret generation** = could add a `rfapps secrets generate` that creates random passwords for new services
4. **Tag-based execution** = rfapps-cli's group-based deployment already does this
5. **Security hardening as default** = fail2ban equivalent for Docker (fail2ban for Traefik logs)

**Confidence**: Medium -- well-documented on [GitHub](https://github.com/sovereign/sovereign) but the project is no longer actively maintained. Patterns remain valid.

### Cloudron: Managed Self-Hosting (2014-)

Cloudron represents the most polished approach to self-hosting management:

- **App packaging via Docker**: Apps packaged with `CloudronManifest.json` specifying addons (MySQL, Redis, MongoDB, mail) as shared resources
- **Shared addon architecture**: Database engines, Redis, MongoDB run as shared Docker containers. Apps declare dependencies; Cloudron provisions databases automatically.
- **Immutable infrastructure**: Entire server can be migrated to another provider with all apps intact
- **Centralized user management**: Single user directory across all installed apps
- **Automated DNS and SSL**: Let's Encrypt certificates managed automatically
- **Individual app backups**: Each app backed up independently, restorable individually
- **App store with 80+ apps**: Curated, tested applications

**Relevance to rfapps-cli**: Cloudron's **shared addon model** is the most interesting pattern. Instead of each service declaring its own database container, shared infrastructure services (databases, caches) are declared once and apps request access. This could manifest as:

- `rfapps addons list` -- show shared infrastructure services
- `rfapps addons provision --type postgres --for sonarr` -- provision a database for a specific service
- Automatic environment variable injection for database connection strings

**Confidence**: High -- sources from [Cloudron official site](https://www.cloudron.io/), [Cloudron docs](https://docs.cloudron.io/), [Cloudron blog](https://blog.cloudron.io/cloudron-a-platform-for-self-hosting-web-apps/).

### Dokku: The Smallest PaaS (2013-)

Dokku pioneered minimal self-hosted PaaS:

- **Git-push deployment**: `git push dokku master` triggers build and deploy
- **Heroku buildpack compatibility**: Same buildpacks used by Heroku work in Dokku
- **Plugin architecture**: Extensible via plugins for databases, domains, SSL
- **Under 1,000 lines of Bash**: Remarkably simple implementation
- **Single-host focused**: Explicitly designed for single-server deployments (like rfapps-cli)

**Relevance to rfapps-cli**: Dokku's **extreme simplicity** is instructive. At under 1,000 lines of Bash, it manages to provide a complete deployment pipeline. The lesson: features should be added only when they provide clear value. Dokku's plugin system is also worth studying -- a `rfapps plugin` system could allow community extensions without bloating the core.

**Confidence**: High -- sources from [Dokku official site](https://dokku.com/) and [Dokku GitHub](https://github.com/dokku/dokku).

### Flynn: Full-Featured Open Source PaaS (2013-2021)

Flynn attempted to be a complete open-source PaaS:

- **Two-layer architecture**: Layer 0 (host management, scheduling, service discovery) and Layer 1 (routing, deployment, databases)
- **Built-in databases**: Managed Postgres, MongoDB, Redis as first-class components
- **Git-based deployment**: Similar to Heroku/Dokku workflow
- **Shut down March 2021**: All infrastructure including binary hosting and cluster discovery taken offline

**Why it failed**: Flynn was ambitious -- trying to be a full PaaS is enormously complex. This is a cautionary tale about feature scope.

**Relevance to rfapps-cli**: The negative lesson is most valuable. Flynn failed partly because it tried to do too much. rfapps-cli should remain focused on Docker Compose orchestration rather than trying to become a full PaaS.

**Confidence**: High -- sources from [Flynn GitHub (UNMAINTAINED)](https://github.com/flynn/flynn), [Hacker News discussion](https://news.ycombinator.com/item?id=26295065).

### Deis: CoreOS-Based PaaS (2013-2018)

Deis went through two generations:

- **Deis v1**: Built on CoreOS Container Linux and Fleet. Lightweight PaaS with Heroku-inspired workflow.
- **Deis Workflow v2**: Rebuilt on Kubernetes. Required initializing a Kubernetes cluster first.
- **Acquired by Microsoft in 2017**: Team moved to Azure projects. Development ceased 2018.

**Relevance to rfapps-cli**: Deis v1's approach of building on top of Fleet (which built on systemd) shows a pattern of **layering orchestration on top of existing service management**. rfapps-cli follows this exact pattern by layering on top of Docker Compose rather than reimplementing container management.

**Confidence**: High -- sources from [Deis GitHub](https://github.com/deis/deis) and [CompareTheCloud comparison](https://www.comparethecloud.net/articles/oss-paas-rundown-comparing-dokku-flynn-and-deis-workflow/).

### Homelab Management Scripts (2015-present)

Before GUI tools became prevalent, homelab operators used Bash scripts:

- **Folder-per-service pattern**: Each Docker image gets its own folder named after the service, containing docker-compose.yml and configuration files
- **Wrapper scripts for bulk operations**: Scripts that iterate over service folders to start, stop, update, or backup all services
- **Proxmox VE Helper Scripts**: Collection of ~200 pre-configured one-line Bash scripts for application installation and management

**Relevance to rfapps-cli**: The **folder-per-service pattern** is what rfapps-cli has evolved beyond (using a single compose.yml with profiles). However, the bulk operation scripts demonstrate the core use case: managing many services efficiently. rfapps-cli's interactive multi-select and group operations are the modern answer to these scripts.

**Confidence**: Medium -- community patterns documented across various GitHub repositories including [QNAP Docker Scripts](https://github.com/QNAP-HomeLAB/docker-scripts) and [DockerDance](https://github.com/AdamXweb/DockerDance).

---

## Abandoned Features Worth Reviving

### 1. Configuration Drift Detection (from Puppet/CFEngine/Fleet)

**Pattern**: Continuously compare running state against declared desired state. Alert on divergence.

**Application to rfapps-cli**:

```
rfapps drift check              # One-time drift scan
rfapps drift watch --interval 5m  # Continuous monitoring
```

Would detect:

- Container running a different image tag than declared
- Environment variables changed at runtime
- Port mappings altered
- Volume mounts missing or changed
- Container stopped when it should be running

**Implementation complexity**: Medium -- requires comparing `docker inspect` output against parsed compose.yml values.

**Confidence**: High -- the pattern is proven across Puppet, CFEngine, Terraform, and ArgoCD.

### 2. Lightweight Health Monitoring with Auto-Remediation (from Monit)

**Pattern**: Simple, declarative health rules with automatic corrective actions.

**Application to rfapps-cli**:

```yaml
# .rfapps.yaml
monitoring:
  interval: 30s
  rules:
    plex:
      restart_if:
        - health_check_fails: 3
        - memory_exceeds: 4GB
      alert_if:
        - cpu_exceeds: 80%
        - disk_usage_exceeds: 90%
    sonarr:
      restart_if:
        - not_responding_on: 8989
```

```
rfapps monitor start            # Start daemon
rfapps monitor status           # Show current health
rfapps monitor log              # Show recent events
```

**Implementation complexity**: Medium-High -- requires a background process or periodic execution (cron/systemd timer).

**Confidence**: High -- Monit has proven this pattern works for 20+ years.

### 3. Catalog Templates with Versioned Rollback (from Rancher 1.x)

**Pattern**: Service templates with configuration prompts, versioning, and rollback.

**Application to rfapps-cli**:

```
rfapps catalog list              # Show available service templates
rfapps catalog add --template arr-stack  # Add services with guided setup
rfapps upgrade -s sonarr --to latest     # Upgrade with preview
rfapps rollback -s sonarr --to previous  # Rollback to last known good
```

rfapps-cli already has state persistence via SQLite. Extending this to store full deployment snapshots (compose config + env + image digests) would enable Rancher-style rollback.

**Implementation complexity**: Medium -- builds on existing state persistence (issue #61, completed).

**Confidence**: High -- Rancher 1.x proved this workflow. Helm charts do similar versioned rollback for Kubernetes.

### 4. Generation-Based State Snapshots (from NixOS)

**Pattern**: Atomic state snapshots that allow instant rollback to any previous known-good configuration.

**Application to rfapps-cli**:

```
rfapps generations list          # Show all saved states
rfapps generations save "before plex upgrade"  # Named snapshot
rfapps generations rollback 42   # Restore generation #42
rfapps generations diff 41 42    # Compare two generations
```

NixOS treats system versions like Git commits. rfapps-cli could treat deployment states the same way -- each `rfapps deploy` creates a new generation, and any generation can be restored.

**Implementation complexity**: Medium -- SQLite already stores deployment history. Adding full state capture (all service configs, image digests, env vars) and restore capability is an extension.

**Confidence**: High -- NixOS has proven this model works at OS scale. Sources: [NixOS official site](https://nixos.org/), [NixOS Wiki](https://wiki.nixos.org/wiki/NixOS).

### 5. Package Manager Transaction History (from YUM/DNF)

**Pattern**: Full transaction log with undo/redo capability.

**Application to rfapps-cli**:

```
rfapps history                   # Show deployment history
rfapps history info 15           # Details of transaction 15
rfapps history undo 15           # Reverse transaction 15
rfapps history redo 15           # Replay transaction 15
```

YUM's `yum history undo` reverses a specific transaction, handling dependency changes correctly. rfapps-cli could implement similar undo logic for deployments.

**Implementation complexity**: Low-Medium -- rfapps-cli already stores deployment history. Adding undo/redo is extending existing functionality.

**Confidence**: High -- YUM/DNF transaction history is battle-tested across millions of RHEL/CentOS/Fedora systems. Sources: [Red Hat docs](https://access.redhat.com/solutions/64069).

### 6. Capability-Based Security Auditing (from Sandstorm)

**Pattern**: Per-service visibility into security posture with actionable recommendations.

**Application to rfapps-cli**:

```
rfapps audit security            # Full security scan
rfapps audit security -s plex    # Single service audit
```

Would check:

- Running as root (suggest user namespace remapping)
- Excessive Linux capabilities (suggest dropping all, adding only needed)
- Host network mode (suggest bridge with explicit port mapping)
- Privileged mode (flag as critical risk)
- No read-only root filesystem (suggest `read_only: true`)
- Sensitive host path mounts (`/etc`, `/var/run/docker.sock`)
- Missing resource limits (memory, CPU)
- No security options (suggest `no-new-privileges:true`)

**Implementation complexity**: Low-Medium -- mostly static analysis of compose.yml with a rules engine.

**Confidence**: High -- Docker security best practices are well-established. CIS Docker Benchmark provides comprehensive checklist.

### 7. Event-Driven Service Activation (from Upstart/systemd)

**Pattern**: Start services on-demand when they receive traffic, rather than keeping all services running.

**Application to rfapps-cli**: For a 47-service homelab, many services are used infrequently. A lazy-start mode could:

- Keep only core services (Traefik, Authentik) running permanently
- Start other services when Traefik receives a request for their route
- Stop idle services after a configurable timeout

**Implementation complexity**: High -- requires integration with Traefik's routing to detect incoming requests and trigger container starts.

**Confidence**: Low -- while the pattern is proven in systemd socket activation, applying it to Docker Compose + Traefik routing is novel and unproven at this scale.

### 8. Shared Infrastructure Addons (from Cloudron)

**Pattern**: Shared database/cache services provisioned automatically for dependent apps.

**Application to rfapps-cli**: Rather than each service bringing its own database, shared PostgreSQL/MariaDB/Redis instances could be managed centrally:

```
rfapps addons list
rfapps addons create postgres --name shared-pg
rfapps addons attach shared-pg --to sonarr radarr lidarr
```

**Implementation complexity**: High -- requires database provisioning automation and connection string injection.

**Confidence**: Medium -- Cloudron proves the pattern, but it requires significant additional tooling.

---

## Comparative Analysis

### Tool Lifecycle Patterns

| Tool           | Born | Peak       | Deprecated/Archived       | Cause of Death             |
| -------------- | ---- | ---------- | ------------------------- | -------------------------- |
| CFEngine       | 1993 | 2000s      | Still active              | N/A (evolved)              |
| Webmin         | 1997 | 2000s      | Still active              | N/A (evolved)              |
| Monit          | 2001 | 2000-2010s | Still active              | N/A (niche but stable)     |
| Puppet         | 2005 | 2012-2016  | Still active (diminished) | Container revolution       |
| Fig            | 2013 | 2014       | 2014 (became Compose)     | Acquired by Docker         |
| Shipyard       | 2013 | 2015-2016  | 2024 (archived)           | Became Docker UCP          |
| Kitematic      | 2014 | 2015       | 2019                      | Replaced by Docker Desktop |
| Tutum          | 2013 | 2015       | 2018 (Docker Cloud EOL)   | Docker strategic pivot     |
| Fleet          | 2013 | 2015       | 2017                      | Kubernetes won             |
| Dokku          | 2013 | Ongoing    | Still active              | N/A (focused scope)        |
| Sandstorm      | 2014 | 2015-2016  | 2019 (Oasis shutdown)     | No revenue model           |
| Sovereign      | 2013 | 2014-2016  | ~2018 (unmaintained)      | Maintenance burden         |
| Rancher 1.x    | 2014 | 2016-2017  | 2018 (replaced by 2.x)    | Kubernetes pivot           |
| Deis           | 2013 | 2015-2016  | 2018                      | Acquired by Microsoft      |
| Flynn          | 2013 | 2015-2017  | 2021                      | Scope too ambitious        |
| Docker Machine | 2014 | 2015-2016  | 2021                      | Docker Desktop replaced    |

### Survival Analysis

Tools that survived share common traits:

- **Focused scope**: Dokku (single-host PaaS), Monit (process monitoring), Webmin (server admin)
- **Simplicity**: Tools that did one thing well outlasted those that tried to do everything
- **Active community or institutional backing**: CFEngine (company), Webmin (community)

Tools that died share common traits:

- **Over-ambition**: Flynn tried to be a full PaaS; Sandstorm tried to reinvent app distribution
- **Platform dependency**: Fleet died with CoreOS; Deis v1 died with Fleet
- **Acquisition absorption**: Kitematic, Tutum, Shipyard all absorbed into larger Docker products
- **No business model**: Sandstorm, Sovereign, Flynn

**Lesson for rfapps-cli**: Stay focused on Docker Compose orchestration. The tool's strength is that it enhances an existing, well-maintained platform (Docker Compose) rather than replacing it. Every feature should ask: "Does this make Docker Compose management better, or is this trying to be something else?"

### Feature Mapping: Past to Present

| Historical Feature        | Original Tool         | rfapps-cli Status               | Recommendation         |
| ------------------------- | --------------------- | ------------------------------- | ---------------------- |
| Desired state declaration | Puppet/CFEngine       | Implemented (compose.yml)       | Complete               |
| Dry-run/plan              | Puppet/Terraform      | Implemented (`rfapps plan`)     | Complete               |
| Drift detection           | Puppet/CFEngine/Fleet | Not implemented                 | **High priority**      |
| Health monitoring daemon  | Monit                 | Not implemented                 | **Medium priority**    |
| Auto-restart failed       | Monit/systemd         | Partial (Docker restart policy) | Extend with monitoring |
| Catalog templates         | Rancher 1.x           | Not implemented                 | Medium priority        |
| Versioned rollback        | Rancher 1.x/NixOS     | Partial (state history exists)  | **High priority**      |
| Transaction undo          | YUM/DNF               | Not implemented                 | Medium priority        |
| Security auditing         | Sandstorm             | Not implemented                 | **Medium priority**    |
| API-first design          | Shipyard              | Partial (MCP server)            | Extend                 |
| Resource monitoring       | Tutum/Webmin          | Not implemented                 | Low priority           |
| Socket activation         | systemd/Upstart       | Not implemented                 | Low priority (complex) |
| Shared addons             | Cloudron              | Not implemented                 | Low priority (complex) |
| Plugin system             | Dokku                 | Not implemented                 | Low priority           |

---

## Key Insights

### 1. The Monitoring Gap

The most consistent pattern across all historical tools is some form of continuous health monitoring with automatic remediation. From Monit (2001) to Puppet (2005) to Fleet (2013), the pattern repeats: declare desired state, continuously check actual state, remediate divergence.

rfapps-cli currently checks state only at deploy time. Adding continuous monitoring (even simple, Monit-style) would fill the biggest gap between rfapps-cli and historical best practices.

### 2. Rollback is Non-Negotiable

Every successful orchestration tool has rollback. Rancher 1.x had it. NixOS has it. YUM has it. Docker Compose... does not (natively). rfapps-cli's existing state persistence via SQLite makes this achievable. This should be a high-priority feature.

### 3. Simplicity Wins Over Time

Dokku (1,000 lines of Bash, still active) outlasted Flynn (full PaaS, dead). Monit (zero dependencies, still active) outlasted complex monitoring stacks that came and went. The tools that survive are the ones that do one thing exceptionally well.

rfapps-cli should resist the temptation to add features just because historical tools had them. Each addition should pass the test: "Is this simpler than the alternative, or am I recreating complexity?"

### 4. Security Auditing Was Ahead of Its Time

Sandstorm's capability-based security model (2014) anticipated concerns that are now mainstream. Container security scanning, privilege auditing, and network policy enforcement are standard in enterprise Kubernetes but largely absent from homelab Docker Compose tooling. rfapps-cli could differentiate by making security auditing accessible to self-hosters.

### 5. Templates and Guided Setup Reduce Friction

Rancher 1.x's configuration questions, Cloudron's manifest system, and even Webmin's form-based configuration all share the pattern of **guided service setup**. Rather than requiring users to know the correct YAML syntax, these tools asked questions and generated configuration. A `rfapps catalog` or `rfapps init --template` feature would lower the barrier for adding new services.

---

## Evidence Quality Assessment

| Finding                  | Evidence Type              | Source Count | Freshness           | Confidence |
| ------------------------ | -------------------------- | ------------ | ------------------- | ---------- |
| CFEngine/Puppet patterns | Primary documentation      | 5+           | Evergreen concepts  | High       |
| Monit features           | Primary documentation      | 3+           | Still maintained    | High       |
| Fig/Compose history      | Official Docker docs       | 4+           | Historical record   | High       |
| Shipyard features        | GitHub archive, blog posts | 3+           | 2016-2024           | High       |
| Rancher 1.x catalog      | Official Rancher docs      | 4+           | 2017 (archived)     | High       |
| Sandstorm features       | Official site, GitHub      | 3+           | 2019 (shutdown)     | High       |
| Cloudron architecture    | Official docs, blog        | 3+           | Current (active)    | High       |
| Sovereign patterns       | GitHub, blog posts         | 2+           | 2018 (unmaintained) | Medium     |
| Fleet architecture       | GitHub docs                | 2+           | 2017 (deprecated)   | High       |
| NixOS rollback model     | Official wiki, docs        | 3+           | Current (active)    | High       |
| Homelab script patterns  | GitHub repos               | 3+           | Various             | Medium     |

---

## Search Queries Executed

1. "Docker management tools 2014 2015 2016 early history Shipyard Kitematic"
2. "Fig Docker Compose predecessor features history orchard"
3. "Sandstorm self-hosting platform features approach discontinued"
4. "Cloudron self-hosting management features architecture app packaging"
5. "Puppet Chef Docker container management patterns configuration management server"
6. "Webmin server management features modern equivalent virtual admin"
7. "homelab management scripts bash Docker before GUI tools 2015 2016 2017"
8. "Rancher 1.x Docker management features deprecated cattle orchestrator"
9. "systemd service management patterns container orchestration dependency ordering"
10. "Shipyard Docker UI features discontinued archived what it did"
11. "Nagios Monit server monitoring simple lightweight Docker alternative"
12. "Sovereign self-hosting ansible project features approach mail-in-a-box"
13. "Docker Tutum features cloud management acquired 2015"
14. "cPanel WHM server management features service orchestration"
15. "Monit process supervision daemon monitoring restart features simple"
16. "Docker compose v1 vs v2 features lost deprecated changes breaking"
17. "Puppet idempotent resource model desired state configuration management lessons"
18. "apt dpkg yum rollback package manager features undo transaction history"
19. "CoreOS fleet etcd distributed init system features discontinued"
20. "Docker swarm features standalone mode service management simplicity"
21. "Deis Heroku self-hosted PaaS features workflow Docker discontinued"
22. "Dokku mini Heroku self-hosting features deployment patterns simple PaaS"
23. "Flynn PaaS open source features architecture discontinued what happened"
24. "cfengine configuration management history first tool 1993 mark burgess"
25. "Docker Portainer early versions features 2016 2017 history evolution"
26. "Rancher 1.6 catalog templates stacks service management features"
27. "configuration drift detection remediation tools patterns server Docker"
28. "upstart init system service management features before systemd"
29. "ISPConfig server management panel features multi-server setup history"
30. "Ansible playbook Docker compose integration service deployment patterns"
31. "NixOS declarative system configuration reproducible rollback generation"
32. "supervisord process manager Docker container features"
33. "Docker machine features deprecated virtual machine provisioning"

---

## Uncertainties and Gaps

1. **Quantitative impact data**: The research could not find rigorous studies on the actual productivity impact of features like drift detection or rollback in homelab contexts. Most evidence is anecdotal or from enterprise settings.

2. **Portainer early history**: Specific details about Portainer's earliest versions (2016-2017) and what features it launched with vs. added later were difficult to find.

3. **Docker Universal Control Plane**: Shipyard "formed the foundation for Docker UCP" but the exact features carried forward vs. dropped are not well-documented publicly.

4. **Homelab-specific monitoring patterns**: Most monitoring literature targets enterprise environments. The specific needs and constraints of homelab operators (single server, limited resources, intermittent use) are underrepresented in formal documentation.

5. **Feature adoption rates**: For historical tools that offered multiple features, data on which features users actually used vs. ignored is sparse. This matters for prioritizing which patterns to revive.

---

## Sources

### Primary Sources (Official Documentation)

- [Docker Compose History](https://docs.docker.com/compose/intro/history/)
- [Sandstorm Features](https://sandstorm.io/features)
- [Sandstorm GitHub](https://github.com/sandstorm-io/sandstorm)
- [Monit Official Site](https://mmonit.com/monit/)
- [Monit Manual](https://mmonit.com/monit/documentation/monit.html)
- [Rancher 1.6 Catalog Docs](https://www.rancher.com/docs/rancher/v1.6/en/catalog/)
- [Fleet Architecture](https://github.com/coreos/fleet/blob/master/Documentation/architecture.md)
- [Fleet GitHub](https://github.com/coreos/fleet)
- [Puppet Idempotency Docs](https://help.puppet.com/pe/2023.8/topics/understanding_idempotency.htm)
- [Docker Swarm Mode Docs](https://docs.docker.com/engine/swarm/)
- [systemd Documentation](https://systemd.io/)
- [Red Hat systemd Guide](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/system_administrators_guide/chap-managing_services_with_systemd)
- [NixOS Official Site](https://nixos.org/)
- [NixOS Wiki - nixos-rebuild](https://wiki.nixos.org/wiki/Nixos-rebuild)
- [Cloudron Official Site](https://www.cloudron.io/)
- [Cloudron Documentation](https://docs.cloudron.io/)
- [Dokku Official Site](https://dokku.com/)
- [Dokku GitHub](https://github.com/dokku/dokku)
- [Docker Deprecated Products](https://docs.docker.com/retired/)
- [Red Hat YUM History](https://access.redhat.com/solutions/64069)
- [ISPConfig Official](https://www.ispconfig.org/)

### Secondary Sources (Analysis and Coverage)

- [TechCrunch: Docker Acquires Tutum](https://techcrunch.com/2015/10/21/docker-acquires-cloud-startup-tutum-for-container-shipping-and-management/)
- [SiliconAngle: Docker Acquires Tutum](https://siliconangle.com/2015/10/22/docker-acquires-tutum-to-deliver-cross-cloud-container-management/)
- [DevOps.com: Docker Acquires Orchard](https://devops.com/docker-acquires-orchard/)
- [TechTarget: Docker History](https://www.techtarget.com/searchitoperations/feature/The-history-of-Dockers-climb-in-the-container-management-market)
- [Docker Blog: Compose v2 GA](https://www.docker.com/blog/announcing-compose-v2-general-availability/)
- [Sandstorm Oasis Shutdown](https://sandstorm.io/news/2019-09-15-shutting-down-oasis)
- [Sandstorm Community Roots](https://sandstorm.io/news/2017-02-06-sandstorm-returning-to-community-roots)
- [Hacker News: RIP Flynn.io](https://news.ycombinator.com/item?id=26295065)
- [CompareTheCloud: OSS PaaS Rundown](https://www.comparethecloud.net/articles/oss-paas-rundown-comparing-dokku-flynn-and-deis-workflow/)
- [Mezmo: Chef vs Puppet vs Ansible](https://www.mezmo.com/blog/chef-puppet-ansible-configuration-management)
- [Better Stack: Chef vs Puppet vs Ansible](https://betterstack.com/community/comparisons/chef-vs-puppet-vs-ansible/)
- [CircleCI: Swarm vs Kubernetes](https://circleci.com/blog/docker-swarm-vs-kubernetes/)
- [Sumo Logic: Docker Shipyard](https://www.sumologic.com/blog/managing-containers-docker-shipyard)
- [Cloudron Blog](https://blog.cloudron.io/cloudron-a-platform-for-self-hosting-web-apps/)

### GitHub Repositories

- [Shipyard (Archived)](https://github.com/ehazlett/shipyard)
- [Kitematic (Archived)](https://github.com/docker/kitematic)
- [Sovereign](https://github.com/sovereign/sovereign)
- [Flynn (UNMAINTAINED)](https://github.com/flynn/flynn)
- [Deis v1](https://github.com/deis/deis)
- [Rancher Cattle](https://github.com/rancher/cattle)
- [Webmin](https://github.com/webmin/webmin)
- [CFEngine Wikipedia](https://en.wikipedia.org/wiki/CFEngine)
