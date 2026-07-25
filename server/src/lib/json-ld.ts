// Serialises a JSON-LD object for injection into a <script> element.
//
// JSON.stringify alone isn't safe here: the payload carries user-controlled
// text (video titles, tag names, descriptions), and a value containing
// "</script>" would close the element early — turning the rest of the JSON
// into markup. Escaping every "<" to the six-character sequence backslash-u-0-0-3-c
// keeps the data identical after parsing (still valid JSON, JSON.parse yields
// the same string) while making "</script", "<script" and "<!--" inert.
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
