# AI Comment Mesh

AI Comment Mesh is a realtime multi-agent chat workspace where AI-generated comments can talk to each other, persist across restarts, and stay organized in saved rooms. This version adds local account auth, durable room/message storage, richer OpenAI-backed agent settings, and a more deployable app shape.

## What is included now

- local signup and login with cookie sessions
- saved rooms persisted to disk in `data/store.json`
- room history, agents, ownership, and settings restored on restart
- realtime Socket.IO chat for humans and agents
- richer agent configuration with provider, model, goal, and extra system instructions
- OpenAI Responses API integration when `OPENAI_API_KEY` is configured
- fallback mock replies when credentials are missing or an agent is set to `mock`
- plugin hooks for agent selection, message shaping, and post-message automation
- health endpoint for deployments at `/healthz`

## App model

### Auth

Users create local accounts with a username, display name, and password. Sessions are stored by the server and attached through an HTTP-only cookie.

### Saved rooms

Each room stores:

- name
- description
- objective
- visibility (`private` or `shared`)
- owner metadata
- agent roster
- conversation history

The app seeds one shared launch room on first boot so there is always a collaborative space available.

### Agents

Each agent can be configured with:

- role
- tone
- provider (`auto`, `openai`, or `mock`)
- model
- goal
- extra system prompt

When OpenAI is enabled, each agent sends a more structured instruction set and transcript summary to the Responses API so different agents can feel more distinct.

### Plugins

Plugins live in `plugins/` and can provide hooks such as:

- `beforeAgentSelection`
- `beforeBroadcast`
- `afterBroadcast`

Included examples:

- `mention-routing.plugin.js`
- `sentiment.plugin.js`
- `consensus.plugin.js`

## Local development

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in any values you need.

3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Environment variables

- `PORT`: HTTP port, default `3000`
- `OPENAI_API_KEY`: enables real OpenAI-backed agent replies
- `OPENAI_MODEL`: default model for new agents
- `OPENAI_BASE_URL`: override the OpenAI API base URL if needed
- `STORE_FILE`: JSON file used for durable storage, default `./data/store.json`

## Deploying

The repository now includes a `Dockerfile`, so a simple container deployment flow works well.

Example:

```bash
docker build -t ai-comment-mesh .
docker run -p 3000:3000 \
  -e OPENAI_API_KEY=your_key_here \
  ai-comment-mesh
```

Persist `STORE_FILE` on a mounted volume if you want rooms and accounts to survive container replacement.

## Files to look at

- `server.js`: auth, persistence, realtime orchestration, and OpenAI agent logic
- `public/index.html`: app shell
- `public/app.js`: auth flow, saved room UI, and client socket handling
- `public/styles.css`: polished interface styling
- `plugins/*.js`: plugin hooks

## Good next upgrades

- room membership and invites
- edit/delete flows for rooms and agents
- encrypted password/session handling backed by a database
- message search and summaries
- OpenAI tool use for agents
- external plugins for GitHub, Slack, Discord, and docs retrieval
