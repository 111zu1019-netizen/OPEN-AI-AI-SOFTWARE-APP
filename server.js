const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const STORE_FILE = path.resolve(process.cwd(), process.env.STORE_FILE || "./data/store.json");
const SESSION_COOKIE = "mesh_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_CHAIN_DEPTH = 3;
const MAX_RESPONDERS_PER_MESSAGE = 2;
const RESPONSE_DELAY_MS = 900;

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        return accumulator;
      }

      const key = decodeURIComponent(entry.slice(0, separator));
      const value = decodeURIComponent(entry.slice(separator + 1));
      accumulator[key] = value;
      return accumulator;
    }, {});
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

function makePasswordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  const candidate = Buffer.from(makePasswordHash(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (candidate.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

function defaultRoomSummary(room) {
  const lastMessage = room.messages[room.messages.length - 1];
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    objective: room.objective,
    visibility: room.visibility,
    manageMode: room.manageMode,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    createdByName: room.createdByName,
    agents: room.agents,
    messages: room.messages.slice(-150),
    lastMessagePreview: lastMessage ? lastMessage.text.slice(0, 120) : "No messages yet"
  };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  defaultData() {
    return {
      users: [],
      sessions: [],
      rooms: []
    };
  }

  load() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      const initial = this.defaultData();
      fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2));
      return initial;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return {
        ...this.defaultData(),
        ...JSON.parse(raw)
      };
    } catch (error) {
      return this.defaultData();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  cleanupSessions() {
    const currentTime = Date.now();
    const nextSessions = this.data.sessions.filter((session) => new Date(session.expiresAt).getTime() > currentTime);
    if (nextSessions.length !== this.data.sessions.length) {
      this.data.sessions = nextSessions;
      this.save();
    }
  }

  getUserById(userId) {
    return this.data.users.find((user) => user.id === userId) || null;
  }

  getUserByUsername(username) {
    return this.data.users.find((user) => user.username === username) || null;
  }

  createUser({ username, displayName, password }) {
    const normalized = normalizeUsername(username);
    if (!normalized || String(password || "").length < 8) {
      throw new Error("Use a valid username and a password with at least 8 characters.");
    }

    if (this.getUserByUsername(normalized)) {
      throw new Error("That username is already taken.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: uid("user"),
      username: normalized,
      displayName: String(displayName || normalized).trim() || normalized,
      passwordSalt: salt,
      passwordHash: makePasswordHash(password, salt),
      createdAt: now()
    };

    this.data.users.push(user);
    this.save();
    return user;
  }

  createSession(userId) {
    this.cleanupSessions();

    const session = {
      token: crypto.randomBytes(32).toString("hex"),
      userId,
      createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    };

    this.data.sessions = this.data.sessions.filter((entry) => entry.userId !== userId);
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  getUserBySessionToken(token) {
    this.cleanupSessions();
    const session = this.data.sessions.find((entry) => entry.token === token);
    if (!session) {
      return null;
    }

    return this.getUserById(session.userId);
  }

  deleteSession(token) {
    this.data.sessions = this.data.sessions.filter((session) => session.token !== token);
    this.save();
  }

  getRoom(roomId) {
    return this.data.rooms.find((room) => room.id === roomId) || null;
  }

  saveRoom(room) {
    const index = this.data.rooms.findIndex((entry) => entry.id === room.id);
    if (index >= 0) {
      this.data.rooms[index] = room;
    } else {
      this.data.rooms.push(room);
    }

    this.save();
  }

  canAccessRoom(room, userId) {
    return room.visibility === "shared" || room.createdByUserId === userId || room.createdByUserId === "system";
  }

  canManageRoom(room, userId) {
    return room.manageMode === "open" || room.createdByUserId === userId;
  }

  listRoomsForUser(userId) {
    return this.data.rooms
      .filter((room) => this.canAccessRoom(room, userId))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }
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
        const plugin = require(path.join(this.directory, file));
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
    this.tone = config.tone || "clear and concise";
    this.provider = config.provider || "auto";
    this.model = config.model || process.env.OPENAI_MODEL || "gpt-4.1-mini";
    this.goal = config.goal || "";
    this.systemPrompt = config.systemPrompt || "";
    this.active = config.active !== false;
  }

  async generateReply({ room, triggerMessage, history, plugins }) {
    const liveReply = await this.tryOpenAI({ room, triggerMessage, history, plugins });
    if (liveReply) {
      return liveReply;
    }

    return this.mockReply({ triggerMessage, history, room });
  }

  async tryOpenAI({ room, triggerMessage, history, plugins }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || this.provider === "mock") {
      return "";
    }

    const transcript = history
      .slice(-10)
      .map((message) => `${message.author} [${message.origin}]: ${message.text}`)
      .join("\n");

    const instructions = [
      `You are ${this.name}, a ${this.role} participating in a live multi-agent conversation.`,
      `Your tone is ${this.tone}.`,
      this.goal ? `Your goal: ${this.goal}` : "",
      this.systemPrompt ? `Extra guidance: ${this.systemPrompt}` : "",
      `Room objective: ${room.objective || "Collaborate productively and keep the discussion moving."}`,
      `Visible plugins: ${plugins.map((plugin) => plugin.name).join(", ") || "none"}.`,
      "Return exactly one short chat message.",
      "Be conversational, concrete, and reactive to the latest message.",
      "Do not use markdown, lists, role labels, or surrounding quotation marks."
    ]
      .filter(Boolean)
      .join("\n");

    const input = [
      `Room: ${room.name}`,
      `Latest trigger: ${triggerMessage.author}: ${triggerMessage.text}`,
      `Recent transcript:\n${transcript}`
    ].join("\n\n");

    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          instructions,
          input,
          max_output_tokens: 140
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

  mockReply({ triggerMessage, history, room }) {
    const lower = triggerMessage.text.toLowerCase();
    const recent = history
      .slice(-3)
      .map((message) => message.text)
      .join(" ");

    const openers = {
      analyst: ["The signal I see is", "The strongest pattern here is", "What stands out is"],
      contrarian: ["The risk I still see is", "I want to push back on", "The weak point is"],
      builder: ["A practical next step is", "The quickest build path is", "I would ship this by"],
      moderator: ["Let me tighten the thread:", "The choice we need next is", "To keep this readable,"]
    };

    const openerPool = openers[this.role] || ["My take is", "I would add that", "A useful angle is"];
    const opener = openerPool[Math.floor(Math.random() * openerPool.length)];

    if (lower.includes("?")) {
      return `${opener} we should answer by grounding the room objective, agent roles, and the plugin behavior first.`;
    }

    if (lower.includes("openai") || lower.includes("model")) {
      return `${opener} each agent should carry its own model, goal, and instruction layer so the conversation feels distinct.`;
    }

    if (lower.includes("room") || lower.includes("save")) {
      return `${opener} saved rooms should keep their agents, history, and owner settings so a discussion can continue later.`;
    }

    return `${opener} we can build on "${recent.slice(0, 90) || room.objective || triggerMessage.text}" and keep each reply short enough to feel live.`;
  }
}

class Arena {
  constructor(store, pluginManager, io) {
    this.store = store;
    this.pluginManager = pluginManager;
    this.io = io;
    this.seedDefaultRoom();
  }

  seedDefaultRoom() {
    if (this.store.data.rooms.length > 0) {
      return;
    }

    const room = {
      id: uid("room"),
      name: "Shared Launch Room",
      description: "A shared lobby for testing live multi-agent conversations.",
      objective: "Explore product ideas, tradeoffs, and agent collaboration patterns.",
      visibility: "shared",
      manageMode: "open",
      createdAt: now(),
      updatedAt: now(),
      createdByUserId: "system",
      createdByName: "System",
      turnCursor: 0,
      lastConsensusAt: 0,
      agents: [
        {
          id: uid("agent"),
          name: "Builder Bot",
          role: "builder",
          tone: "decisive and product-focused",
          provider: "auto",
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          goal: "Turn ideas into an implementation path.",
          systemPrompt: "",
          active: true
        },
        {
          id: uid("agent"),
          name: "Critic Bot",
          role: "contrarian",
          tone: "skeptical but constructive",
          provider: "auto",
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          goal: "Surface hidden risks and edge cases.",
          systemPrompt: "",
          active: true
        },
        {
          id: uid("agent"),
          name: "Moderator Bot",
          role: "moderator",
          tone: "calm and synthesizing",
          provider: "auto",
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          goal: "Keep the room focused and summarize when useful.",
          systemPrompt: "",
          active: true
        }
      ],
      messages: [
        {
          id: uid("msg"),
          roomId: "",
          createdAt: now(),
          author: "System",
          origin: "system",
          text: "Room initialized. Sign in, add agents, and continue the conversation later from saved rooms.",
          badges: [],
          depth: 0
        }
      ]
    };

    room.messages[0].roomId = room.id;
    this.store.saveRoom(room);
  }

  listAccessibleRooms(userId) {
    return this.store.listRoomsForUser(userId);
  }

  getVisibleRoom(userId, roomId) {
    const room = this.store.getRoom(roomId);
    if (!room || !this.store.canAccessRoom(room, userId)) {
      throw new Error("Room not found.");
    }

    return room;
  }

  getManageableRoom(userId, roomId) {
    const room = this.getVisibleRoom(userId, roomId);
    if (!this.store.canManageRoom(room, userId)) {
      throw new Error("You do not have permission to manage this room.");
    }

    return room;
  }

  snapshotForUser(user) {
    return {
      user: publicUser(user),
      rooms: this.listAccessibleRooms(user.id).map((room) => defaultRoomSummary(room)),
      plugins: this.pluginManager.list()
    };
  }

  async createRoom(user, payload) {
    const room = {
      id: uid("room"),
      name: String(payload?.name || "New Room").trim(),
      description: String(payload?.description || "").trim(),
      objective: String(payload?.objective || "").trim(),
      visibility: payload?.visibility === "shared" ? "shared" : "private",
      manageMode: "owner",
      createdAt: now(),
      updatedAt: now(),
      createdByUserId: user.id,
      createdByName: user.displayName,
      turnCursor: 0,
      lastConsensusAt: 0,
      agents: [],
      messages: []
    };

    this.store.saveRoom(room);
    await this.addMessage(user.id, room.id, {
      author: "System",
      origin: "system",
      text: "Saved room created. Add agents or start a roundtable whenever you are ready."
    });
    return room;
  }

  async addAgent(userId, roomId, payload) {
    const room = this.getManageableRoom(userId, roomId);

    const agent = {
      id: uid("agent"),
      name: String(payload?.name || "New Agent").trim(),
      role: String(payload?.role || "builder").trim(),
      tone: String(payload?.tone || "clear and concise").trim(),
      provider: payload?.provider === "openai" || payload?.provider === "mock" ? payload.provider : "auto",
      model: String(payload?.model || process.env.OPENAI_MODEL || "gpt-4.1-mini").trim(),
      goal: String(payload?.goal || "").trim(),
      systemPrompt: String(payload?.systemPrompt || "").trim(),
      active: true
    };

    room.agents.push(agent);
    room.updatedAt = now();
    this.store.saveRoom(room);

    await this.addMessage(userId, room.id, {
      author: "System",
      origin: "system",
      text: `${agent.name} joined the room as a ${agent.role}.`
    });

    return agent;
  }

  async toggleAgent(userId, roomId, agentId) {
    const room = this.getManageableRoom(userId, roomId);
    const agent = room.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error("Agent not found.");
    }

    agent.active = !agent.active;
    room.updatedAt = now();
    this.store.saveRoom(room);

    await this.addMessage(userId, room.id, {
      author: "System",
      origin: "system",
      text: `${agent.name} is now ${agent.active ? "active" : "paused"}.`
    });

    return agent;
  }

  async addMessage(userId, roomId, payload) {
    const room = this.getVisibleRoom(userId, roomId);

    let message = {
      id: uid("msg"),
      roomId,
      createdAt: now(),
      author: payload.author,
      origin: payload.origin,
      text: payload.text,
      badges: payload.badges || [],
      depth: payload.depth || 0,
      agentId: payload.agentId || null
    };

    message = await this.pluginManager.runHook("beforeBroadcast", message, {
      room,
      arena: this,
      helpers: this.buildHelpers(room)
    });

    room.messages.push(message);
    room.updatedAt = now();
    this.store.saveRoom(room);

    this.io.to(room.id).emit("message:created", message);
    this.io.to(room.id).emit("room:updated", defaultRoomSummary(room));

    await this.pluginManager.runHook("afterBroadcast", message, {
      room,
      arena: this,
      helpers: this.buildHelpers(room)
    });

    return message;
  }

  buildHelpers(room) {
    return {
      emitSystem: async (text) => {
        const actorId = room.createdByUserId || "system";
        await this.addMessage(actorId, room.id, {
          author: "System",
          origin: "system",
          text
        });
      }
    };
  }

  async handleUserMessage(user, roomId, text) {
    const room = this.getVisibleRoom(user.id, roomId);
    const message = await this.addMessage(user.id, room.id, {
      author: user.displayName,
      origin: "user",
      text
    });

    this.scheduleReplies(room.id, message);
    return message;
  }

  async kickoff(user, roomId, topic) {
    const room = this.getVisibleRoom(user.id, roomId);
    const message = await this.addMessage(user.id, room.id, {
      author: user.displayName,
      origin: "user",
      text: topic || room.objective || "Help this room converge on a strong product direction."
    });

    this.scheduleReplies(room.id, message);
    return message;
  }

  async scheduleReplies(roomId, triggerMessage) {
    const room = this.store.getRoom(roomId);
    if (!room || triggerMessage.depth >= MAX_CHAIN_DEPTH) {
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
    const targetCount = Math.min(MAX_RESPONDERS_PER_MESSAGE, candidates.length);
    while (responders.length < targetCount) {
      const index = room.turnCursor % candidates.length;
      const candidate = candidates[index];
      room.turnCursor += 1;
      if (!responders.find((agent) => agent.id === candidate.id)) {
        responders.push(candidate);
      }
    }

    room.updatedAt = now();
    this.store.saveRoom(room);

    responders.forEach((agentConfig, index) => {
      setTimeout(async () => {
        const liveRoom = this.store.getRoom(roomId);
        if (!liveRoom) {
          return;
        }

        const agent = new Agent(agentConfig);
        const replyText = await agent.generateReply({
          room: liveRoom,
          triggerMessage,
          history: liveRoom.messages,
          plugins: this.pluginManager.list()
        });

        const reply = await this.addMessage(liveRoom.createdByUserId || "system", liveRoom.id, {
          author: agent.name,
          origin: "agent",
          text: replyText,
          depth: triggerMessage.depth + 1,
          agentId: agent.id
        });

        if (reply.depth < MAX_CHAIN_DEPTH) {
          this.scheduleReplies(liveRoom.id, reply);
        }
      }, RESPONSE_DELAY_MS * (index + 1));
    });
  }
}

const store = new Store(STORE_FILE);
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const pluginManager = new PluginManager(path.join(__dirname, "plugins"));
const arena = new Arena(store, pluginManager, io);

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  return store.getUserBySessionToken(token);
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  req.user = user;
  next();
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, timestamp: now() });
});

app.post("/api/auth/signup", (req, res) => {
  try {
    const user = store.createUser(req.body || {});
    const session = store.createSession(user.id);
    setSessionCookie(res, session.token);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");
  const user = store.getUserByUsername(username);

  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const session = store.createSession(user.id);
  setSessionCookie(res, session.token);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    store.deleteSession(token);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/bootstrap", requireAuth, (req, res) => {
  res.json(arena.snapshotForUser(req.user));
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
  const user = token ? store.getUserBySessionToken(token) : null;

  if (!user) {
    next(new Error("Unauthorized"));
    return;
  }

  socket.data.user = publicUser(user);
  next();
});

async function syncSocketRooms(socket, emitState) {
  const user = store.getUserById(socket.data.user.id);
  if (!user) {
    return;
  }

  const rooms = arena.listAccessibleRooms(user.id);
  for (const room of rooms) {
    socket.join(room.id);
  }

  if (emitState) {
    socket.emit("state:init", arena.snapshotForUser(user));
  }
}

async function syncAllSockets(emitState) {
  for (const socket of io.sockets.sockets.values()) {
    await syncSocketRooms(socket, emitState);
  }
}

io.on("connection", async (socket) => {
  await syncSocketRooms(socket, true);

  socket.on("room:create", async (payload) => {
    try {
      const actor = store.getUserById(socket.data.user.id);
      const room = await arena.createRoom(actor, payload);
      await syncSocketRooms(socket, true);
      if (room.visibility === "shared") {
        await syncAllSockets(true);
      }
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("chat:send", async (payload) => {
    try {
      const actor = store.getUserById(socket.data.user.id);
      await arena.handleUserMessage(actor, payload.roomId, payload.text);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("agent:add", async (payload) => {
    try {
      await arena.addAgent(socket.data.user.id, payload.roomId, payload);
      await syncSocketRooms(socket, true);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("agent:toggle", async (payload) => {
    try {
      await arena.toggleAgent(socket.data.user.id, payload.roomId, payload.agentId);
      await syncSocketRooms(socket, true);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });

  socket.on("conversation:kickoff", async (payload) => {
    try {
      const actor = store.getUserById(socket.data.user.id);
      await arena.kickoff(actor, payload.roomId, payload.topic);
    } catch (error) {
      socket.emit("system:error", error.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`AI Comment Mesh running at http://localhost:${PORT}`);
});
