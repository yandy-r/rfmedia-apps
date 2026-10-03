const DEFAULT_MAX_MESSAGE_LENGTH = 2048;

/** Redact common credential forms before managed lifecycle text crosses a persistence boundary. */
export function redactManagedMessage(
  message: string,
  maxLength = DEFAULT_MAX_MESSAGE_LENGTH,
): string {
  const redacted = message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(Bearer)\s+[^\s,;&]+/giu, "$1 [REDACTED]")
    .replace(
      /\b([a-z0-9_]*(?:password|passwd|token|secret|api_?key|authorization|credential)[a-z0-9_]*)\s*(?::|=)\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(password|passwd|token|secret|api[\s_-]?key|authorization|credential)\b\s*(?::|=|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .trim();
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}
