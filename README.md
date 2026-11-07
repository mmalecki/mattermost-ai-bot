# mattermost-ai-bot
An AI bot for Mattermost. Responds in threads and DMs, and runs in an agentic loop (powered by [Pi](https://pi.dev)).

![Mattermost thread with the bot executing "party lights" prompt](./docs/thread.png)

A less full-featured alternative to [Mattermost Agents plugin](https://github.com/mattermost/mattermost-plugin-agents).

## Configuration
Set in `.env`:

* `MATTERMOST_URL`, `MATTERMOST_TOKEN` - Mattermost server and [bot token](https://developers.mattermost.com/integrate/reference/bot-accounts/)
* `MATTERMOST_PUBLIC_URL` - where people open Mattermost, for the links the agent gives, if not `MATTERMOST_URL`, such
  as when the bot reaches the server at an internal address
* `MODEL` - the model, as `provider/model[:thinking]` like Pi's `--model`, for example
  `mistral/mistral-small-2603` or `anthropic/claude-haiku-5-5:low`. 
  [Pi handles provider and model quirks](https://pi.dev/docs/latest/providers).
  Thinking is off by default unless suffix is set.
  A thread runs on the model it started with, so a changed `MODEL` reaches new threads only.
* The provider's API key, under Pi's [name for it](https://pi.dev/docs/latest/providers#use-an-api-key-from-the-environment) (for example: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, ...)
* `MAX_OUTPUT_TOKENS` - default 8192, or the model's own limit if lower. It includes reasoning, and keeps a model
  stuck repeating itself from running for long
* `PARALLEL_API_KEY` - enables `websearch` through [Parallel](https://parallel.ai)
* `IMAGE_MODEL` - enables `generate_image`, with this model, as `provider/model` like `MODEL` but without thinking,
  for example `openrouter/bytedance-seed/seedream-5-0-pro`. See below
* `VISION_MODEL` - enables `look_at_image`, `locate` and `crop_image`, with this model, which must take images, as
  `provider/model[:thinking]` like `MODEL`, for example `openrouter/qwen/qwen3-vl-235b-a22b-instruct`. See below
* `MCP_CONFIG` - path to the tools configuration, below. Default `./mcp.json`, which may be missing
* `DATA_DIR` - default `./data`. Each thread has a directory in `sessions/`, named after its root post, with its
  session in `session.jsonl` and its images in `images/`
* `SCHEDULER` - `true` lets the agent schedule jobs in a thread, once or repeatedly, with
  [pi-ate-scheduler](https://github.com/catlain/pi-scheduler). Default `false`. See below
* `CODEMODE` - `true` gives the agent [Pi's `codemode`](https://pi.dev/docs/latest/codemode) tool even when every MCP
  server has `direct` exposure. Default `false`. See below
* `ALLOW_PICKING_MODEL` - `true` lets the post that starts a thread pick its model. Default `false`. See below
* `TZ` - time zone the posts' times are given to the model in, with their UTC offset. Default: the system's

Endpoints Pi doesn't know, such as a local llama.cpp server, go in `models.json` next to `mcp.json`, in
[Pi's format](https://pi.dev/docs/latest/models-configuration):

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{ "id": "qwen3.6-35b", "contextWindow": 131072 }]
    }
  }
}
```

with `MODEL=local/qwen3.6-35b`.

### Picking a model
With `ALLOW_PICKING_MODEL=true`, the post that brings the bot into a thread can end with a model, written like `MODEL`
after a `/`, for the thread to run on instead:

```
@sailor draw me a lighthouse /openrouter/google/gemini-3.1-pro:high
```

The word is taken off the post, and the thread keeps the model for good: the same word on a later post is just text,
as is one naming a provider Pi doesn't know, such as `/etc/hosts`. A model Pi doesn't have, or has no API key for, is
refused, and the next post that brings the bot into the thread starts it afresh. Anyone who can reach the bot can pick
any model with a key, so turn it on only where everyone may spend on them. If a thread's model is gone later, it
runs on `MODEL`.

### System prompt additions
`APPEND_SYSTEM.md`, next to `mcp.json`, is added to the system prompt, as in Pi. Use it to read the agent in on its
identity, purpose, for example "You are Sailor, you look after our home through Home Assistant".
Refreshed live for new sessions, and after a session idles out for existing ones.

The agent also gets the thread's permalink, and each post's id, so it can link the thread or a post in it, for
example in a note it saves somewhere with a tool. Links take the `MATTERMOST_PUBLIC_URL/_redirect/pl/<post id>` form.

### Images and files
When the model takes images, as Pi's catalog or `models.json` says (`"input": ["text", "image"]`), the agent sees the
images attached to posts, scaled down to the model's limits. Up to 8 go with each batch of posts, and images over
20 MB, or in formats other than PNG, JPEG, GIF and WebP, go as Mattermost's preview of them. The agent only learns the
names of other files, and of images when the model doesn't take them.

Images are kept in the thread's session file, and sent with every later run in the thread until it's compacted.
When the model or some tool takes images, such as `generate_image` below, posts' images are kept in the thread's
`images/` too, the originals or Mattermost's preview, under the names they're posted with, made new to the thread,
as `image-2.png` for a second `image.png`. The agent is given the names, seeing the images or not, and passes them to
the tools. Nothing removes them, or the thread's session, so `sessions/` grows with every thread.

### Generating images
With `IMAGE_MODEL` set, the agent gets a `generate_image` tool, and every image it generates in a run is attached to
its reply, up to 10 to a post, and kept in the thread's `images/` as `image.png`, `image-2.png` and so on. It sees them
too when the model takes images, scaled down to the model's limits and kept in the session file like posted images.
Generating is a tool call, so only `allowedUsers` can have the agent make images.

When the image model takes images too, as most do (`"input": ["text", "image"]` in Pi's catalog), the agent can have
images changed, or new ones made from them, by their names in the thread's `images/`, and only those, so a post can't
have it reach files elsewhere: those posted in the thread, those it generated, and those other tools return, such as
`webfetch` or an MCP server, which are kept as the tools return them, as `fetched.png` and so on, and named in their
results. Some image models take only one image at a time, such as `microsoft/mai-image-2.6`, which can't combine
images then.

Pi generates images only through OpenRouter so far: `IMAGE_MODEL` is one of
[its image models](https://openrouter.ai/models?output_modalities=image), and needs `OPENROUTER_API_KEY` whatever
`MODEL` is. OpenRouter refuses models its account's [data policy](https://openrouter.ai/settings/privacy), such as zero
data retention, rules out.

### Recognizing images
With `VISION_MODEL` set, the agent gets tools to work with the thread's images by name, whether `MODEL` takes images or
not:

* `look_at_image` asks the vision model about images, such as what one shows, or the text in it
* `locate` has it find things in an image, such as barcodes, a price tag or every face, as boxes
* `crop_image` cuts a box out of an image, at its full size, as an image of its own, `<name>-crop.png`, which the
  agent can look closer at, or pass to any tool that takes images, such as an MCP server that reads barcodes

Boxes are `[ymin, xmin, ymax, xmax]`, from 0 to 1000 of the image's height and width. The vision model is asked for
them by name, as models trained to find things answer arrays in their own order whatever they're asked: Qwen 3 VL
puts x first. Gemini's `box_2d` and Qwen's `bbox_2d` arrays are read too, from 0 to 1000 or in pixels. Models differ
a lot at this: Qwen 3 VL and Gemma 4 find things well, while Claude Haiku 5.5 and Mistral Medium 3.5 only roughly,
so try `locate` with the one you pick. The vision model is sent images scaled down to its limits, while `crop_image`
cuts from the image as it was posted or returned, and shows the crop to the agent only when `MODEL` takes images. These are tool calls, so only `allowedUsers` can have the agent
make them.

The vision model is asked for short, factual answers, of at most 2048 tokens: left alone, Qwen 3 VL writes thousands
of words, and can repeat itself until it runs out of tokens, which takes it over 20 minutes. Vision models misread
small text, and agree with what a question suggests, so the agent is told to ask open questions, and to check the
text read on a crop.

### Tools
`mcp.json` uses [Pi's MCP configuration format](https://pi.dev/docs/latest/mcp), with one addition: `allowedUsers`, the
Mattermost users who may have the agent call tools. It covers every tool call, the built-in web tools included, and
a thread has tools only while everyone who has posted in it is one of them: a single post from anyone else, even one
deleted later, turns them off in that thread, scheduled jobs included. Without `allowedUsers`, everyone may use tools.

```json
{
  "allowedUsers": ["alice", "bob"],
  "mcpServers": {
    "homeassistant": {
      "url": "http://homeassistant.local:8123/api/mcp",
      "headers": { "Authorization": "Bearer ${HASS_TOKEN}" },
      "exposure": "direct"
    }
  }
}
```

Values such as `${HASS_TOKEN}` are read from the environment, so secrets can stay in `.env`. As in Pi, a server's
`exposure` defaults to `codemode`, where the model reaches its tools through scripts; `direct` declares them to the model
like the built-in tools, which suits small models and small servers best. `codemode` is on only while some server has
`codemode` exposure, unless `CODEMODE=true`: then scripts can call every tool, `direct` ones and the built-in web tools
included, to run calls in parallel or cut down large results. The `description` of every enabled server is
shown to the model, whatever its exposure. `mcp.example.json` is a starting point.

#### Images for MCP servers
A server's tools can take the thread's images, which the agent gives them by name, as it does `generate_image`, with
another addition: the server's `images`, naming the arguments its tools take images in, and how each takes them:

* `base64` - the image's data, in base64
* `dataUrl` - a `data:` URL with it
* `path` - the path of its file in `DATA_DIR`, for a server started by the bot, or one the directory is shared with

```json
{
  "mcpServers": {
    "barcodes": {
      "command": "npx",
      "args": ["-y", "@cordfuse/barcoding-mcp"],
      "exposure": "direct",
      "images": { "base64": "base64" }
    }
  }
}
```

A name of an image in the thread in one of those arguments, at any depth or in a list, such as `"base64":
"garage.png"`, is replaced with the image before the call reaches the server, and only there: the session keeps the
name. A name in any other argument stays a name, so a tool that takes a path, a URL or base64 data in arguments of
their own doesn't get the image where it expects something else, and echo it back in an error. Images are passed on
whole, up to 20 MB for a posted one, which `base64` and `dataUrl` grow by a third, so a server may refuse large ones.

### Scheduled jobs
With `SCHEDULER=true`, the agent gets a `schedule` tool: "remind me at 6 to close the garage", "every morning, check
the weather". A job belongs to its thread. When it comes due, its prompt reaches the agent like a post, and the reply is
posted to the thread. Scheduling is a tool call, so only `allowedUsers` can set up jobs, and a job gets tools only while
its thread still has them.

Jobs are kept in the thread's session file, and a thread with jobs pending stays open past 15 idle minutes. They
don't survive a restart well: a thread's jobs resume only once it gets a new post, and any that came due in the
meantime, recurring ones included, are dropped. Intervals run up to 24 days, from 5 seconds for a one-off job and a
minute for a recurring one, and a thread can have 10 jobs.

## Running

### npm

```sh
npm install -g @mmalecki/mattermost-ai-bot
mattermost-ai-bot

# or:
npx @mmalecki/mattermost-ai-bot
```

Run it in the directory with `.env`, `mcp.json`, `models.json` and `APPEND_SYSTEM.md`. Variables already set in the
environment win over `.env`. It needs `git` to install, for pi-ate-scheduler.

### Docker
```sh
docker run -d --name mattermost-ai-bot \
  --restart=unless-stopped \
  --env-file .env -v "$PWD/config:/config:ro" -v mattermost-ai-bot:/data \
  ghcr.io/mmalecki/mattermost-ai-bot
```

The image runs the bot as uid 1000, not root. `mcp.json`, `models.json` and `APPEND_SYSTEM.md` go in a directory
mounted at `/config`, and `DATA_DIR` is `/data`. Leave `DATA_DIR` and `MCP_CONFIG` out of the `.env` the container
gets, as paths for running outside it would replace these:

```sh
docker build -t mattermost-ai-bot .
docker run -d --name mattermost-ai-bot --env-file .env -v "$PWD/config:/config:ro" -v mattermost-ai-bot:/data mattermost-ai-bot
```

`/data` must be writable by uid 1000 in the container. A named volume, as above, is. A host directory isn't under
rootless Docker or Podman, where the container's uids map to subordinate ones: hand it over with
`docker run --rm --user root -v "$PWD/data:/data" ghcr.io/mmalecki/mattermost-ai-bot chown 1000:1000 /data`.

### From source
```sh
git clone https://github.com/mmalecki/mattermost-ai-bot.git
cd mattermost-ai-bot
npm install
npm start
```

`npm test` runs the tests, `npm run typecheck` checks types. Both, and `npm start`, run the TypeScript sources
directly; `npm run build` compiles them to `dist/`, which the npm package runs, and `npm pack` builds first.

On first `SIGINT` or `SIGTERM`, the bot stops handling new posts and exits once running threads finish their current run.
Second signal exits at once.
