const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const MAX_CHAIN_DEPTH = 3;
const MAX_RESPONDERS_PER_MESSAGE = 2;
const RESPONSE_DELAY_MS = 900;

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function extractOutputText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];
  for (const item of payload.output || []) {
    for (const chunk of item.content || []) {
      if (typeof chunk.text === "string") {
        parts.push(chunk.text);
      }
    }
  }

  return parts.join("\n").trim();
}

class PluginManager {
  constructor(directory) {
    this.directory = directory;
    this.plugins = this.loadPlugins();
  }

  loadPlugins() {
    if (!fs.existsSync(this.directory)) {
      return [];
    }

    return fs
      .readdirSync(this.directory)
      .filter((file) => file.endsWith(".js"))
      .map((file) => {
        const pluginPath = path.join(this.directory, file);
        const plugin = require(pluginPath);
        return {
          name: plugin.name || file,
          description: plugin.description || "No description provided.",
          ...plugin
        };
      });
  }

  async runHook(hook, payload, context) {
    let next = payload;

    for (const plugin of this.plugins) {
      if (typeof plugin[hook] !== "function") {
        continue;
      }

      const candidate = await plugin[hook](next, {
        ...context,
        plugin
      });

      if (candidate !== undefined) {
        next = candidate;
      }
    }

    return next;
  }

  list() {
    return this.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description
    }));
  }
}

class Agent {
  constructor(config) {
    this.id = config.id || uid("agent");
    this.name = config.name;
    this.role = config.role;
    this.tone = config.tone;
    this.provider = config.provider || "auto";
    this.active = config.active !== false;
  }

  async generateReply({ room, triggerMessage, history }) {
    const prompt = this.buildPrompt({ room, triggerMessage, history });
    const liveReply = await this.tryOpenAI(prompt);

    if (liveReply) {
      return liveReply;
    }

    return this.mockReply({ triggerMessage, history });
  }

  buildPrompt({ room, triggerMessage, history }) {
    const recentHistory = history
      .slice(-6)
      .map((message) => `${message.author}: ${message.text}`)
      .join("\n");

    return [
      `You are ${this.name}, a ${this.role} in a live multi-agent comment room called "${room.name}".`,
      `Your tone is ${this.tone}.`,
      "Reply with one short chat message that feels conversational and advances the discussion.",
      "Avoid markdown, bullet lists, and long explanations.",
      `Latest trigger: ${triggerMessage.author}: ${triggerMessage.text}`,
      `Recent history:\n${recentHistory}`
    ].join("\n\n");
  }

  async tryOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return "";
    }

    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          input: prompt
        })
      });

      if (!response.ok) {
        return "";
      }

      const payload = await response.json();
      return extractOutputText(payload);
    } catch (error) {
      return "";
    }
  }

  mockReply({ triggerMessage, history }) {
    const lower = triggerMessage.text.toLowerCase();
    const lastIdea = history
      .slice(-4)
      .map((message) => message.text)
      .join(" ");

    const roleOpeners = {
      analyst: [
        "The pattern I see is",
        "The strongest signal here is",
        "From the room so far,"
      ],
      contrarian: [
        "The risk I still see is",
        "I want to push back on",
        "The fragile part of this idea is"
      ],
      builder: [
        "A practical next step is",
        "We can turn this into a feature by",
        "The simplest build path is"
      ],
      moderator: [
        "Let me tighten the thread:",
        "To keep the room moving,",
        "The next decision we need is"
      ]
    };

    const openerPool = roleOpeners[this.role] || [
      "My take is",
      "I would add that",
      "A useful angle is"
    ];

    const opener = openerPool[Math.floor(Math.random() * openerPool.length)];

    if (lower.includes("?")) {
      return `${opener} we should answer the question by clarifying scope, plugin behavior, and which agents speak first.`;
    }

    if (lower.includes("plugin")) {
      return `${opener} each plugin should hook routing or message shaping without owning the whole conversation loop.`;
    }

    if (lower.includes("agent")) {
      return `${opener} each agent needs a clear persona, turn limit, and response trigger so the room stays readable.`;
    }

    return `${opener} we can build on "${lastIdea.slice(0, 80) || triggerMessage.text}" and keep the replies short enough to feel like a live chat.`;
  }
}

class Arena {
  constructor(pluginManager, io) {
    this.pluginManager = pluginManager;
    this.io = io;
    this.rooms = new Map();
    this.seed();
  }

  seed() {
    const roomId = this.createRoom("Launch Room");
    this.addAgent(roomId, {
      name: "Builder Bot",
      role: "builder",
      tone: "decisive and product-focused"
    });
    this.addAgent(roomId, {
      name: "Critic Bot",
      role: "contrarian",
      tone: "skeptical but constructive"
    });
    this.addAgent(roomId, {
      name: "Moderator Bot",
      role: "moderator",
      tone: "calm and synthesizing"
    });

    this.addMessage(roomId, {
      author: "System",
      origin: "system",
      text: "Room initialized. Ask the agents a question or start a roundtable."
    });
  }

  snapshot() {
    return {
      rooms: Array.from(this.rooms.values()).map((room) => this.serializeRoom(room)),
      plugins: this.pluginManager.list()
    };
  }

  serializeRoom(room) {
    return {
      id: room.id,
      name: room.name,
      agents: room.agents,
      messages: room.messages.slice(-100)
    };
  }

  createRoom(name) {
    const room = {
      id: uid("room"),
      name,
      messages: [],
      agents: [],
      turnCursor: 0,
      lastConsensusAt: 0
    };
    this.rooms.set(room.id, room);
    return room.id;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  addAgent(roomId, config) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const agent = new Agent(config);
    const entry = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      tone: agent.tone,
      provider: agent.provider,
      active: agent.active
    };

    room.agents.push(entry);
    return entry;
  }

  toggleAgent(roomId, agentId) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const agent = room.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error("Agent not found.");
    }

    agent.active = !agent.active;
    return agent;
  }

  async addMessage(roomId, message) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    let nextMessage = {
      id: uid("msg"),
      roomId,
      createdAt: new Date().toISOString(),
      badges: [],
      depth: message.depth || 0,
      ...message
    };

    nextMessage = await this.pluginManager.runHook("beforeBroadcast", nextMessage, {
      room,
      arena: this,
      helpers: this.buildHelpers(room)
    });

    room.messages.push(nextMessage);
    this.io.emit("message:created", nextMessage);
    this.io.emit("room:updated", this.serializeRoom(room));

    await this.pluginManager.runHook("afterBroadcast", nextMessage, {
      room,
      arena: this,
      helpers: this.buildHelpers(room)
    });

    return nextMessage;
  }

  buildHelpers(room) {
    return {
      emitSystem: async (text) => {
        await this.addMessage(room.id, {
          author: "System",
          origin: "system",
          text
        });
      }
    };
  }

  async kickoff(roomId, topic) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const seed = await this.addMessage(roomId, {
      author: "Host",
      origin: "user",
      text: topic || "Debate how this app should balance autonomy, safety, and plugin flexibility."
    });

    this.scheduleReplies(room, seed);
    return seed;
  }

  async handleUserMessage(roomId, text, author) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }

    const message = await this.addMessage(roomId, {
      author: author || "Human",
      origin: "user",
      text
    });

    this.scheduleReplies(room, message);
    return message;
  }

  async scheduleReplies(room, triggerMessage) {
    if (triggerMessage.depth >= MAX_CHAIN_DEPTH) {
      return;
    }

    let selection = {
      message: triggerMessage,
      candidateAgentIds: room.agents.filter((agent) => agent.active).map((agent) => agent.id)
    };

    selection = await this.pluginManager.runHook("beforeAgentSelection", selection, {
      room,
      arena: this,
      helpers: this.buildHelpers(room)
    });

    const recentAuthors = new Set(
      room.messages
        .slice(-3)
        .map((message) => message.agentId)
        .filter(Boolean)
    );

    const candidates = room.agents.filter(
      (agent) =>
        agent.active &&
        selection.candidateAgentIds.includes(agent.id) &&
        !recentAuthors.has(agent.id)
    );

    if (!candidates.length) {
      return;
    }

    const responders = [];
    while (responders.length < Math.min(MAX_RESPONDERS_PER_MESSAGE, candidates.length)) {
      const index = room.turnCursor % candidates.length;
      const next = candidates[index];
      room.turnCursor += 1;
      if (!responders.find((agent) => agent.id === next.id)) {
        responders.push(next);
      }
    }

    responders.forEach((agent, index) => {
      setTimeout(async () => {
        const liveAgent = new Agent(agent);
        const replyText = await liveAgent.generateReply({
          room,
          triggerMessage,
          history: room.messages
        });

        const reply = await this.addMessage(room.id, {
          author: agent.name,
          agentId: agent.id,
          origin: "agent",
          text: replyText,
          role: agent.role,
          depth: triggerMessage.depth + 1
        });

        if (reply.depth < MAX_CHAIN_DEPTH && reply.origin === "agent") {
          this.scheduleReplies(room, reply);
        }
      }, RESPONSE_DELAY_MS * (index + 1));
    });
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pluginManager = new PluginManager(path.join(__dirname, "plugins"));
const arena = new Arena(pluginManager, io);

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  const initialState = arena.snapshot();
  socket.emit("state:init", initialState);

  for (const room of initialState.rooms) {
    socket.join(room.id);
  }

  socket.on("room:create", async (payload) => {
    const roomId = arena.createRoom(payload?.name || "New Room");
    await arena.addMessage(roomId, {
      author: "System",
      origin: "system",
      text: "Fresh room created. Add agents or launch a roundtable."
    });

    socket.join(roomId);
    io.emit("state:init", arena.snapshot());
  });

  socket.on("chat:send", async (payload) => {
    try {
      await arena.handleUserMessage(payload.roomId, payload.text, payload.author);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("agent:add", async (payload) => {
    try {
      const agent = arena.addAgent(payload.roomId, {
        name: payload.name,
        role: payload.role,
        tone: payload.tone
      });

      await arena.addMessage(payload.roomId, {
        author: "System",
        origin: "system",
        text: `${agent.name} joined the room as a ${agent.role}.`
      });
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("agent:toggle", async (payload) => {
    try {
      const agent = arena.toggleAgent(payload.roomId, payload.agentId);
      await arena.addMessage(payload.roomId, {
        author: "System",
        origin: "system",
        text: `${agent.name} is now ${agent.active ? "active" : "paused"}.`
      });
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("conversation:kickoff", async (payload) => {
    try {
      await arena.kickoff(payload.roomId, payload.topic);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`AI Comment Mesh running at http://localhost:${PORT}`);
});
