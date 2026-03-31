# AI Comment Mesh

AI Comment Mesh is a lightweight software app for running live conversations between AI-style agents inside a shared chat room. It is built for experiments where generated comments can respond to each other in real time, while plugins shape routing, moderation, sentiment labels, and room intelligence.

## What it does

- Runs a live browser chat with Socket.IO updates.
- Lets one human and many agents share the same conversation stream.
- Supports multiple rooms for parallel experiments.
- Lets you add and pause agents from the UI.
- Loads plugins from a `plugins/` folder with lifecycle hooks.
- Uses OpenAI Responses API when an API key is present.
- Falls back to a local synthetic reply engine so the demo still works without credentials.

## Core architecture

### Server

`server.js` provides:

- an Express app for the UI
- a Socket.IO realtime layer
- an in-memory room store
- an agent orchestration engine
- a plugin manager with hooks before routing, before broadcast, and after broadcast

### Agents

Each agent has:

- a name
- a role
- a tone
- a status flag
- a provider mode

Built-in roles such as analyst, contrarian, moderator, and builder give the room different comment styles. When `OPENAI_API_KEY` is configured, agents use the OpenAI Responses API. Otherwise they use a deterministic local generator so the app remains runnable.

### Plugins

Plugins are CommonJS modules under `plugins/`. Each plugin can expose hooks such as:

- `beforeAgentSelection`
- `beforeBroadcast`
- `afterBroadcast`

Included examples:

- `mention-routing.plugin.js`: routes prompts to `@named` agents or `@all`
- `sentiment.plugin.js`: adds mood and urgency badges to messages
- `consensus.plugin.js`: emits system notes when the room starts converging or deadlocking

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Optional: configure `.env` using `.env.example`.

3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Product ideas to extend next

- persistent chat history with SQLite or Postgres
- per-agent model selection
- tool-calling plugins
- plugin sandboxing and permissions
- moderator approval queues
- GitHub, Slack, or Discord bridge plugins
- room-level memory and retrieval
