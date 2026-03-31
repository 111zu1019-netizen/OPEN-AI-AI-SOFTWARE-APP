const state = {
  mode: "login",
  user: null,
  rooms: [],
  plugins: [],
  activeRoomId: null,
  socket: null
};

const authScreen = document.getElementById("auth-screen");
const appScreen = document.getElementById("app-screen");
const authForm = document.getElementById("auth-form");
const loginModeButton = document.getElementById("login-mode");
const signupModeButton = document.getElementById("signup-mode");
const authSubmit = document.getElementById("auth-submit");
const displayNameInput = document.getElementById("display-name-input");
const usernameInput = document.getElementById("username-input");
const passwordInput = document.getElementById("password-input");
const accountName = document.getElementById("account-name");
const accountHandle = document.getElementById("account-handle");
const logoutButton = document.getElementById("logout-button");
const roomList = document.getElementById("room-list");
const pluginList = document.getElementById("plugin-list");
const agentList = document.getElementById("agent-list");
const roomHeader = document.getElementById("room-header");
const messageList = document.getElementById("message-list");
const chatForm = document.getElementById("chat-form");
const roomForm = document.getElementById("room-form");
const agentForm = document.getElementById("agent-form");
const kickoffButton = document.getElementById("kickoff-button");
const notice = document.getElementById("notice");

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error || "Request failed.";
    const apiError = new Error(message);
    apiError.status = response.status;
    throw apiError;
  }

  return payload;
}

function getActiveRoom() {
  return state.rooms.find((room) => room.id === state.activeRoomId) || state.rooms[0] || null;
}

function setNotice(message, isError = false) {
  if (!message) {
    notice.classList.add("hidden");
    notice.textContent = "";
    notice.classList.remove("error");
    return;
  }

  notice.textContent = message;
  notice.classList.remove("hidden");
  notice.classList.toggle("error", Boolean(isError));
}

function setMode(mode) {
  state.mode = mode;
  loginModeButton.classList.toggle("accent", mode === "login");
  signupModeButton.classList.toggle("accent", mode === "signup");
  displayNameInput.style.display = mode === "signup" ? "block" : "none";
  displayNameInput.required = mode === "signup";
  authSubmit.textContent = mode === "signup" ? "Create Account" : "Login";
}

function showAuthScreen() {
  authScreen.classList.remove("hidden");
  appScreen.classList.add("hidden");
}

function showAppScreen() {
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
}

function syncRooms(payload) {
  state.user = payload.user;
  state.rooms = payload.rooms;
  state.plugins = payload.plugins;

  if (!state.activeRoomId || !state.rooms.find((room) => room.id === state.activeRoomId)) {
    state.activeRoomId = state.rooms[0]?.id || null;
  }

  render();
}

async function bootstrap() {
  try {
    const payload = await api("/api/bootstrap");
    syncRooms(payload);
    showAppScreen();
    connectSocket();
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      state.rooms = [];
      state.plugins = [];
      state.activeRoomId = null;
      disconnectSocket();
      showAuthScreen();
      render();
      return;
    }

    setNotice(error.message, true);
  }
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
}

function connectSocket() {
  if (state.socket) {
    return;
  }

  const socket = io();
  state.socket = socket;

  socket.on("state:init", (payload) => {
    syncRooms(payload);
  });

  socket.on("room:updated", (updatedRoom) => {
    const index = state.rooms.findIndex((room) => room.id === updatedRoom.id);
    if (index >= 0) {
      state.rooms[index] = updatedRoom;
    } else {
      state.rooms.push(updatedRoom);
    }

    state.rooms.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    render();
  });

  socket.on("message:created", (message) => {
    const room = state.rooms.find((entry) => entry.id === message.roomId);
    if (!room) {
      return;
    }

    room.messages = room.messages.filter((entry) => entry.id !== message.id);
    room.messages.push(message);
    room.lastMessagePreview = message.text.slice(0, 120);
    room.updatedAt = message.createdAt;
    render();
  });

  socket.on("system:error", (message) => {
    setNotice(message, true);
  });

  socket.on("connect_error", () => {
    disconnectSocket();
    bootstrap();
  });
}

function renderRooms() {
  roomList.innerHTML = state.rooms
    .map(
      (room) => `
        <article class="room-card ${room.id === state.activeRoomId ? "active" : ""}">
          <strong>${escapeHtml(room.name)}</strong>
          <p class="muted">${escapeHtml(room.visibility)} | by ${escapeHtml(room.createdByName)}</p>
          <p class="tiny">${escapeHtml(room.lastMessagePreview || room.description || "No saved messages yet.")}</p>
          <button data-room-id="${room.id}" type="button">Open Room</button>
        </article>
      `
    )
    .join("");

  roomList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRoomId = button.dataset.roomId;
      render();
    });
  });
}

function renderPlugins() {
  pluginList.innerHTML = state.plugins
    .map(
      (plugin) => `
        <article class="plugin-card">
          <strong>${escapeHtml(plugin.name)}</strong>
          <p class="tiny muted">${escapeHtml(plugin.description)}</p>
        </article>
      `
    )
    .join("");
}

function renderAgents(room) {
  if (!room) {
    agentList.innerHTML = "";
    return;
  }

  agentList.innerHTML = room.agents
    .map(
      (agent) => `
        <article class="agent-card">
          <strong>${escapeHtml(agent.name)}</strong>
          <p class="tiny muted">${escapeHtml(agent.role)} | ${escapeHtml(agent.provider)} | ${escapeHtml(agent.model)}</p>
          <p class="tiny">${escapeHtml(agent.goal || agent.tone)}</p>
          <button data-agent-id="${agent.id}" type="button">${agent.active ? "Pause" : "Resume"}</button>
        </article>
      `
    )
    .join("");

  agentList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.socket?.emit("agent:toggle", {
        roomId: room.id,
        agentId: button.dataset.agentId
      });
    });
  });
}

function renderRoomHeader(room) {
  if (!room) {
    roomHeader.innerHTML = "<h3>No saved rooms yet</h3>";
    return;
  }

  roomHeader.innerHTML = `
    <div>
      <h3>${escapeHtml(room.name)}</h3>
      <p class="muted">${escapeHtml(room.description || "No description yet.")}</p>
      <p class="tiny">Objective: ${escapeHtml(room.objective || "Keep the conversation moving.")}</p>
    </div>
    <div class="room-meta">
      <span>${escapeHtml(room.visibility)}</span>
      <span>${room.agents.length} agents</span>
      <span>${room.messages.length} messages</span>
    </div>
  `;
}

function renderMessages(room) {
  if (!room) {
    messageList.innerHTML = "";
    return;
  }

  messageList.innerHTML = room.messages
    .map((message) => {
      const badges = (message.badges || [])
        .map((badge) => `<span class="badge ${escapeHtml(badge)}">${escapeHtml(badge)}</span>`)
        .join("");

      return `
        <article class="message message-${escapeHtml(message.origin)}">
          <div class="message-head">
            <div>
              <strong>${escapeHtml(message.author)}</strong>
              <span class="meta">${escapeHtml(message.origin)}</span>
            </div>
            <span class="meta">${new Date(message.createdAt).toLocaleString()}</span>
          </div>
          <div>${escapeHtml(message.text)}</div>
          ${badges ? `<div class="badge-row">${badges}</div>` : ""}
        </article>
      `;
    })
    .join("");

  messageList.scrollTop = messageList.scrollHeight;
}

function renderAccount() {
  if (!state.user) {
    accountName.textContent = "";
    accountHandle.textContent = "";
    return;
  }

  accountName.textContent = state.user.displayName;
  accountHandle.textContent = `@${state.user.username}`;
}

function render() {
  const room = getActiveRoom();
  renderAccount();
  renderRooms();
  renderPlugins();
  renderAgents(room);
  renderRoomHeader(room);
  renderMessages(room);
}

loginModeButton.addEventListener("click", () => setMode("login"));
signupModeButton.addEventListener("click", () => setMode("signup"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setNotice("");

  try {
    await api(`/api/auth/${state.mode}`, {
      method: "POST",
      body: {
        displayName: displayNameInput.value.trim(),
        username: usernameInput.value.trim(),
        password: passwordInput.value
      }
    });

    authForm.reset();
    setMode("login");
    await bootstrap();
  } catch (error) {
    setNotice(error.message, true);
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  disconnectSocket();
  state.user = null;
  state.rooms = [];
  state.plugins = [];
  state.activeRoomId = null;
  showAuthScreen();
  setNotice("Logged out.");
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.socket) {
    return;
  }

  state.socket.emit("room:create", {
    name: document.getElementById("room-name").value.trim(),
    description: document.getElementById("room-description").value.trim(),
    objective: document.getElementById("room-objective").value.trim(),
    visibility: document.getElementById("room-visibility").value
  });

  roomForm.reset();
  document.getElementById("room-visibility").value = "private";
});

agentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = getActiveRoom();
  if (!room || !state.socket) {
    return;
  }

  state.socket.emit("agent:add", {
    roomId: room.id,
    name: document.getElementById("agent-name").value.trim(),
    role: document.getElementById("agent-role").value,
    tone: document.getElementById("agent-tone").value.trim(),
    provider: document.getElementById("agent-provider").value,
    model: document.getElementById("agent-model").value.trim(),
    goal: document.getElementById("agent-goal").value.trim(),
    systemPrompt: document.getElementById("agent-system-prompt").value.trim()
  });

  agentForm.reset();
  document.getElementById("agent-tone").value = "clear and concise";
  document.getElementById("agent-provider").value = "auto";
  document.getElementById("agent-model").value = "gpt-4.1-mini";
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = getActiveRoom();
  if (!room || !state.socket) {
    return;
  }

  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text) {
    return;
  }

  state.socket.emit("chat:send", {
    roomId: room.id,
    text
  });

  input.value = "";
});

kickoffButton.addEventListener("click", () => {
  const room = getActiveRoom();
  if (!room || !state.socket) {
    return;
  }

  const topic = window.prompt(
    "Seed this saved room",
    room.objective || "How should this product balance autonomy, safety, and readability?"
  );

  if (topic) {
    state.socket.emit("conversation:kickoff", {
      roomId: room.id,
      topic
    });
  }
});

setMode("login");
bootstrap();
