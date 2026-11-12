import type { ExtensionFactory, McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { ImageArguments, ImageForm } from './config.ts';
import { errorMessage } from './error.ts';
import type { ImageFiles } from './images.ts';

/**
 * Registers the configured MCP servers with pi's MCP extension, which validates each config and
 * resolves `${VAR}` references in it when connecting. An invalid server is reported and skipped.
 */
export function mcpServers(servers: Record<string, McpServerConfig>): ExtensionFactory {
  return (pi) => {
    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config);
      } catch (error) {
        console.error(`MCP server "${name}" skipped: ${errorMessage(error)}`);
      }
    }
  };
}

/**
 * Gives the MCP servers in `servers` images by name: where a call to one of their tools has the name of
 * an image in `store` in one of the server's image arguments, at any depth, or in a list there, the image
 * goes in its place, in the form the argument takes. Names elsewhere are left as they are, so an image
 * never reaches an argument that takes something else, and is echoed back in an error. Nested calls too,
 * such as a codemode script's. pi hands the hook its own copy of the arguments, so the image stays out
 * of the session.
 */
export function mcpImages(servers: Record<string, ImageArguments>, store: ImageFiles): ExtensionFactory {
  const prefixes = Object.entries(servers).map(([name, args]) => [`${mcpNamespace(name)}__`, args] as const);
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const args = prefixes.find(([prefix]) => event.toolName.startsWith(prefix))?.[1];
      if (args) await replaceImages(event.input, args, store);
      return undefined;
    });
  };
}

/** Replaces the names of images in `store` in `value`'s image arguments, `args`, with the images, in place. */
async function replaceImages(value: unknown, args: ImageArguments, store: ImageFiles, form?: ImageForm): Promise<void> {
  if (typeof value !== 'object' || value === null) return;
  const entries = Array.isArray(value) ? value.map((item, i) => [i, item] as const) : Object.entries(value);
  await Promise.all(
    entries.map(async ([key, item]) => {
      // An image argument, or a list in one.
      const itemForm = typeof key === 'string' && Object.hasOwn(args, key) ? args[key] : form;
      if (typeof item !== 'string') return replaceImages(item, args, store, itemForm);
      if (!itemForm) return;
      // Anything but the name of one of the thread's images is left as it is, such as data already
      // given: the store refuses it, without looking for a file unless it could be an image's name.
      const image = await imageIn(store, item, itemForm).catch(() => undefined);
      if (image !== undefined) (value as Record<string | number, unknown>)[key] = image;
    }),
  );
}

async function imageIn(store: ImageFiles, name: string, form: ImageForm): Promise<string> {
  if (form === 'path') return store.path(name);
  const [image] = await store.get([name]);
  return form === 'base64' ? image!.data : `data:${image!.mimeType};base64,${image!.data}`;
}

/** Tool names are `mcp__<server>__<tool>`, with `-` in the server name replaced by `_`. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
