// Splitting a long markdown message into parts that each fit in a post.

/**
 * Splits at paragraph, then line, then hard boundaries, keeping each part under `max`. A code block
 * split across parts is closed at the end of one and reopened at the start of the next.
 */
export function splitMessage(message: string, max: number): string[] {
  const parts: string[] = [];
  let rest = message;
  while (rest.length > max) {
    let { part, next } = cut(rest, max);
    let fence = openFence(part);
    if (fence) {
      // Again, leaving room to close it.
      const room = Math.max(1, max - fence.marker.length - 1);
      ({ part, next } = cut(rest, room));
      fence = openFence(part);
      const opener = fence?.line.trimEnd();
      if (fence && part === opener) {
        // Only the opening line fits before a line of code too long for a part, so that line is cut.
        ({ part, next } = cut(rest, room, true));
      } else if (fence && opener !== undefined && part.endsWith(`\n${opener}`)) {
        // The block would open empty at the end of this part, so it starts the next one instead.
        part = part.slice(0, -opener.length).trimEnd();
        next = `${fence.line}\n${next}`;
        fence = undefined;
      }
    }
    // Carried over only when that still shortens what's left, so the loop ends.
    if (fence && part.length + fence.marker.length + 1 <= max && part.length > fence.line.length + 1) {
      part = `${part}\n${fence.marker}`;
      next = `${fence.line}\n${next}`;
    }
    if (part) parts.push(part);
    rest = next;
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Cuts within `limit` at the last paragraph or line break, or else, or when `hard`, anywhere outside a
 * surrogate pair.
 */
function cut(text: string, limit: number, hard = false): { part: string; next: string } {
  // One past the limit: a break right after it still fits, as the break itself goes.
  const window = text.slice(0, limit + 1);
  let at = hard ? -1 : window.lastIndexOf('\n\n');
  if (at <= 0 && !hard) at = window.lastIndexOf('\n');
  // Only the break goes, so the next line keeps its indentation.
  if (at > 0) return { part: text.slice(0, at).trimEnd(), next: text.slice(at).replace(/^\n+/, '') };
  at = limit;
  const code = text.charCodeAt(at - 1);
  if (at > 1 && code >= 0xd800 && code <= 0xdbff) at--;
  return { part: text.slice(0, at), next: text.slice(at) };
}

/** The code block still open at the end of `text`: its opening line, and the fence that closes it. */
function openFence(text: string): { line: string; marker: string } | undefined {
  let open: { line: string; marker: string } | undefined;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!open) open = { line, marker };
    else if (line.trim() === marker && marker[0] === open.marker[0] && marker.length >= open.marker.length) open = undefined;
  }
  return open;
}
