/**
 * Markdown text extractor for the RAG ingestion pipeline.
 *
 * Converts a buffer to UTF-8 string and strips YAML frontmatter.
 * Returns the raw markdown text body ready for chunking.
 */

/**
 * Extracts plain text from a markdown buffer.
 * Strips YAML frontmatter (---…---) if present.
 */
export function extractMarkdownText(buffer: Buffer): string {
  const raw = buffer.toString("utf8");

  // Strip YAML frontmatter block if it starts the file
  if (raw.trimStart().startsWith("---")) {
    // Find the closing "---" delimiter (must be on its own line after the first)
    const afterOpen = raw.indexOf("---") + 3; // skip opening ---
    const closeIdx = raw.indexOf("\n---", afterOpen);
    if (closeIdx !== -1) {
      // Return everything after the closing --- (skip the newline after it)
      return raw.slice(closeIdx + 4).replace(/^\n/, "").trim();
    }
  }

  return raw.trim();
}
