# UX Research: Tag Preservation During Conversion

## Executive Summary

Tag preservation should feel like a correctness repair, not a new feature mode. A user who already
runs `rfmedia copy`, `rfmedia sync`, a Plex copy/export workflow, or verification repair with
`--convert` should receive better output files without learning a new option, answering a prompt,
or changing configuration. Successful, fully representable conversions need no additional
per-file chatter.

The only new visible state is a genuine destination-format limitation. That state must be:

- non-fatal and explicit when the audio remains usable;
- distinguishable from a supported mapping or validation failure, which remains fatal;
- rendered after progress output rather than interleaved with it;
- grouped into one safe, actionable warning per source conversion and reason;
- represented structurally in JSON and other machine output; and
- documented before execution through a concise destination compatibility matrix.

The current logger creates an important UX constraint: `logWarn()` goes to stderr in human modes
but is intentionally suppressed for JSON, YAML, and CSV. Logging alone would therefore make
metadata loss invisible to automation. Conversion warnings should be collected as typed data,
propagated through the existing result envelopes, and rendered in one of two ways:

- text/table mode: static `[WARN]` lines on stderr after the progress renderer stops;
- machine mode: a `warnings` array inside the single stdout payload, with no human log or progress
  output.

This is an additive result-schema change, not a new CLI surface. No flag, prompt, configuration key,
command, or shell-completion change is warranted.

## User Workflows

### Primary Flow: Fully Representable Conversion

1. The user runs an existing command, for example:

   ```bash
   rfmedia copy "/music/Artist" /portable --range=001-003 --convert=mp3
   ```

2. The existing scan and file progress UI behaves as it does today.
3. Each file counts as complete only after audio conversion, metadata writing, artwork handling,
   rating translation, and destination audit finish.
4. The normal copy summary appears.
5. No metadata success messages are printed. Preservation is the default expectation, so repeating
   “tags preserved” for every file would be noise.

Decision: metadata preservation is always on for actual conversion. There is no opt-in,
confirmation, or success toast.

### Alternative Flow: Destination Limitation

Example: a rated FLAC with a custom `CATALOGNUMBER` tag is converted to AAC/M4A.

1. The supported audio, canonical tags, and primary artwork are finalized.
2. The file-level progress count advances only after the destination audit.
3. The progress renderer stops.
4. One warning identifies the conversion, omitted fields, target, reason, and usable outcome:

   ```text
   [WARN] Metadata preserved with limitations for "/music/Artist/Track.flac" -> "/portable/Artist/Track.m4a" (aac/m4a): omitted rating, custom:CATALOGNUMBER; no tested portable destination representation. Audio output remains usable.
   ```

5. The operation continues and exits zero if no actual files failed.
6. The final summary includes the warning count:

   ```text
   [WARN] Metadata limitations: 1 converted file completed with warnings.
   ```

Do not print one line per lost field. Aggregate fields with the same reason for one source
conversion, sort their safe names, and emit one readable line. If a range operation reuses the
first finalized conversion, emit the warning once for that conversion rather than once per derived
copy; an optional `reused by N copies` suffix can explain the scope without duplicating output.

### Alternative Flow: JSON Automation

The existing invocation remains unchanged:

```bash
rfmedia --output json copy "/music/Artist" /portable --range=001-003 --convert=aac
```

Stdout must remain one parseable document. The existing envelope's `result` object should contain:

```json
{
  "created": 3,
  "skipped": 0,
  "failed": [],
  "warnings": [
    {
      "code": "conversion-metadata-limited",
      "sourcePath": "/music/Artist/Track.flac",
      "destinationPath": "/portable/Artist/Track.m4a",
      "targetFormat": "aac",
      "fields": ["custom:CATALOGNUMBER", "rating"],
      "reason": "unsupported-target-representation",
      "outputUsable": true
    }
  ]
}
```

Recommendations:

- Always include `warnings`, including `[]`, once the schema is introduced.
- Use stable codes and reason enums; scripts should not parse prose.
- Keep raw tag values, artwork bytes, and untrusted metadata out of both structured and human
  output.
- Keep stdout free of warning lines before or after the JSON document.
- Preserve exit code zero for warning-only success and non-zero for failed operations.
- Mirror the structured warning data into YAML and MCP `structuredContent`. CSV needs a deliberate
  flattened projection, but must not silently discard warnings because its human logger is also
  suppressed.

### Alternative Flow: Supported Preservation Fails

If a field the target is required to support disappears during audit, the user should not see the
non-fatal wording above. The conversion fails through the existing typed error path:

```text
Error: Audio conversion failed for /music/Artist/Track.flac: destination metadata validation failed for primary artwork

Suggestions:
  • Check that the source file is a valid audio file
  • Verify ffmpeg is properly installed and up to date
  • Check available disk space at the destination
  • Target path: /portable/Artist/Track.mp3
  • Run with --debug for more details
```

The partial artifact is removed, the file is added to the existing failed-operation collection,
and the command exits non-zero when any file fails. Do not downgrade an implementation defect to a
format warning.

### Alternative Flow: Cancellation

Ctrl+C and SIGTERM retain the existing experience:

1. Stop accepting new work.
2. Stop the progress renderer and show the existing
   `Operation cancelled - cleaning up...` status once.
3. Abort metadata reading, FFmpeg, tag finalization, or audit with the same signal.
4. Remove partial/staged output and keep any pre-existing destination.
5. Do not emit a preservation warning for an incomplete conversion.
6. Let completed work remain resumable under the existing tracking behavior.

No new cancellation prompt or metadata-specific recovery command is needed.

### Alternative Flow: Dry Run

Dry run remains non-mutating and should not claim that source-specific losses were observed unless
it actually parsed those tags. The preview may show one target-level note:

```text
[INFO] Metadata: compatible tags and primary artwork will be preserved; AAC/M4A ratings and custom tags may not have a portable representation.
```

This note is useful but secondary to the published compatibility matrix. Do not add a full
cover-aware parse to every dry run solely to predict warnings; that would make preview materially
slower and blur the boundary between planned and observed outcomes.

## UI/UX Best Practices

### Follow Existing Output Boundaries

The repository already separates data and diagnostics:

- structured command output goes to stdout;
- human logs and summaries go to stderr;
- progress uses stderr;
- progress is suppressed in JSON mode and when auto-detection finds no TTY; and
- `--no-progress` is already available for users who need static output.

This matches the [Command Line Interface Guidelines](https://clig.dev/), which recommend stdout
for primary/machine-readable output, stderr for diagnostics, JSON for structured results, and
progress only for long-running work. The same guide warns that parallel progress and messages must
not become confusingly interleaved.

Do not bypass the logger with `console.error()` from the conversion library. Return warnings as
data, then let the action/command boundary choose the correct renderer.

### Warning Presentation

Use the existing literal `[WARN]` prefix and plain language. Yellow may remain as enhancement, but
severity cannot depend on color. The W3C's
[Use of Color guidance](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html) recommends
providing a textual or structural cue in addition to color.

Each human warning should answer five questions in this order:

1. What happened? `Metadata preserved with limitations`.
2. Which conversion? Source path and destination path.
3. Which target? User-facing format and container, such as `aac/m4a`.
4. What was omitted and why? Safe field/category names and a stable reason rendered in plain
   language.
5. Can work continue? `Audio output remains usable`.

Avoid:

- raw values such as titles, comments, identifiers, or rating payloads;
- artwork sizes or bytes;
- FFmpeg muxer jargon such as `mdta`, `APIC`, or `METADATA_BLOCK_PICTURE` in normal mode;
- generic wording such as `Some tags could not be copied`;
- one warning per field; and
- warning lines while an animated progress bar owns stderr.

FFmpeg/tag implementation details belong in `--debug` output and documentation.

### Aggregation and Ordering

Use a typed warning shaped approximately as:

```ts
interface ConversionWarning {
  code: "conversion-metadata-limited";
  sourcePath: string;
  destinationPath: string;
  targetFormat: ConvertFormat;
  fields: readonly string[];
  reason: "unsupported-target-representation" | "malformed-source-value";
  outputUsable: true;
}
```

Rules:

- aggregate fields by source conversion and reason;
- preserve different reasons as separate warning items;
- de-duplicate repeated warnings caused by first-copy reuse;
- sort fields, then warnings by destination path for deterministic output;
- collect warnings during parallel work and render them after the progress bar stops; and
- retain all structured warning items in machine output.

Do not cap and silently summarize away paths in the first implementation. One line per affected
source conversion is the issue's evidence that loss was not silent. If real usage proves too noisy,
a later UX change can add a documented summary strategy without weakening the structured result.

### Terminal Readability and Accessibility

- Keep warnings line-oriented and let terminals wrap naturally. Do not use a wide runtime table for
  long paths or field lists.
- Quote paths so spaces and arrows remain unambiguous. Sanitize control characters before rendering
  any path or native tag name.
- Retain `[WARN]`, `Error:`, and `Suggestions:` text so monochrome terminals and screen readers do
  not depend on yellow/red/green.
- Use ASCII words for semantic status rather than adding emoji-only indicators.
- Respect TTY detection and the existing `--no-progress` route for screen readers, CI logs, and
  redirected sessions.
- Ensure ANSI styling disappears when color is disabled. The
  [`NO_COLOR` convention](https://no-color.org/) specifies that a non-empty `NO_COLOR` environment
  variable should suppress color.
- Keep the final warning block static. Animated progress is useful during work, but static lines are
  easier to review, copy, search, and consume with assistive technology.

There is no graphical or responsive layout. “Responsive” for this CLI means readable wrapping at
narrow terminal widths, no animation in non-TTY output, and no loss of meaning without color.

### Destination-Limitation Discoverability

Use three levels of disclosure:

1. **Command help:** update the existing `--convert` description to say compatible metadata is
   preserved automatically. Do not embed a large matrix in help.
2. **Runtime:** warn only when the actual source contains a field that cannot be represented.
3. **Documentation:** publish the tested matrix in the package README and detailed audio-conversion
   guide.

Recommended user-facing matrix:

| Target   | Canonical text | Rating                       | Primary embedded artwork                                    | Compatible custom text                     |
| -------- | -------------- | ---------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| MP3      | Preserved      | Preserved as POPM            | Preserved                                                   | Preserved when safely representable        |
| AAC/M4A  | Preserved      | Warned limitation            | Preserved                                                   | Warned when no tested portable atom exists |
| ALAC/M4A | Preserved      | Warned limitation            | Preserved                                                   | Warned when no tested portable atom exists |
| Opus     | Preserved      | Preserved as Vorbis `RATING` | Preserved using the standard picture-comment representation | Preserved as compatible Vorbis comments    |

The detailed guide should also state:

- semantic preservation does not mean byte-identical native frames;
- embedded artwork is different from a copied `cover.jpg` sidecar;
- primary artwork is guaranteed, while additional pictures are preserve-or-warn;
- source tags are never modified;
- Plex rating sync, when enabled and positive, is the later rating authority; and
- warnings mean usable output with known metadata loss, while fatal errors mean the conversion was
  not accepted.

Do not document the current inability of the installed Opus writer to create picture comments as a
target-format limitation. The format supports primary artwork, and the finalized business contract
requires its implementation.

## Error Handling

### Error-State Matrix

| State                                                               | Human output                                                  | Machine result                        | Exit/result                   | Recovery                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------ |
| Source has no metadata                                              | No metadata message                                           | `warnings: []`                        | Success / zero                | None                                       |
| All required metadata preserved                                     | No per-file success message                                   | `warnings: []`                        | Success / zero                | None                                       |
| Target cannot represent source field                                | One aggregated post-progress warning                          | Typed warning item                    | Success / zero                | Inspect output or choose another target    |
| One source value is malformed but snapshot remains trustworthy      | Warning names safe field/category, never value                | `reason: "malformed-source-value"`    | Success / zero                | Retag source if desired                    |
| Source metadata cannot be parsed reliably                           | Existing formatted conversion error                           | Failed operation/error envelope       | Failure / non-zero            | Inspect source; retry with `--debug`       |
| Supported field or primary artwork fails destination audit          | Existing formatted conversion error                           | Failed operation/error envelope       | Failure / non-zero            | Inspect FFmpeg/build; retry with `--debug` |
| FFmpeg missing, codec unavailable, permission denied, invalid media | Existing specialized formatter and suggestions                | Existing failure contract             | Failure / non-zero            | Follow suggestions                         |
| Plex rating override fails after preservation                       | Existing best-effort warning; source-preserved rating remains | Structured diagnostic where supported | Conversion remains successful | Retry Plex sync separately                 |
| Cancellation                                                        | One cleanup status; no metadata warning for incomplete file   | No successful result for aborted work | Exact abort semantics         | Re-run to resume                           |

### Validation Feedback

Validation messages should name the semantic field users understand:

- good: `destination metadata validation failed for primary artwork`;
- good: `destination metadata validation failed for track number`;
- avoid: `covr atom missing`;
- avoid: `native tag mismatch at index 4`.

The error formatter can retain technical detail for `--debug`. Normal suggestions should continue
to name the destination path, FFmpeg availability, disk space, and source validity. Do not suggest
an unsupported retry flag or tell users that a fatal supported-mapping failure is safe to ignore.

### Warning Versus Failure Language

Use “omitted” only for a deliberate target limitation. Use “failed” for an implementation or
validation error. Never combine the two in one message:

- limitation: `omitted rating; no tested portable destination representation`;
- failure: `failed to preserve primary artwork; destination validation did not find a readable
cover`.

This vocabulary makes the exit-code distinction understandable without requiring users to know the
business rules.

## Performance UX

### Progress and Completion

The current file progress bar is the correct level of detail. Callers update it after
`convertFile()` returns, so the file count naturally includes metadata finalization and audit.
Preserve that ordering.

Do not:

- advance a file at FFmpeg exit before tag writes/audit complete;
- display 100% followed by a long invisible metadata phase;
- add a second nested metadata progress bar; or
- stream parallel conversion warnings through the active bar.

If cover-aware parsing or destination audit becomes noticeably slow, add debug-only phase timings
first. A new public spinner is justified only by measured pauses, not preemptively.

### Parallel Work

Parallel workers may discover warnings in any order. Buffering and deterministic post-progress
sorting prevents output from looking random between runs. It also keeps warning blocks copyable for
support reports.

The warning collection should be bounded by the number of converted files, not by raw tag count:
aggregate field names per conversion and never retain values or artwork data in diagnostic objects.

### Optimistic Updates

There should be no optimistic success. Conversion success is atomic to callers, and the UI must
reflect that:

- no success summary before destination audit;
- no history/hash/reuse before final tagged bytes;
- no warning for a file that later fails; and
- no progress completion for a file that is subsequently rolled back.

### Offline Behavior

The workflow is entirely local after FFmpeg and npm dependencies are installed. There is no network
loading, retry, or degraded-offline UI. Documentation and `--help` should be sufficient to
understand the preservation contract without contacting a service.

## Competitive Analysis

### FFmpeg

[FFmpeg](https://ffmpeg.org/ffmpeg.html) copies some metadata by default, but muxer capability and
automatic stream selection determine what actually survives. That default is convenient but too
opaque for issue #42. rfmedia should retain the convenience while adding a semantic destination
audit and user-level limitation warnings.

Adopt:

- transparent behavior without a separate metadata flag;
- stderr as the process diagnostic channel.

Improve:

- translate muxer details into field-level user language;
- do not rely on raw FFmpeg warnings to determine preservation success.

### ExifTool

[ExifTool's validation documentation](https://exiftool.org/faq.html#Q25) distinguishes errors from
warnings and can expose multiple metadata warnings with `-validate -warning -error -a`. Its FAQ
also notes that unsupported cross-format tags are normally not warned about. That silence is
precisely the negative pattern issue #42 rejects.

Adopt:

- warnings and errors as distinct outcomes;
- field/category-specific diagnostics.

Improve:

- automatically warn for actual unsupported destination fields because the issue explicitly
  requires it;
- aggregate related losses so users do not need a special validation invocation.

### rclone

[rclone's output documentation](https://rclone.org/docs/#use-json-log) offers TTY progress and
structured JSON logging. It also documents fixed-width progress considerations and keeps log
records machine-readable when JSON logging is requested.

Adopt:

- progress only in interactive terminal contexts;
- structured warning properties for automation;
- stable, compact output suited to narrow terminals.

Keep rfmedia-specific:

- one command result document on stdout, rather than introducing a second JSONL log stream;
- existing `--output json` and `--no-progress` options instead of new logging flags.

### CLI and Accessibility Standards

The [Command Line Interface Guidelines](https://clig.dev/) support the existing stdout/stderr,
TTY-progress, concise-success, and JSON decisions. W3C color guidance is web-oriented but its core
principle applies cleanly to terminal output: meaning must remain available in text rather than
color alone.

## Recommendations

### Must Have

1. Preserve metadata automatically behind every existing conversion path; add no opt-in or prompt.
2. Return sorted typed warnings from the shared conversion boundary instead of logging directly
   during parallel work.
3. Render one safe, aggregated warning per source conversion and reason after progress stops.
4. Include warnings in existing copy, sync, Plex/MCP, and repair result envelopes so JSON mode does
   not silently lose them.
5. Preserve a single parseable stdout document in JSON mode and suppress human logs/progress.
6. Keep warning-only operations successful with exit code zero; keep supported mapping/audit
   failures fatal and actionable.
7. Advance progress only after metadata finalization and audit; honor cancellation through every
   added phase.
8. Publish the tested destination matrix in the package README and detailed conversion guide.
9. Guarantee primary Opus artwork through its standard representation; do not present an
   implementation gap as a format limitation.
10. Use textual severity and outcome language, sanitized paths/tag names, and no raw values.

### Should Have

1. Add an operation-level warning count to existing human summaries.
2. Show one static target-capability note in conversion dry-run previews without performing an
   expensive source-tag audit.
3. Update the existing `--convert` help description to mention automatic compatible-metadata
   preservation and point detailed limitations to documentation.
4. De-duplicate warnings for first-copy artifacts reused by ranges and optionally state the reuse
   count.
5. Mirror the structured warning array in YAML and MCP output, and define a non-lossy flattened CSV
   representation.
6. Add regression tests that parse JSON stdout, assert warnings are present, and assert no
   human-readable warning corrupts stdout.

### Nice to Have

1. Include debug-only timings for source metadata read, post-write, and destination audit if users
   report apparent stalls.
2. Add a documentation example showing how automation can fail itself on non-empty warnings with
   `jq`, without changing rfmedia's warning-only exit status.
3. Track warning categories in support diagnostics without collecting tag values.

### Explicitly Do Not Add

- `--preserve-tags` or `--no-preserve-tags`;
- `--strict-tags`, `--ignore-tag-warnings`, or a confirmation prompt;
- metadata-warning configuration;
- a second progress bar or a JSONL logging mode;
- new conversion formats; or
- Bash, Zsh, or Fish completion changes.

## Open Questions

1. When a first conversion is reused for many ranged copies, is the first destination plus a reuse
   count sufficient, or should machine output enumerate every derived destination? This research
   recommends one warning item with an optional reuse count to avoid duplicate noise.
2. Should additional artwork beyond the primary cover be guaranteed for targets that support
   multiple pictures, or remain preserve-or-warn? Current issue language supports primary artwork
   as the guarantee and additional pictures as preserve-or-warn.
3. Which existing action-level result is the canonical warning aggregation owner for verification
   repair, whose current output model differs from copy and sync? The UX contract is the same:
   warnings must reach both human and machine output without becoming failed repairs.
