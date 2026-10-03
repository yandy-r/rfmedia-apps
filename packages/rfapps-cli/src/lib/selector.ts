/**
 * The single definition of "the caller named an explicit service target" (design §4.2).
 *
 * Before this module the same predicate was open-coded at six sites — the resolver, the
 * interactive-mode check, the deploy `--staged` preflight, `reconcile`'s empty-selection
 * guard, and two `selectorFlags` array literals in `backup`. Every copy had to be found
 * and edited whenever a targeting axis was added, and a missed copy does not fail loudly:
 * it silently widens the target set to the whole project on mutating commands.
 *
 * Every axis is therefore declared exactly once, in {@link SELECTOR_AXES}, and
 * {@link hasExplicitSelector}, {@link explicitSelectorFlagNames} and
 * {@link describeSelector} are all derived from that one table. **Adding a selector axis
 * means appending one entry there and nothing else** — the three public predicates cannot
 * drift apart because there is nothing to keep in sync.
 *
 * @module rfapps-cli/lib/selector
 */

import type { TagIndex, TagPath, TagTerm } from "../types/tags.js";
import { parseTagTerm, serviceMatches } from "./tags/tag-pattern.js";

/**
 * The flags that constitute an explicit target.
 *
 * `services` accepts **both** shapes on purpose. Commander declares `--services <names>`
 * with no `argParser`, so a raw `actionCommand.opts()` read yields a comma-joined
 * **string**, while typed option objects carry `string[]`. Two of the six call sites read
 * raw Commander opts (`cli.ts`'s deploy `--staged` preflight and
 * `commands/backup.ts`), so a `string[]`-only signature would either not typecheck or
 * silently coerce a string to a one-element array.
 */
export interface SelectorFlags {
  /** Single service target (`-s`, `--service`). */
  readonly service?: string;
  /** Multiple service targets (`--services`), comma-joined or already split. */
  readonly services?: string | readonly string[];
  /** Service group target (`-g`, `--group`). */
  readonly group?: string;
  /** Tag patterns (`--tag`), one entry per flag occurrence. */
  readonly tag?: readonly string[];
}

/** A service carrying no tags matches nothing at all — including `**`. */
const NO_TAGS: ReadonlySet<TagPath> = new Set<TagPath>();

/** Splits the dual-shape `services` value into the service names it actually denotes. */
function serviceNames(services: string | readonly string[] | undefined): string[] {
  if (services === undefined) {
    return [];
  }

  const parts = typeof services === "string" ? services.split(",") : services;

  return parts.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Whether `--tag` was given at all.
 *
 * Shared by {@link hasExplicitSelector} and {@link applyTagAxis} so the "is the tag axis
 * present" question has exactly one answer. If they could disagree, `--tag` would either
 * suppress interactive selection without narrowing anything, or narrow without being
 * recognised as a target — both wrong-scope bugs.
 *
 * An entry that is present but malformed (`--tag ""`) counts as **present** on purpose:
 * `applyTagAxis` then rejects it with `InvalidArgumentError` instead of the flag being
 * silently ignored.
 */
function hasTagSelector(tag: readonly string[] | undefined): tag is readonly string[] {
  return tag !== undefined && tag.length > 0;
}

/** One targeting axis: its flag name, its presence test, and how it renders. */
interface SelectorAxis {
  readonly flag: string;
  readonly isPresent: (flags: SelectorFlags) => boolean;
  /** Zero or more rendered fragments; `--tag` renders one per occurrence. */
  readonly describe: (flags: SelectorFlags) => readonly string[];
}

/**
 * THE axis table. Order here is the order flag names and descriptions are reported in.
 *
 * Issue #62 adds its axis by appending one entry.
 */
const SELECTOR_AXES: readonly SelectorAxis[] = [
  {
    flag: "--service",
    isPresent: (flags) => flags.service !== undefined,
    describe: (flags) => (flags.service === undefined ? [] : [`--service ${flags.service}`]),
  },
  {
    flag: "--services",
    isPresent: (flags) => hasServicesSelector(flags.services),
    describe: (flags) => {
      const names = serviceNames(flags.services);

      return names.length === 0 ? [] : [`--services ${names.join(",")}`];
    },
  },
  {
    flag: "--group",
    isPresent: (flags) => flags.group !== undefined,
    describe: (flags) => (flags.group === undefined ? [] : [`--group ${flags.group}`]),
  },
  {
    flag: "--tag",
    isPresent: (flags) => hasTagSelector(flags.tag),
    describe: (flags) => (flags.tag ?? []).map((pattern) => `--tag "${pattern}"`),
  },
];

/**
 * Normalizes the dual-shape `services` field into a yes/no answer.
 *
 * **Empty string and empty array both mean ABSENT.** This is a deliberate, documented
 * behavior change: `cli.ts` previously treated `--services ""` as a target
 * (`!== undefined`), but `""` splits to zero service names, so counting it as a target is
 * a latent bug — today it suppresses the deploy `--staged` preflight for a selector that
 * resolves to nothing.
 *
 * @param services - The raw `--services` value in either shape
 * @returns true when the value names at least one service
 *
 * @example
 * hasServicesSelector("plex,traefik") // true
 * hasServicesSelector(["plex"])       // true
 * hasServicesSelector("")             // false
 * hasServicesSelector([])             // false
 */
export function hasServicesSelector(services: string | readonly string[] | undefined): boolean {
  return serviceNames(services).length > 0;
}

/**
 * THE predicate: did the caller name an explicit target?
 *
 * A `false` answer is what lets the resolver fall through to interactive selection or to
 * the "all services" sentinel, so every axis must be represented — see
 * {@link SELECTOR_AXES}.
 *
 * @param flags - The selector flags, in either raw-Commander or typed-option shape
 * @returns true when at least one targeting axis is present
 */
export function hasExplicitSelector(flags: SelectorFlags): boolean {
  return SELECTOR_AXES.some((axis) => axis.isPresent(flags));
}

/**
 * The flag names of every present axis, for `--all` conflict checks and error messages.
 *
 * @param flags - The selector flags
 * @returns e.g. `["--group", "--tag"]`, in axis-declaration order
 */
export function explicitSelectorFlagNames(flags: SelectorFlags): string[] {
  return SELECTOR_AXES.filter((axis) => axis.isPresent(flags)).map((axis) => axis.flag);
}

/**
 * A human-readable rendering of the selector, for `InvalidArgumentError` reasons.
 *
 * Tag patterns are quoted because they contain glob characters a shell would expand.
 *
 * @param flags - The selector flags
 * @returns e.g. `--group arr-stack, --tag "media/**"`, or `""` when nothing is targeted
 */
export function describeSelector(flags: SelectorFlags): string {
  return SELECTOR_AXES.flatMap((axis) => axis.describe(flags)).join(", ");
}

/**
 * The result of evaluating the `--tag` axis.
 *
 * `kind: "absent"` is the **structural** guarantee of backward compatibility (P1):
 * callers MUST short-circuit to the legacy path on it, so pre-#63 resolution is
 * unreachable rather than merely equivalent.
 */
export type TagAxis =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly terms: readonly TagTerm[];
      readonly matched: ReadonlySet<string>;
    };

/**
 * Whether one `--tag` occurrence selects a service: `T_k = INC_k \ EXC_k` (design §3.8).
 *
 * A term with no positive patterns has `INC_k = universe`, which is why
 * `--tag "!media/**"` also selects **untagged** services: an empty effective set makes
 * every positive pattern false, but it equally makes every negation vacuously
 * non-excluding. `--tag "!media/**"` is therefore *not* the complement of `--tag "**"`.
 * To express "tagged, but not media", write `--tag "**" --tag "!media/**"`.
 */
function termSelects(term: TagTerm, effective: ReadonlySet<TagPath>): boolean {
  const included =
    term.include.length === 0 || term.include.some((pattern) => serviceMatches(pattern, effective));

  if (!included) {
    return false;
  }

  return !term.exclude.some((pattern) => serviceMatches(pattern, effective));
}

/**
 * Computes the tag axis over the compose service universe (design §3.8, §7.1).
 *
 * Patterns within one `--tag` flag are **OR**ed; separate `--tag` flags are **AND**ed,
 * which is expressed here as successive filtering of `universe`. That also preserves
 * `universe` order in `matched` (P5), so downstream output stays stable and diffable.
 *
 * This function **throws `InvalidArgumentError` on a malformed pattern but never throws
 * on an empty result.** The empty-versus-error decision belongs to the caller: query
 * surfaces (`tag list`) tolerate an empty match, while selector commands must raise their
 * dedicated empty-selection error rather than fall through to the `[]` "whole project"
 * sentinel (P2). Keeping that decision out of here is what lets both callers share one
 * matcher, and it is why this module has no dependency on the error class at all.
 *
 * @param tagFlags - One entry per `--tag` occurrence; `undefined` or `[]` means absent
 * @param index - The tag index; only its ancestor-closed `effective` map is read
 * @param universe - Compose service names, in declaration order
 * @returns `{ kind: "absent" }` when no `--tag` was given, otherwise the matched set
 * @throws InvalidArgumentError when any pattern is malformed
 *
 * @example
 * applyTagAxis(["media/**,hardware/**"], index, universe) // OR within one flag
 * applyTagAxis(["media/**", "!plex"], index, universe)    // AND across flags
 */
export function applyTagAxis(
  tagFlags: readonly string[] | undefined,
  index: TagIndex,
  universe: readonly string[],
): TagAxis {
  if (!hasTagSelector(tagFlags)) {
    return { kind: "absent" };
  }

  const terms = tagFlags.map((flag) => parseTagTerm(flag));

  let selected: readonly string[] = universe;

  for (const term of terms) {
    selected = selected.filter((service) =>
      termSelects(term, index.effective.get(service) ?? NO_TAGS),
    );
  }

  return { kind: "present", terms, matched: new Set(selected) };
}
