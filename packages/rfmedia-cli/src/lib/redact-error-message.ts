const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu;

/**
 * Converts an arbitrary failure to a terminal-safe message while removing
 * explicitly supplied credentials and common URL-embedded secrets.
 */
export function redactErrorMessage(
  error: unknown,
  sensitiveValues: readonly unknown[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0) {
      message = message.replaceAll(value, "[REDACTED]");
    }
  }
  return message
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(TERMINAL_CONTROL_PATTERN, "\uFFFD");
}
