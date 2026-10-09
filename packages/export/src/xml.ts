/** Text safe inside XML: markup characters escaped, characters XML can't hold dropped. */
export function xml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A date as ISO 8601 to the second (what DOCX and EPUB metadata want). */
export const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
