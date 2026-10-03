const COMBINING_MARK_PATTERN = /\p{M}/gu;
const PUNCTUATION_OR_SYMBOL_PATTERN = /[\p{P}\p{S}]+/gu;

/** Applies the versioned bridge artist-name normalization policy. */
export function normalizeBridgeArtistName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARK_PATTERN, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(PUNCTUATION_OR_SYMBOL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
