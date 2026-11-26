/**
 * Characters XML 1.0 has no place for: most C0 controls, lone surrogates,
 * U+FFFE and U+FFFF. A document carrying one fails to parse, escaped or not.
 */
const XML_INVALID = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/**
 * Escapes text for XML element content and for single- or double-quoted
 * attribute values, dropping the characters XML cannot carry at all.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll(XML_INVALID, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export { escapeXml };
