const socket = io();

const state = {
  rooms: [],
  plugins: [],
  activeRoomId: null
};

const roomList = document.getElementById("room-list");
const pluginList = document.getElementById("plugin-list");
const agentList = document.getElementById("agent-list");
const roomHeader = document.getElementById("room-header");
const messageList = document.getElementById("message-list");
const chatForm = document.getElementById("chat-form");
const roomForm = document.getElementById("room-form");
const agentForm = document.getElementById("agent-form");
const kickoffButton = document.getElementById("kickoff-button");

function getActiveRoom() {
  return state.rooms.find((room) => room.id === state.activeRoomId) || state.rooms[0] || null;
}

function setActiveRoom(roomId) {
  state.activeRoomId = roomId;
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRooms() {
  roomList.innerHTML = state.rooms
    .map(
      (room) => `
        <article class="room-card ${room.id === state.activeRoomId ? "active" : ""}">
          <strong>${escapeHtml(room.name)}</strong>
          <p class="muted">${room.messages.length} messages | ${room.agents.length} agents</p>
          <button data-room-id="${room.id}">Open Room</button>
        </article>
      `
    )
    .join("");

  roomList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setActiveRoom(button.dataset.roomId));
  });
}

function renderPlugins() {
  pluginList.innerHTML = state.plugins
    .map(
      (plugin) => `
        <article class="plugin-card">
          <strong>${escapeHtml(plugin.name)}</strong>
          <p class="muted">${escapeHtml(plugin.description)}</p>
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
          <p class="muted">${escapeHtml(agent.role)} | ${escapeHtml(agent.tone)}</p>
          <p class="muted">${agent.active ? "Active" : "Paused"}</p>
          <button data-agent-id="${agent.id}">
            ${agent.active ? "Pause Agent" : "Resume Agent"}
          </button>
        </article>
      `
    )
    .join("");

  agentList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      socket.emit("agent:toggle", {
        roomId: room.id,
        agentId: button.dataset.agentId
      });
    });
  });
}

function renderMessages(room) {
  if (!room) {
    roomHeader.innerHTML = "<h2>No rooms yet</h2>";
    messageList.innerHTML = "";
    return;
  }

  roomHeader.innerHTML = `
    <div>
      <h2>${escapeHtml(room.name)}</h2>
      <p class="muted">${room.agents.filter((agent) => agent.active).length} active agents in this room</p>
    </div>
    <p class="meta">Tip: use @all or @builder-bot style mentions</p>
  `;

  messageList.innerHTML = room.messages
    .map((message) => {
      const badges = (message.badges || [])
        .map((badge) => `<span class="badge ${escapeHtml(badge)}">${escapeHtml(badge)}</span>`)
        .join("");

      return `
        <article class="message">
          <div class="message-head">
            <div>
              <strong>${escapeHtml(message.author)}</strong>
              <span class="meta">${escapeHtml(message.origin)}</span>
            </div>
            <span class="meta">${new Date(message.createdAt).toLocaleTimeString()}</span>
          </div>
          <div>${escapeHtml(message.text)}</div>
          ${badges ? `<div class="badge-row">${badges}</div>` : ""}
        </article>
      `;
    })
    .join("");

  messageList.scrollTop = messageList.scrollHeight;
}

function render() {
  if (!state.activeRoomId && state.rooms[0]) {
    state.activeRoomId = state.rooms[0].id;
  }

  const room = getActiveRoom();
  renderRooms();
  renderPlugins();
  renderAgents(room);
  renderMessages(room);
}

socket.on("state:init", (payload) => {
  state.rooms = payload.rooms;
  state.plugins = payload.plugins;

  if (!state.activeRoomId && payload.rooms[0]) {
    state.activeRoomId = payload.rooms[0].id;
  }

  if (state.activeRoomId && !state.rooms.find((room) => room.id === state.activeRoomId) && payload.rooms[0]) {
    state.activeRoomId = payload.rooms[0].id;
  }

  render();
});

socket.on("room:updated", (updatedRoom) => {
  const index = state.rooms.findIndex((room) => room.id === updatedRoom.id);

  if (index >= 0) {
    state.rooms[index] = updatedRoom;
  } else {
    state.rooms.push(updatedRoom);
  }

  render();
});

socket.on("message:created", (message) => {
  const room = state.rooms.find((entry) => entry.id === message.roomId);
  if (!room) {
    return;
  }

  room.messages = room.messages.filter((entry) => entry.id !== message.id);
  room.messages.push(message);
  render();
});

socket.on("system:error", (message) => {
  window.alert(message);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = getActiveRoom();
  if (!room) {
    return;
  }

  const authorInput = document.getElementById("author-input");
  const messageInput = document.getElementById("message-input");
  const text = messageInput.value.trim();

  if (!text) {
    return;
  }

  socket.emit("chat:send", {
    roomId: room.id,
    author: authorInput.value.trim() || "Human",
    text
  });

  messageInput.value = "";
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomName = document.getElementById("room-name");
  const name = roomName.value.trim();
  if (!name) {
    return;
  }

  socket.emit("room:create", { name });
  roomName.value = "";
});

agentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = getActiveRoom();
  if (!room) {
    return;
  }

  const name = document.getElementById("agent-name").value.trim();
  const role = document.getElementById("agent-role").value;
  const tone = document.getElementById("agent-tone").value.trim();

  if (!name) {
    return;
  }

  socket.emit("agent:add", {
    roomId: room.id,
    name,
    role,
    tone
  });

  agentForm.reset();
  document.getElementById("agent-tone").value = "curious and concise";
});

kickoffButton.addEventListener("click", () => {
  const room = getActiveRoom();
  if (!room) {
    return;
  }

  const topic = window.prompt(
    "Seed the room with a topic",
    "How should this app coordinate many AI agents without turning the chat into noise?"
  );

  if (topic) {
    socket.emit("conversation:kickoff", {
      roomId: room.id,
      topic
    });
  }
});
