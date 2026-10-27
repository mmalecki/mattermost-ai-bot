# mattermost-ai-bot
An AI bot for Mattermost: an LLM agent that takes part in your threads and gets things done with tools.

* Mention the bot in a channel, or DM it, to start a thread. Every later post in that thread reaches the agent, along
  with any posts it missed. Each thread is one pi session, kept in `data/sessions/<root post id>.jsonl`.
* Web research (`websearch` and `webfetch`, from [feather-pi-web](https://github.com/mmalecki/feather-pi-web)) is built
  in. Further tools come from the MCP servers in `mcp.json`. No file or shell access.
* The model runs in pi's agent loop until it stops calling tools; its final answer is posted to the thread.

## Configuration
Set in `.env`:

* `MATTERMOST_URL`, `MATTERMOST_TOKEN` - Mattermost server and bot token
* `MODEL` - the model, as `provider/model[:thinking]` like pi's `--model`, for example
  `mistral/mistral-small-2603` or `anthropic/claude-haiku-5-5:low`. pi's catalog supplies the API, context window and
  quirks of its [providers](https://pi.dev/docs/latest/providers); thinking is off unless the suffix sets a level
* The provider's key, under pi's name for it: `MISTRAL_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, ...
* `MAX_OUTPUT_TOKENS` - default 8192, or the model's own limit if lower. It includes reasoning, and keeps a model
  stuck repeating itself from running for long
* `PARALLEL_API_KEY` - enables `websearch`
* `MCP_CONFIG` - path to the tools configuration, below. Default `./mcp.json`, which may be missing
* `DATA_DIR` - default `./data`
* `TZ` - time zone the posts' times are given to the model in, with their UTC offset. Default: the system's
* `SCHEDULER` - `true` lets the agent schedule jobs in a thread, once or repeatedly, with
  [pi-ate-scheduler](https://github.com/catlain/pi-scheduler). Default `false`. See below

Endpoints pi doesn't know, such as a llama.cpp server, go in `models.json` next to `mcp.json`, in
[pi's format](https://pi.dev/docs/latest/models-configuration):

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

## Instructions
`APPEND_SYSTEM.md`, next to `mcp.json`, is added to the system prompt, as in pi. Use it for what this installation is
for, for example "You look after our home through Home Assistant". Edits reach a thread when its session next opens: right away
for new threads, and after 15 idle minutes for running ones.

## Tools
`mcp.json` uses [pi's MCP configuration format](https://pi.dev/docs/latest/mcp), with one addition: `allowedUsers`, the
Mattermost usernames who may have the agent call tools. It covers every tool call, the built-in web tools included, and
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

Values such as `${HASS_TOKEN}` are read from the environment, so secrets can stay in `.env`. As in pi, a server's
`exposure` defaults to `codemode`, where the model reaches its tools through scripts; `direct` declares them to the model
like the built-in tools, which suits small models and small servers best. The `description` of every enabled server is
shown to the model, whatever its exposure. `mcp.example.json` is a starting point.

## Scheduled jobs
With `SCHEDULER=true`, the agent gets a `schedule` tool: "remind me at 6 to close the garage", "every morning, check
the weather". A job belongs to its thread. When it comes due, its prompt reaches the agent like a post, and the reply is
posted to the thread. Scheduling is a tool call, so only `allowedUsers` can set up jobs, and a job gets tools only while
its thread still has them.

Jobs are kept in the thread's session file, and a thread with jobs pending stays open past 15 idle minutes. They
don't survive a restart well: a thread's jobs resume only once it gets a new post, and any that came due in the
meantime, recurring ones included, are dropped. Intervals run up to 24 days, from 5 seconds for a one-off job and a
minute for a recurring one, and a thread can have 10 jobs.

## Running
```sh
npm install
npm start
```

`npm test` runs the tests, `npm run typecheck` checks types.

On SIGINT or SIGTERM, the bot stops taking posts and exits once running threads finish their current run; a second
signal exits at once.

### Docker
The image runs the bot as uid 1000, not root. `mcp.json`, `models.json` and `APPEND_SYSTEM.md` go in a directory
mounted at `/config`, and `DATA_DIR` is `/data`. Leave `DATA_DIR` and `MCP_CONFIG` out of the `.env` the container
gets, as paths for running outside it would replace these:

```sh
docker build -t mattermost-ai-bot .
docker run -d --name mattermost-ai-bot --env-file .env -v "$PWD/config:/config:ro" -v mattermost-ai-bot:/data mattermost-ai-bot
```

`/data` must be writable by uid 1000 in the container. A named volume, as above, is. A host directory isn't under
rootless Docker or Podman, where the container's uids map to subordinate ones: hand it over with
`docker run --rm --user root -v "$PWD/data:/data" mattermost-ai-bot chown 1000:1000 /data`.
