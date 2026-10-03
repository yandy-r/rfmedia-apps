# Lessons

- Handle missing files explicitly (e.g., ENOENT) to preserve correct not-found errors instead of generic validation failures.
- Avoid Commander `.choices()` when custom typed errors and formatter suggestions are required; prefer explicit parsers that throw project error classes.
- For reusable numeric parsers, pass the concrete option flag (e.g., `--workers`) so `InvalidNumericArgumentError` messages are actionable.
- Keep `LookupNotFoundError.context` for situational metadata only; place prescriptive remediation steps in explicit suggestion fields.
- Reusable numeric parsers in commands must be wired through per-flag closures so `InvalidNumericArgumentError.argument` names the exact option.
- Avoid naive pluralization in formatter copy; prefer neutral labels like `Available values for <lookupType>` when lookup types are multi-word.
- When enriching caught typed errors with UI/debug context, preserve original failure context using `cause` to keep stack trace provenance.
- For MCP adapters, do not default confirmation flags (`yes`) to true and avoid global output monkeypatching; use scoped capture helpers plus serialized critical sections when process-level state (`process.exitCode`) must be touched.
- When validating MCP transport behavior, explicitly separate stdout vs stderr before concluding protocol contamination; treat stderr noise as UX cleanup, stdout noise as transport breakage.
- For CLI boolean config overrides, preserve tri-state semantics (`undefined` = use config; `true/false` = explicit override) and avoid one-way checks like `value === false ? false : config`.
- For shell completion bugs, verify the data source command both standalone and from completion context before assuming config/secrets loading is the root cause.
- For completion parser refactors, preserve behavior by validating nested subcommand contexts (`command subcommand action`) separately from top-level dispatch before merging.
- When introducing new CLI flags or aliases, update bash/zsh/fish completion templates and their template tests in the same change to keep help/UX parity.
- When asked to follow an existing issue pattern, keep structural format but choose labels/type from actual work category (bug vs enhancement), not by copying prior label sets.
- When adding a service, never claim the requested service already exists merely because grep found a related service or docs mention it; prove an exact `compose.yml` service block before saying it exists.
