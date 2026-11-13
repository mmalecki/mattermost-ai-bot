import type { ImageContent } from '@earendil-works/pi-ai';
import type { ImageStore } from '../src/images.ts';

export const PNG = { type: 'image' as const, data: 'cG5n', mimeType: 'image/png' };

/**
 * A store that holds `stored` images, under `/images/`, and keeps those saved to it under `<name>-<n>`.
 * Like the real one, it refuses names it has no image under.
 */
export function fakeStore(stored: Record<string, ImageContent> = {}) {
  const saved: { name: string; image: ImageContent }[] = [];
  const attached: string[] = [];
  const store: ImageStore = {
    async save(name, image) {
      saved.push({ name: `${name}-${saved.length + 1}`, image });
      return saved.at(-1)!.name;
    },
    async get(names) {
      return names.map((name) => {
        if (!stored[name]) throw new Error(`no ${name}`);
        return stored[name];
      });
    },
    async path(name) {
      if (!stored[name]) throw new Error(`no ${name}`);
      return `/images/${name}`;
    },
    attach: (name) => attached.push(name),
  };
  return { store, saved, attached };
}
