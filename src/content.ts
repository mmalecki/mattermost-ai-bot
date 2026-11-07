import type { TextContent } from '@earendil-works/pi-ai';

/** The text parts of a message's or a tool result's content, joined with `separator`. */
export function textOf(content: readonly { type: string }[], separator = ''): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join(separator);
}
