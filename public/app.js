const MAX_ATTEMPTS   = 5;
const TIMEOUT_MS     = 2 * 60 * 1000;
const TYPING_IDLE_MS = 2000;

// ── DOM refs ──
const loginScreen    = document.getElementById("login-screen");
const roomScreen     = document.getElementById("room-screen");
const joinScreen     = document.getElementById("join-screen");
const chatScreen     = document.getElementById("chat-screen");
const allScreens     = [loginScreen, roomScreen, joinScreen, chatScreen];

const usernameInput  = document.getElementById("username-input");
const passwordInput  = document.getElementById("password-input");
const loginBtn       = document.getElementById("login-btn");
const loginError     = document.getElementById("login-error");
const loginInfo      = document.getElementById("login-info");
const timeoutDisplay = document.getElementById("timeout-display");

const roomWelcome    = document.getElementById("room-welcome");
const createRoomBtn  = document.getElementById("create-room-btn");
const joinRoomBtn    = document.getElementById("join-room-btn");

const roomCodeInput  = document.getElementById("room-code-input");
const submitRoomBtn  = document.getElementById("submit-room-btn");
const joinError      = document.getElementById("join-error");
const backBtn        = document.getElementById("back-btn");

const roomBadge      = document.getElementById("room-badge");
const roomBadgeCode  = document.getElementById("room-badge-code");
const roomBadgeCopy  = document.getElementById("room-badge-copy");
const chatBody       = document.getElementById("chat-body");
const msgInput       = document.getElementById("msg");
const sendBtn        = document.getElementById("send-btn");
const leaveBtn       = document.getElementById("leave-btn");

const typingDots       = document.getElementById("typing-dots");
const typingText       = document.getElementById("typing-text");
const participantList  = document.getElementById("participant-list");
const participantCount = document.getElementById("participant-count");

const contextMenu  = document.getElementById("context-menu");
const ctxMakeHost  = document.getElementById("ctx-make-host");
const ctxKick      = document.getElementById("ctx-kick");

// ── State ──
let ws;
let attempts         = 0;
let timedOut         = false;
let currentRoomCode  = "";
let currentUser      = "";
let currentHost      = "";
let contextTarget    = "";
let lastParticipants = [];

const typingUsers   = new Set();
let typingIdleTimer = null;
let isSelfTyping    = false;

// ── Screen management ──
function showScreen(screen) {
  allScreens.forEach(s => s.classList.remove("active"));
  screen.classList.add("active");
}

function isHost() {
  return currentUser.toLowerCase() === currentHost.toLowerCase();
}

// ── WebSocket ──
function connectWS() {
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(protocol + location.host + "/ws");

  ws.onopen = () => setLoginEnabled(true);

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.type) {

      case "error":
        if (joinScreen.classList.contains("active")) {
          joinError.textContent  = m.content;
          submitRoomBtn.disabled = false;
          roomCodeInput.disabled = false;
          roomCodeInput.focus();
        } else {
          attempts++;
          const remaining = MAX_ATTEMPTS - attempts;
          if (remaining <= 0) { startTimeout(); return; }
          loginError.textContent = m.content + ` (${remaining} left)`;
          setLoginEnabled(true);
        }
        break;

      case "join_ok":
        attempts    = 0;
        currentUser = usernameInput.value.trim();
        roomWelcome.textContent = `connected as ${currentUser}`;
        showScreen(roomScreen);
        break;

      case "room_created":
      case "room_joined":
        enterChat(m.content);
        break;

      case "system":
        appendSystem(m.content);
        break;

      case "message":
        typingUsers.delete(m.user);
        updateTypingIndicator();
        appendMessage(m.user, m.content, false);
        break;

      case "typing":
        if (m.content === "start") typingUsers.add(m.user);
        else typingUsers.delete(m.user);
        updateTypingIndicator();
        break;

      case "room_members":
        updateParticipants(m.users);
        break;

      case "host_changed":
        currentHost = m.user;
        updateParticipants(null);
        appendSystem(`♛ ${m.user} is now the host`);
        break;

      case "kicked":
        ws.close();
        currentRoomCode = ""; currentUser = ""; currentHost = "";
        loginError.textContent = "you were kicked from the room.";
        passwordInput.value = "";
        showScreen(loginScreen);
        connectWS();
        break;

      case "username_taken_in_room":
        loginError.textContent = m.content + " — try a different handle.";
        usernameInput.value = "";
        passwordInput.value = "";
        showScreen(loginScreen);
        setLoginEnabled(true);
        break;
    }
  };

  ws.onclose = () => {
    if (timedOut) return;
    if (chatScreen.classList.contains("active")) {
      appendSystem("disconnected from server.");
    }
  };
}

// ── Login ──
function tryLogin() {
  const name = usernameInput.value.trim();
  const pass = passwordInput.value;
  if (!name) { loginError.textContent = "please enter a username."; return; }
  if (!pass)  { loginError.textContent = "please enter a password."; return; }
  loginError.textContent = "";
  setLoginEnabled(false);
  ws.send(JSON.stringify({ type: "join", user: name, content: pass }));
}

function setLoginEnabled(enabled) {
  usernameInput.disabled = !enabled;
  passwordInput.disabled = !enabled;
  loginBtn.disabled       = !enabled;
  if (enabled) usernameInput.focus();
}

function startTimeout() {
  timedOut = true;
  ws.close();
  setLoginEnabled(false);
  loginError.textContent = "too many failed attempts.";
  let secondsLeft = TIMEOUT_MS / 1000;
  updateTimeout(secondsLeft);
  const interval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) { clearInterval(interval); resetAfterTimeout(); }
    else updateTimeout(secondsLeft);
  }, 1000);
}

function updateTimeout(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  timeoutDisplay.textContent = `${m}:${sec}`;
  loginInfo.textContent = "try again after cooldown";
}

function resetAfterTimeout() {
  timedOut = false; attempts = 0;
  loginError.textContent = ""; loginInfo.textContent = "you can try again now.";
  timeoutDisplay.textContent = ""; usernameInput.value = ""; passwordInput.value = "";
  connectWS();
}

// ── Room selection ──
createRoomBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "create_room" })));

joinRoomBtn.addEventListener("click", () => {
  joinError.textContent = ""; roomCodeInput.value = "";
  showScreen(joinScreen); roomCodeInput.focus();
});

backBtn.addEventListener("click", () => showScreen(roomScreen));

function tryJoinRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { joinError.textContent = "please enter a room code."; return; }
  joinError.textContent = ""; submitRoomBtn.disabled = true; roomCodeInput.disabled = true;
  ws.send(JSON.stringify({ type: "join_room", content: code }));
}

submitRoomBtn.addEventListener("click", tryJoinRoom);
roomCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryJoinRoom(); });

// ── Enter chat ──
function enterChat(roomCode) {
  currentRoomCode = roomCode;
  chatBody.innerHTML = "";
  typingUsers.clear();
  updateTypingIndicator();
  lastParticipants = [];
  participantList.innerHTML = "";
  participantCount.textContent = "0";
  roomBadgeCode.textContent = roomCode;
  showScreen(chatScreen);
  msgInput.focus();
}

roomBadge.addEventListener("click", () => {
  navigator.clipboard.writeText(currentRoomCode);
  roomBadgeCopy.textContent = "✓ copied";
  setTimeout(() => { roomBadgeCopy.textContent = "⎘ copy"; }, 1800);
});

// ── Leave ──
leaveBtn.addEventListener("click", () => {
  sendTypingStop();
  ws.close();
  attempts = 0; currentRoomCode = ""; currentUser = ""; currentHost = "";
  usernameInput.value = ""; passwordInput.value = ""; loginError.textContent = "";
  showScreen(loginScreen);
  connectWS();
});

// ── Participants ──
function updateParticipants(users) {
  if (users !== null) lastParticipants = users;
  const list = lastParticipants;

  participantCount.textContent = list.length;
  participantList.innerHTML = "";

  list.forEach(name => {
    const isSelf     = name.toLowerCase() === currentUser.toLowerCase();
    const isHostUser = name.toLowerCase() === currentHost.toLowerCase();
    const canManage  = isHost() && !isSelf;

    const item = document.createElement("div");
    item.className = "participant-item" + (canManage ? " can-manage" : "");
    item.dataset.username = name;

    const avatar = document.createElement("div");
    avatar.className = "participant-avatar" + (isHostUser ? " is-host" : "");
    avatar.textContent = name[0];

    const nameEl = document.createElement("div");
    nameEl.className = "participant-name" + (isSelf ? " is-you" : "");
    nameEl.textContent = name;

    item.appendChild(avatar);
    item.appendChild(nameEl);

    if (isHostUser) {
      const tag = document.createElement("span");
      tag.className = "participant-tag host-tag";
      tag.textContent = "♛";
      item.appendChild(tag);
    } else if (isSelf) {
      const tag = document.createElement("span");
      tag.className = "participant-tag";
      tag.textContent = "you";
      item.appendChild(tag);
    }

    if (canManage) {
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextTarget = name;
        showContextMenu(e.clientX, e.clientY);
      });
    }

    participantList.appendChild(item);
  });
}

// ── Context menu ──
function showContextMenu(x, y) {
  contextMenu.classList.add("visible");
  const menuW = 160, menuH = 80;
  const left = Math.min(x, window.innerWidth  - menuW - 8);
  const top  = Math.min(y, window.innerHeight - menuH - 8);
  contextMenu.style.left = left + "px";
  contextMenu.style.top  = top  + "px";
}

function hideContextMenu() {
  contextMenu.classList.remove("visible");
  contextTarget = "";
}

ctxMakeHost.addEventListener("click", () => {
  if (contextTarget) ws.send(JSON.stringify({ type: "transfer_host", target: contextTarget }));
  hideContextMenu();
});

ctxKick.addEventListener("click", () => {
  if (contextTarget) ws.send(JSON.stringify({ type: "kick", target: contextTarget }));
  hideContextMenu();
});

document.addEventListener("click", (e) => { if (!contextMenu.contains(e.target)) hideContextMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

// ── Typing ──
function updateTypingIndicator() {
  const users = [...typingUsers];
  if (users.length === 0) {
    typingText.classList.remove("visible");
    typingDots.style.display = "none";
    typingText.textContent = "";
    return;
  }
  typingDots.style.display = "flex";
  typingText.classList.add("visible");
  if (users.length === 1) {
    typingText.textContent = `${users[0]} is typing...`;
  } else if (users.length === 2) {
    typingText.textContent = `${users[0]} and ${users[1]} are typing...`;
  } else {
    typingText.textContent = `${users[0]}, ${users[1]} and ${users.length - 2} more are typing...`;
  }
}

function sendTypingStart() {
  if (!isSelfTyping && ws && ws.readyState === WebSocket.OPEN) {
    isSelfTyping = true;
    ws.send(JSON.stringify({ type: "typing", content: "start" }));
  }
}

function sendTypingStop() {
  if (isSelfTyping && ws && ws.readyState === WebSocket.OPEN) {
    isSelfTyping = false;
    ws.send(JSON.stringify({ type: "typing", content: "stop" }));
  }
}

msgInput.addEventListener("input", () => {
  if (msgInput.value.trim() === "") { sendTypingStop(); clearTimeout(typingIdleTimer); return; }
  sendTypingStart();
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(sendTypingStop, TYPING_IDLE_MS);
});

// ── Chat ──
function send() {
  const content = msgInput.value.trim();
  if (!content) return;
  clearTimeout(typingIdleTimer);
  sendTypingStop();
  appendMessage("You", content, true);
  ws.send(JSON.stringify({ type: "message", content }));
  msgInput.value = "";
}

function appendMessage(user, content, isSelf) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg " + (isSelf ? "self" : "other");
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = isSelf ? "you" : user;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = content;
  wrapper.appendChild(meta);
  wrapper.appendChild(bubble);
  chatBody.appendChild(wrapper);
  chatBody.scrollTop = chatBody.scrollHeight;
}

function appendSystem(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg system";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  wrapper.appendChild(bubble);
  chatBody.appendChild(wrapper);
  chatBody.scrollTop = chatBody.scrollHeight;
}

// ── Event listeners ──
sendBtn.addEventListener("click", send);
msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
loginBtn.addEventListener("click", tryLogin);
usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
passwordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });

// ── Init ──
setLoginEnabled(false);
connectWS();