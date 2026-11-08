/** A failure the user can act on. The dispatcher prints `ark: <message>` and exits 1. */
export class ArkError extends Error {}

/** Appended to every YAML parse error: the usual cause is an unquoted scalar. */
export const yamlQuoteHint = "a value that contains ': ' or starts with a backtick needs quotes";
