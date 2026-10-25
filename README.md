# mattermost-ai-bot
An AI bot for Mattermost: an LLM agent that takes part in your threads and gets things done with tools.

* Mention the bot in a channel, or DM it, to start a thread. Every later post in that thread reaches the agent, along
  with any posts it missed. Each thread is one pi session, kept in `data/sessions/<root post id>.jsonl`.
* Tools come from pi extensions and MCP servers. Web research (`websearch` and `webfetch`, from
  [feather-pi-web](https://github.com/mmalecki/feather-pi-web)) is built in. No file or shell access.
* The model runs in pi's agent loop until it stops calling tools; its final answer is posted to the thread.

## Configuration
Set in `.env`:

* `MATTERMOST_URL`, `MATTERMOST_TOKEN` - Mattermost server and bot token
* `OPENAI_BASE_URL`, `OPENAI_API_KEY` - an OpenAI-compatible endpoint and its key. Without `OPENAI_BASE_URL`, Anthropic's
  endpoint is used with `ANTHROPIC_API_KEY`
* `OPENAI_MODEL` - default `claude-haiku-5-5`
* `OPENAI_MODEL_CONTEXT_WINDOW`, `OPENAI_MODEL_MAX_TOKENS` - defaults 200000 and 16384
* `PARALLEL_API_KEY` - enables `websearch`
* `HASS_SERVER`, `HASS_TOKEN` - Home Assistant and a long-lived access token, named as in `hass-cli`. Needs the "Model
  Context Protocol Server" integration; the agent sees the entities exposed to Assist
* `HASS_ALLOWED_USERS` - comma-separated Mattermost usernames who may use Home Assistant. A run gets Home Assistant
  only when every post it answers comes from one of them
* `DATA_DIR` - default `./data`

## Running
```sh
npm install
npm start
```

`npm test` runs the tests, `npm run typecheck` checks types.
