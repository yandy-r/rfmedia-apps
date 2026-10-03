# rfapps Tag Selector

`--tag <pattern>` narrows an existing rfapps service selection by hierarchical tag, and the
read-only `rfapps tag` command group inspects the taxonomy those patterns match against. Tags are
hand-authored in the `tags:` section of the layered YAML configuration and are reviewed like any
other configuration change.

Every tag surface in v1 is read-only. It **never writes `compose.yml`**, **never writes the state
database**, **never writes configuration**, and **never takes the global state lock**. The only file
any tag surface can create is the fragment `rfapps tag suggest --out <path>` writes, and that write
refuses to overwrite an existing file.

When `--tag` is absent nothing new runs: the flag is unset, the tag axis short-circuits before the
index is built, and the resolved service list is byte-for-byte what the same command produced before
this feature existed.

## Selector Algebra

Let `U` be the set of service names in `compose.yml`.

```text
NAMES   = { --service } ∪ { --services... }        or ∅ if neither flag given
GROUPS  = ⋃ config.groups[g] for each -g           or ∅ if not given

BASE    = NAMES ∪ GROUPS                            if either flag given
        = SENTINEL_ALL                              otherwise

For each --tag occurrence k:
  INC_k = ⋃ { s ∈ U : serviceMatches(p, s) } over positive patterns p in flag k
        = U                                          if flag k has only negations
  EXC_k = ⋃ { s ∈ U : serviceMatches(p, s) } over negated patterns !p in flag k
  T_k   = INC_k \ EXC_k

TAGS    = ⋂_k T_k                                    over all --tag occurrences
        = NO_TAG                                     if there are none

RESULT  = BASE                                       if TAGS = NO_TAG
        = materialize(BASE) ∩ TAGS                   otherwise
              where materialize(SENTINEL_ALL) = U
```

Read in one sentence: patterns inside a single `--tag` are **OR**-ed, repeated `--tag` flags are
**AND**-ed, and the result is **intersected** with whatever `-s`, `--services`, and `-g` already
selected.

The properties that follow from those equations are the contract:

| Property | Guarantee                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | No `--tag` means no behaviour change. The tag branch is unreachable, not merely equivalent.                                                                                   |
| P2       | A non-empty `--tag` that matches nothing **throws** `TagSelectorEmptyError` (exit `2`). It never returns the empty service list, which rfapps reads as "the whole project".   |
| P3       | Misspelled service and group names are validated **before** the tag intersection, so `rfapps deploy -s plexx --tag "media/**"` still reports `Did you mean 'plex'?`.          |
| P4       | A `tags.mapping` entry naming a service absent from `compose.yml` is diagnosed by name in the error, not silently swallowed.                                                  |
| P5       | Result ordering is preserved: the order of `-s`/`--services`/`-g` expansion, or compose declaration order when there was no other selector. Output stays stable and diffable. |
| P6       | A tag-derived selection is indistinguishable downstream — sidecar expansion, `--force-recreate` on expansion, and profile auto-detection all behave exactly as with `-s`.     |

P2 is the load-bearing one. `services: []` is an overloaded sentinel that makes rfapps omit the
service list from the `docker compose` argv, so a glob that matched nothing and fell through would
silently target every service — including under `rfapps delete`. It throws instead.

`--tag` narrows; it never widens. `rfapps deploy -g arr-stack --tag "media/automation"` deploys the
intersection, and `rfapps stop -s plex --tag "media/**"` is a usable assertion: it exits `2` when
`plex` is not tagged under `media`.

## Tag Path Grammar

```text
tag      := segment ( "/" segment ){0,7}          # 1..8 segments
segment  := [a-z0-9] ( [a-z0-9._-]* [a-z0-9] )?   # starts/ends alphanumeric
```

| Limit                    | Value |
| ------------------------ | ----- |
| Maximum depth            | 8     |
| Maximum segment length   | 40    |
| Maximum total tag length | 128   |

Every tag is normalized before it is stored in the index or compared against a pattern:

1. Trim surrounding whitespace.
2. Lowercase. Tags are case-insensitive; the canonical form is lowercase.
3. Strip at most one leading `/` and at most one trailing `/`.
4. Split on `/`. Any empty segment (`a//b`, or a doubled leading/trailing slash) is an error.
5. Validate each segment against the charset above.
6. Validate depth, segment length, and total length.

Normalization is idempotent. `Media/Streaming/` and `media/streaming` denote the same tag; `a//b`
has no defensible canonical reading and is rejected rather than guessed at. A `--tag` literal that
fails normalization is a usage error (exit `2`); a `tags.mapping` value that fails it is a
configuration error (also exit `2`) raised when the index is built, so it fails at the boundary
rather than halfway through a deploy.

Case folding of configuration input additionally produces a validation warning, so
`rfapps validate` reports `Tag 'Media/Streaming' for service 'plex' was normalized to
'media/streaming'`.

### Ancestor Closure

> A service tagged `a/b/c` **implicitly carries** `a/b` and `a`.

```text
tagAncestors("a/b/c") === ["a", "a/b", "a/b/c"]
tagAncestors("a")     === ["a"]
```

A service's **effective tag set** is the union, over its declared tags, of that tag and every proper
prefix. All matching is against the effective set, never the declared set. This is what makes the
hierarchy mean anything: without it, `--tag infrastructure` would match nothing on a fleet tagged at
depth three. Store leaf paths only — ancestors are derived, so the flat map in configuration is
lossless for hierarchy.

### Pattern Grammar

```text
pattern  := [ "!" ] element ( "/" element ){0,7}
element  := segment | "*" | "**"
```

| Token       | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| literal     | matches that exact segment                                   |
| `*`         | matches **exactly one** segment. Never crosses `/`.          |
| `**`        | matches **zero or more** segments. Crosses `/`.              |
| leading `!` | negates the whole pattern (contributes to the exclusion set) |

Wildcards occupy a whole element. `net*`, `*working`, `a**b`, and `infra?tructure` are rejected as
usage errors — partial-segment wildcards are deliberately not supported, which keeps matching a pure
segment-array comparison and keeps `*` from ever meaning "any character". Multiple `**` per pattern
are allowed (`a/**/b/**/c`). Patterns are anchored at both ends: the pattern must consume the entire
tag path.

**Trailing `/*` is rejected.** See [Common Surprises](#common-surprises).

## Glob Semantics

Section references in the table below (`§3.4`) are to the design document,
`docs/plans/63-hierarchical-tag-selector/design.md`.

Fixture:

```yaml
tags:
  mapping:
    traefik: [infrastructure/core/networking]
    homarr: [infrastructure]
    plex: [media/streaming, hardware/gpu]
    sabnzbd: [downloads/usenet]
```

Effective sets:

```text
E(traefik) = { infrastructure, infrastructure/core, infrastructure/core/networking }
E(homarr)  = { infrastructure }
E(plex)    = { hardware, hardware/gpu, media, media/streaming }
E(sabnzbd) = { downloads, downloads/usenet }
```

| Pattern                                | Matches                        | Does NOT match           | Reading                                                                                |
| -------------------------------------- | ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| `infrastructure`                       | traefik, homarr                | plex, sabnzbd            | **bare segment = the whole subtree, inclusive**                                        |
| `infrastructure/**`                    | traefik, homarr                | plex, sabnzbd            | identical to bare `infrastructure` (`**` matches zero segments)                        |
| `infrastructure/*`                     | —                              | —                        | **REJECTED at parse time** (§3.4). `InvalidArgumentError`, suggesting `infrastructure` |
| `infrastructure/core`                  | traefik                        | homarr, plex, sabnzbd    | exact ancestor match                                                                   |
| `infrastructure/core/networking`       | traefik                        | homarr, plex, sabnzbd    | exact declared tag                                                                     |
| `infrastructure/core/**`               | traefik                        | homarr, plex, sabnzbd    | subtree below an ancestor                                                              |
| `*/core/**`                            | traefik                        | homarr, plex, sabnzbd    | interior single-segment wildcard                                                       |
| `**/networking`                        | traefik                        | homarr, plex, sabnzbd    | leaf-anchored, any depth                                                               |
| `*`                                    | traefik, homarr, plex, sabnzbd | —                        | every service with any depth-1 effective tag                                           |
| `**`                                   | traefik, homarr, plex, sabnzbd | —                        | every **tagged** service                                                               |
| `media`                                | plex                           | traefik, homarr, sabnzbd |                                                                                        |
| `hardware/gpu`                         | plex                           | traefik, homarr, sabnzbd | a multi-tag service matched on its **second** tag                                      |
| `MEDIA/Streaming`                      | plex                           | —                        | **case-insensitive** — normalizes to `media/streaming`                                 |
| `!media/**`                            | traefik, homarr, sabnzbd       | plex                     | negation                                                                               |
| `media/**,hardware/**`                 | plex                           | traefik, homarr, sabnzbd | **OR** within one `--tag` flag                                                         |
| `--tag "media/**" --tag "hardware/**"` | plex                           | traefik, homarr, sabnzbd | **AND** across `--tag` flags                                                           |
| `typoo/**`                             | —                              | —                        | **empty ⇒ `TagSelectorEmptyError`, exit 2** (never `[]`)                               |
| any pattern, service with no tags      | —                              | that service             | an untagged service matches nothing, including `**`                                    |

**Derived identity:** `X ≡ X/**`. Both denote the X subtree including X itself. Because trailing
`/*` is rejected, there is no third, subtly different form to confuse.

## Common Surprises

**Trailing `/*` is a usage error, not "one level down".** Under ancestor closure, `X/*` would mean
"the X subtree, _excluding_ services whose only X-tag is the depth-1 `X`" — a strict subset of `X`
with a non-obvious exclusion rule that inverts every filesystem-glob intuition. It has no use case
that `X` does not serve better, so it is rejected and the error names the fix:

```text
Error: Invalid value 'infrastructure/*' for --tag: trailing '/*' is not supported

Suggestions:
  Use 'infrastructure' to select the whole subtree
  Use 'infrastructure/**' for the same thing, written explicitly
  Run with --debug for more details
```

Interior `*` is unaffected: `*/core/**` and `media/*/tv` are fully supported. Only the trailing
position is rejected, because only there does ancestor closure turn it into a trap.

**A bare segment already means the whole subtree.** `--tag media` selects everything under `media`,
not just services tagged exactly `media`. Use the deepest path you actually mean.

**`!pattern` also selects untagged services.** An untagged service has an empty effective set, so
every positive pattern is false for it — but every negation is also vacuously non-excluding. That
makes `--tag "!media/**"` select the untagged fleet as well; it is _not_ the complement of
`--tag "**"`. For "tagged, but not media", write `--tag "**" --tag "!media/**"`.

**Repeating `--tag` narrows; it does not add.** Two `--tag` flags intersect. To widen within one
axis, use the comma form: `--tag "media/**,photos/**"`.

**A `tags:` block in a higher configuration layer replaces the base one.** Configuration merging is
one level deep for every collection, and `tags.mapping` is no exception. Adding one personal tag in
`.rfapps.yaml` discards the entire fleet taxonomy from `rfapps.config.yaml`. `rfapps validate` warns
when more than one layer defines `tags:`, and `rfapps tag list` prints the winning layer's absolute
path as `Source:`.

**`rfapps tag list` takes no pattern argument.** Query and selection stay separate so that one
syntax never carries two exit-code contracts. To find out what a pattern selects, run the operating
command with `--dry-run`, or filter `rfapps tag list --json` with `jq`.

## Command Syntax

```text
rfapps tag list    [--tree] [-f <compose>] [-e <env-file>] [-p <profile>] [--json]
rfapps tag show    -s <service> | --services <names>   [-f] [-e] [-p] [--json]
rfapps tag suggest [-s <service>] [--services <names>] [-g <group>]
                   [--rule <ids>] [--list-rules] [--include-tagged]
                   [-o|--out <path>] [-f] [-e] [-p] [--json]
```

| Option                  | Applies To    | Description                                              |
| ----------------------- | ------------- | -------------------------------------------------------- |
| `--tree`                | list          | Render the taxonomy as an indented tree                  |
| `-s, --service <name>`  | show, suggest | Target a specific service                                |
| `--services <names>`    | show, suggest | Target comma-separated services                          |
| `-g, --group <name>`    | suggest       | Target a configured service group                        |
| `--rule <ids>`          | suggest       | Restrict inference to a comma-separated rule allowlist   |
| `--list-rules`          | suggest       | Print the inference rule catalog and exit                |
| `--include-tagged`      | suggest       | Include services whose proposed tags are already present |
| `-o, --out <path>`      | suggest       | Write the YAML fragment to `<path>` instead of stdout    |
| `-f, --compose <path>`  | all           | Path to Docker Compose file                              |
| `-e, --env-file <path>` | all           | Path to environment file                                 |
| `-p, --profile <name>`  | all           | Docker Compose profile to use                            |
| `--json`                | all           | Emit the versioned `tags.v1` result as JSON              |

The targeting flag itself is long-only and repeatable:

| Option            | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `--tag <pattern>` | Narrow targets by hierarchical tag pattern (repeatable) |

`--tag` is declared on **21 command paths** — every command that already carries `-g/--group`, plus
`status`: `status`, `health`, `pull`, `build`, `deploy`, `stop`, `rebuild`, `delete`, `prune`,
`plan`, `lint`, `audit`, `backup`, `doctor`, `drift detect`, `drift reconcile`, `drift import`,
`harden`, `import`, `reconcile`, and `update`. It is deliberately absent from `drift show`,
`rollback`, and `history`, whose `-s` is a single-service requirement or a query filter rather than
a target.

```bash
# --- Issue #63's examples, corrected: trailing "/*" is rejected ---
rfapps status  --tag infrastructure            # was: --tag "infrastructure/*"
rfapps rebuild --tag "media/automation" --yes  # was: --tag "media/automation/*"

# --- Selection ---
rfapps plan   --tag media                      # the whole media subtree
rfapps deploy --tag "media/streaming" --yes
rfapps pull   --tag "media/**,photos/**"       # OR within one flag
rfapps stop   --tag "**" --tag "!media/**"     # AND across flags: tagged, not media
rfapps status --tag "**/networking"
rfapps deploy -g arr-stack --tag "media/automation" --yes   # INTERSECTION

# --- Assertion idiom (intersection makes this useful) ---
rfapps stop -s plex --tag "media/**"           # exits 2 if plex is not tagged media

# --- Inspection ---
rfapps tag list
rfapps tag list --tree
rfapps tag list --json
rfapps tag show -s plex
rfapps tag show --services plex,sonarr --json

# --- Inference ---
rfapps tag suggest
rfapps tag suggest --list-rules
rfapps tag suggest --rule tag-infer-ingress,tag-infer-arr
rfapps tag suggest --out tags-fragment.yaml    # refuses to clobber an existing file
```

The following combinations are rejected as usage errors (exit `2`): `--tag` with `backup --all`,
because `--all` is the one flag that means "target everything" and a narrowing flag beside it is
contradictory; `--tag` with `update --from-plan`, because silently re-scoping a frozen, reviewed
managed-update plan on a lock-taking command is a wrong-target incident waiting to happen; and
`--output csv` on `rfapps tag list` or `rfapps tag show`, because both results are hierarchical and
flattening them would be lossy. `--out` on an existing path is also a usage error, so a second run
never overwrites a fragment you have already edited.

`-p/--profile` is Compose profile activation, not targeting. The resolver consults the default
profile only when the service list is empty, and `--tag` always produces a non-empty explicit list,
so `--profile` is ignored alongside `--tag` exactly as it already is alongside `-s` or `-g`.
Auto-detected profiles win.

`--tag` is a targeting flag, so it suppresses the interactive multi-select the same way `-s` and
`-g` do. `rfapps deploy --tag "media/**"` on a TTY runs the deploy; it does not pop the picker.

## Inference Rule Catalog

`rfapps tag suggest` proposes a starter taxonomy. It writes nothing to configuration, ever: the
fragment goes to stdout (prose goes to stderr, so `rfapps tag suggest > fragment.yaml` captures only
the block) or to `--out <path>`. It takes no lock and has no `--apply`.

| Rule id              | Signal                                                                                                | Proposal                                                                                                                                                                                      | Confidence | Needs Docker     |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| `tag-infer-profile`  | `config.profiles.mapping[s]`                                                                          | root segment: `core`→`platform/core`, `infrastructure`→`platform/infrastructure`, `downloads`→`media/downloads`, `arr-stack`→`media/automation`, `media`→`media/streaming`, `photos`→`photos` | medium     | no               |
| `tag-infer-group`    | membership in `config.groups`                                                                         | second segment from the group slug, e.g. `auth-stack`→`platform/identity`                                                                                                                     | medium     | no               |
| `tag-infer-arr`      | service name matches `/^(son\|rad\|lid\|read\|baz\|prowl)arr$/`, or image matches `linuxserver/.*arr` | `media/automation/arr`                                                                                                                                                                        | high       | name variant: no |
| `tag-infer-database` | image basename ∈ `{postgres, mariadb, mysql, mongo}`                                                  | `data/database`                                                                                                                                                                               | high       | yes              |
| `tag-infer-cache`    | image basename ∈ `{redis, valkey, memcached}`                                                         | `data/cache`                                                                                                                                                                                  | high       | yes              |
| `tag-infer-ingress`  | a `traefik.enable` label is present, or image basename ∈ `{traefik, nginx, caddy, haproxy}`           | `network/ingress`                                                                                                                                                                             | high       | yes              |
| `tag-infer-tailnet`  | a `docktail.service.*` label is present                                                               | `network/tailnet`                                                                                                                                                                             | high       | yes              |

By default only services that would gain something are proposed, which makes repeated runs
idempotent; `--include-tagged` shows everything. `--list-rules` prints the catalog to stderr and
returns early.

If the Docker CLI is unavailable, inference **degrades** to the configuration-only rules
(`tag-infer-profile`, `tag-infer-group`, and the name variant of `tag-infer-arr`), reports
`degraded: true`, and lists the skipped rule ids. Fail-soft is correct here because the surface is
advisory and mutates nothing.

The generated fragment is a **paste source, not a loadable config layer**. Its header says so,
because saving it as `.rfapps.yaml` would shadow the whole taxonomy rather than extend it.

## Machine Result Contract

Each `tag` subcommand carries a local `--json`; the global `--output json` / `--output yaml` work as
well, and the local flag is checked first. Every document carries `"schemaVersion": "tags.v1"` and
goes to stdout, with all prose on stderr.

`rfapps tag list --json`:

```json
{
  "schemaVersion": "tags.v1",
  "tags": [
    {
      "tag": "infrastructure",
      "depth": 1,
      "declared": false,
      "services": ["authentik-server", "traefik"],
      "serviceCount": 2
    },
    {
      "tag": "infrastructure/core/networking",
      "depth": 3,
      "declared": true,
      "services": ["traefik"],
      "serviceCount": 1
    }
  ],
  "totalTags": 14,
  "totalServices": 8,
  "untaggedServices": ["autobrr", "bazarr"],
  "unresolvedServices": [],
  "source": "/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/rfapps.config.yaml"
}
```

`declared` distinguishes an authored tag from a derived ancestor. `unresolvedServices` lists
`tags.mapping` keys absent from `compose.yml`, and `source` is the absolute path of the
configuration layer whose `tags:` block won.

`rfapps tag show -s plex --json`:

```json
{
  "schemaVersion": "tags.v1",
  "services": [
    {
      "service": "plex",
      "declaredTags": ["hardware/gpu", "media/streaming"],
      "effectiveTags": ["hardware", "hardware/gpu", "media", "media/streaming"]
    }
  ]
}
```

`rfapps tag suggest --json`:

```json
{
  "schemaVersion": "tags.v1",
  "proposals": [
    {
      "service": "traefik",
      "tags": ["network/ingress", "platform/core"],
      "rules": ["tag-infer-ingress", "tag-infer-profile"],
      "confidence": "high",
      "alreadyPresent": false
    }
  ],
  "unresolved": ["arr-scripts"],
  "skippedRules": [],
  "degraded": false,
  "fragment": "tags:\n  mapping:\n    traefik:\n      - network/ingress\n      - platform/core\n",
  "writtenTo": "/abs/path/tags-fragment.yaml"
}
```

`writtenTo` is present only when `--out` was used. `--output table` renders `tag list` as a
flattened `tag | depth | services | count` view; `--output csv` is refused on both `list` and `show`.

## Exit Codes

| Situation                                                                             | Code                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------- |
| `tag list` / `tag show` / `tag suggest` success (including zero tags, zero proposals) | `0` Success                               |
| Malformed tag pattern (`net*`, `a//b`, depth > 8, trailing `/*`)                      | `2` Usage error (`InvalidArgumentError`)  |
| `--tag` matched no services on a **selector** command                                 | `2` Usage error (`TagSelectorEmptyError`) |
| Malformed `tags.mapping` in configuration                                             | `2` Usage error (`ConfigValidationError`) |
| `--tag` combined with `backup --all`                                                  | `2` Usage error (`InvalidArgumentError`)  |
| `--tag` combined with `update --from-plan`                                            | `2` Usage error (`InvalidArgumentError`)  |
| `--output csv` on `tag list` or `tag show`                                            | `2` Usage error (`InvalidArgumentError`)  |
| `--out` target already exists                                                         | `2` Usage error (`InvalidArgumentError`)  |
| Compose file unreadable                                                               | `1` Operational error                     |

`--out` on an existing path is a **usage** error, not an operational one: the write uses the
non-clobbering `wx` flag and the `EEXIST` branch is reported the same way `rfapps harden --out`
reports it.

There is no new exit-code resolver for tags and no `--fail-on`. Every tag surface is read-only, so
there is nothing to gate on.

## Limitations

- Issue #63's literal `--tag "infrastructure/*"` is **rejected**; write `--tag infrastructure`
  instead. Under ancestor closure, `X/*` would silently exclude services whose only `X` tag sits at
  depth 1, which inverts filesystem-glob intuition, so the trailing-`/*` form fails loudly with the
  replacement named in the message.
- `X` and `X/**` are the same pattern. Both denote the `X` subtree including `X` itself; there is no
  third form.
- `--tag "!media/**"` selects **untagged** services too, and is **not** the complement of
  `--tag "**"`. For "tagged, but not media", write `--tag "**" --tag "!media/**"`.
- A `tags:` block in a higher configuration layer **wholly shadows** the base taxonomy. Merging is
  one level deep, so a one-line personal override in `.rfapps.yaml` discards every fleet tag.
  `rfapps validate` warns when more than one layer defines `tags:`.
- `rfapps status --output json` returns service objects with an unrelated `tag` field that means
  **image tag**. It is not the tag taxonomy and it is not affected by `--tag`.
- `rfapps status --tag` filters on the service-key fallback. Every service in this deployment
  declares a `container_name` identical to its service key, so the two agree; a compose file where
  they diverge would not match. `status` reads no compose file for its container list today, and a
  `docker compose ps` round-trip on the hottest command is not worth preempting a divergence that
  does not exist here.
- `--services ""` is now treated as **absent** rather than as a one-element list containing the
  empty string, so an empty expansion no longer looks like an explicit selector.
- **v1 is read-only.** There is no `rfapps tag set`, `add`, or `remove`, and nothing writes the
  `tags:` section. `rfapps tag suggest` produces a paste-ready fragment instead; a configuration
  writer is tracked as follow-up work.
- There is no day-one taxonomy. Until someone authors a `tags:` section, `--tag` matches nothing and
  therefore throws. Run `rfapps tag suggest` to generate the starting point.

An honest note on what inference buys you: the two configuration-only rules largely re-encode
taxonomy you already have — `profiles.mapping` covers 45 of 45 services and `groups` covers 43 of
45, and you can already select on both. The genuinely new information is the **cross-cutting
facets** that `groups:` structurally cannot express, because group membership is hand-listed and
these services are scattered across groups: `tag-infer-ingress` fires on 26 services carrying
`traefik.enable`, `tag-infer-tailnet` on the 5 with docktail labels, and
`tag-infer-database`/`tag-infer-cache` on 5 datastores spanning 3 different groups. That is the
argument for tagging this fleet; the profile and group rules are a convenience on top of it.

## Related Documentation

- [rfapps CLI Reference](../../packages/rfapps-cli/README.md#tag)
- [rfapps Configuration](rfapps-configuration.md)
- [Output Formats](output-formats.md)
- [JSON Output](json-output.md)
- [Error Handling](error-handling.md)
- [Shell Completion](shell-completion.md)
- [rfapps Harden Command](rfapps-harden-command.md)
