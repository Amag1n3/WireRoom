const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 2 * 60 * 1000;
const TYPING_IDLE_MS = 2000;

// ── DOM refs ──
const loginScreen = document.getElementById("login-screen");
const pickUsernameScreen = document.getElementById("pick-username-screen");
const roomScreen = document.getElementById("room-screen");
const joinScreen = document.getElementById("join-screen");
const chatScreen = document.getElementById("chat-screen");
const allScreens = [loginScreen, pickUsernameScreen, roomScreen, joinScreen, chatScreen];

const usernameInput = document.getElementById("username-input");
const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const loginInfo = document.getElementById("login-info");
const timeoutDisplay = document.getElementById("timeout-display");

const pickUsernameInput = document.getElementById("pick-username-input");
const pickUsernameBtn = document.getElementById("pick-username-btn");
const pickUsernameError = document.getElementById("pick-username-error");

const roomWelcome = document.getElementById("room-welcome");
const createRoomBtn = document.getElementById("create-room-btn");
const joinRoomBtn = document.getElementById("join-room-btn");

const roomCodeInput = document.getElementById("room-code-input");
const submitRoomBtn = document.getElementById("submit-room-btn");
const joinError = document.getElementById("join-error");
const backBtn = document.getElementById("back-btn");
const roomPasswordInput = document.getElementById("room-password-input");
const joinPasswordField = document.getElementById("join-password-field");
const joinPasswordInput = document.getElementById("join-password-input");

const roomBadge = document.getElementById("room-badge");
const roomBadgeCode = document.getElementById("room-badge-code");
const roomBadgeCopy = document.getElementById("room-badge-copy");
const chatBody = document.getElementById("chat-body");
const msgInput = document.getElementById("msg");
const sendBtn = document.getElementById("send-btn");
const leaveBtn = document.getElementById("leave-btn");

const typingDots = document.getElementById("typing-dots");
const typingText = document.getElementById("typing-text");
const participantList = document.getElementById("participant-list");
const participantCount = document.getElementById("participant-count");

const contextMenu = document.getElementById("context-menu");
const ctxMakeHost = document.getElementById("ctx-make-host");
const ctxKick = document.getElementById("ctx-kick");

const replyPreview = document.getElementById("reply-preview");
const replyPreviewText = document.getElementById("reply-preview-text");
const replyPreviewClose = document.getElementById("reply-preview-close");

const emojiBtn = document.getElementById("emoji-btn");
const emojiPickerContainer = document.getElementById("emoji-picker-container");
const reactPickerContainer = document.getElementById("react-picker-container");
// ── State ──
let ws;
let attempts = 0;
let timedOut = false;
let currentRoomCode = "";
let currentUser = "";
let currentHost = "";
let contextTarget = "";
let lastParticipants = [];
let wasKicked = false;
let replyTarget = null; // { id, user, content }
let reactTargetId = null;
const reactionStore = {}; // { msgId: { emoji: [user1, user2] } }

const typingUsers = new Set();
let typingIdleTimer = null;
let isSelfTyping = false;

// ── Emoji pickers ──
const inputPicker = picmo.createPicker({
  rootElement: emojiPickerContainer,
  theme: picmo.darkTheme,
  emojisPerRow: 8,
  visibleRows: 4,
});

inputPicker.addEventListener("emoji:select", (e) => {
  msgInput.value += e.emoji;
  msgInput.focus();
});

const reactPicker = picmo.createPicker({
  rootElement: reactPickerContainer,
  theme: picmo.darkTheme,
  emojisPerRow: 8,
  visibleRows: 4,
});

reactPicker.addEventListener("emoji:select", (e) => {
  if (reactTargetId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "reaction", content: e.emoji, reply_to: reactTargetId }));
  }
  reactPickerContainer.classList.remove("visible");
  reactTargetId = null;
});

emojiBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  reactPickerContainer.classList.remove("visible");
  emojiPickerContainer.classList.toggle("visible");
});

document.addEventListener("click", (e) => {
  if (!emojiPickerContainer.contains(e.target) && e.target !== emojiBtn) {
    emojiPickerContainer.classList.remove("visible");
  }
  if (!reactPickerContainer.contains(e.target)) {
    reactPickerContainer.classList.remove("visible");
    reactTargetId = null;
  }
});
// ── Helpers ──
function showScreen(screen) {
  allScreens.forEach(s => s.classList.remove("active"));
  screen.classList.add("active");
}

function isHost() {
  return currentUser.toLowerCase() === currentHost.toLowerCase();
}

function getToken() {
  return localStorage.getItem("wr_token");
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

// ── OAuth pick-username flow ──
// ── OAuth pick-username flow ──
const _urlParams = new URLSearchParams(window.location.search);
if (_urlParams.get("pick_username") === "1") {
  const _urlToken = _urlParams.get("token");
  if (_urlToken) {
    document.cookie = `wr_token=${_urlToken}; path=/; max-age=${30 * 24 * 60 * 60}; secure; samesite=lax`;
  }
  history.replaceState({}, "", "/");
  showScreen(pickUsernameScreen);
  pickUsernameInput.focus();
}

pickUsernameBtn.addEventListener("click", async () => {
  const name = pickUsernameInput.value.trim();
  if (!name) { pickUsernameError.textContent = "please enter a username."; return; }

  const token = getCookie("wr_token");
  if (!token) {
    pickUsernameError.textContent = "session lost, please log in again.";
    showScreen(loginScreen);
    connectWS();
    return;
  }

  pickUsernameBtn.disabled = true;
  pickUsernameError.textContent = "";

  try {
    const res = await fetch("/auth/set-username", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({ username: name }),
      credentials: "include"
    });

    if (res.ok) {
      location.href = "/";
    } else {
      const text = await res.text();
      pickUsernameError.textContent = text || "could not set username.";
      pickUsernameBtn.disabled = false;
      pickUsernameInput.focus();
    }
  } catch {
    pickUsernameError.textContent = "network error, try again.";
    pickUsernameBtn.disabled = false;
  }
});

pickUsernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pickUsernameBtn.click();
});

// ── WebSocket ──
function connectWS(overrideToken = null) {
  const protocol = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(protocol + location.host + "/ws");

  ws.onopen = () => {
    const token = overrideToken || getCookie("wr_token");
    if (token) {
      ws.send(JSON.stringify({ type: "auth", content: token }));
    } else {
      setLoginEnabled(true);
      const savedUser = localStorage.getItem("wr_user");
      const savedPass = localStorage.getItem("wr_pass");
      if (savedUser && savedPass) {
        usernameInput.value = savedUser;
        passwordInput.value = savedPass;
        tryLogin();
      }
    }
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.type) {

      case "error":
        if (joinScreen.classList.contains("active")) {
          joinError.textContent = m.content;
          submitRoomBtn.disabled = false;
          roomCodeInput.disabled = false;
          roomCodeInput.focus();
        } else if (m.content === "invalid session, please log in again") {
          document.cookie = "wr_token=; Max-Age=0; path=/";
          setLoginEnabled(true);
          loginError.textContent = "session expired, please log in again.";
        } else {
          attempts++;
          const remaining = MAX_ATTEMPTS - attempts;
          if (remaining <= 0) { startTimeout(); return; }
          loginError.textContent = m.content + ` (${remaining} left)`;
          setLoginEnabled(true);
        }
        break;

      case "join_ok":
        attempts = 0;
        currentUser = m.content.replace("Welcome, ", "").replace("!", "") || usernameInput.value.trim();
        if (usernameInput.value.trim()) {
          localStorage.setItem("wr_user", usernameInput.value.trim());
          localStorage.setItem("wr_pass", passwordInput.value);
        }
        roomWelcome.textContent = `connected as ${currentUser}`;
        showScreen(roomScreen);
        break;
      case "room_needs_password":
        joinPasswordField.style.display = "block";
        joinPasswordInput.focus();
        submitRoomBtn.disabled = false;
        roomCodeInput.disabled = false;
        joinError.textContent = "this room requires a password.";
        break;
      case "room_created":
      case "room_joined":
        enterChat(m.content);
        break;

      case "system":
        appendSystem(m.content);
        break;

      case "history":
        renderHistory(m.messages || []);
        break;

      case "message": {
        const isSelf = m.user.toLowerCase() === currentUser.toLowerCase();
        typingUsers.delete(m.user);
        updateTypingIndicator();
        appendMessage(m.user, m.content, isSelf, m.id, m.reply_to, m.reply_snip);
        break;
      }

      case "typing":
        if (m.content === "start") typingUsers.add(m.user);
        else typingUsers.delete(m.user);
        updateTypingIndicator();
        break;
      case "reaction": {
        const msgId = m.reply_to;
        const emoji = m.content;
        const user = m.user;
        if (!reactionStore[msgId]) reactionStore[msgId] = {};
        if (!reactionStore[msgId][emoji]) reactionStore[msgId][emoji] = [];
        const users = reactionStore[msgId][emoji];
        const idx = users.indexOf(user);
        if (idx === -1) users.push(user);
        else users.splice(idx, 1);
        if (users.length === 0) delete reactionStore[msgId][emoji];
        renderReactions(msgId);
        break;
      }

      case "room_members":
        updateParticipants(m.users);
        break;

      case "host_changed":
        currentHost = m.user;
        updateParticipants(null);
        appendSystem(`♛ ${m.user} is now the host`);
        break;

      case "kicked":
        wasKicked = true;
        ws.close();
        currentRoomCode = ""; currentUser = ""; currentHost = "";
        localStorage.removeItem("wr_user");
        localStorage.removeItem("wr_pass");
        document.cookie = "wr_token=; Max-Age=0; path=/";
        loginError.textContent = "you were kicked from the room.";
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
    if (timedOut || wasKicked) {
      wasKicked = false;
      return;
    }
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
  if (!pass) { loginError.textContent = "please enter a password."; return; }
  loginError.textContent = "";
  setLoginEnabled(false);
  ws.send(JSON.stringify({ type: "join", user: name, content: pass }));
}

function setLoginEnabled(enabled) {
  usernameInput.disabled = !enabled;
  passwordInput.disabled = !enabled;
  loginBtn.disabled = !enabled;
  if (enabled && !getCookie("wr_token")) usernameInput.focus();
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
  const m = Math.floor(s / 60).toString().padStart(2, "0");
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
createRoomBtn.addEventListener("click", () => {
  const pass = roomPasswordInput.value.trim();
  ws.send(JSON.stringify({ type: "create_room", password: pass }));
  roomPasswordInput.value = "";
});

joinRoomBtn.addEventListener("click", () => {
  joinError.textContent = ""; roomCodeInput.value = "";
  joinPasswordField.style.display = "none"; joinPasswordInput.value = "";
  roomCodeInput.disabled = false; submitRoomBtn.disabled = false;
  showScreen(joinScreen); roomCodeInput.focus();
});


backBtn.addEventListener("click", () => showScreen(roomScreen));

function tryJoinRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { joinError.textContent = "please enter a room code."; return; }
  const pass = joinPasswordInput.value.trim();
  joinError.textContent = ""; submitRoomBtn.disabled = true; roomCodeInput.disabled = true;
  ws.send(JSON.stringify({ type: "join_room", content: code, password: pass }));
}

submitRoomBtn.addEventListener("click", tryJoinRoom);
roomCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryJoinRoom(); });
joinPasswordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryJoinRoom(); });

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
  clearReply();
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

// ── History ──
function renderHistory(messages) {
  if (messages.length === 0) return;

  const sep = document.createElement("div");
  sep.className = "msg system";
  const sepBubble = document.createElement("div");
  sepBubble.className = "msg-bubble";
  sepBubble.textContent = "── last 24 hours ──";
  sep.appendChild(sepBubble);
  chatBody.appendChild(sep);

  messages.forEach(m => {
    const isSelf = m.user.toLowerCase() === currentUser.toLowerCase();
    appendMessage(m.user, m.content, isSelf, m.id, m.reply_to, m.reply_snip);
  });

  const sep2 = document.createElement("div");
  sep2.className = "msg system";
  const sep2Bubble = document.createElement("div");
  sep2Bubble.className = "msg-bubble";
  sep2Bubble.textContent = "── live ──";
  sep2.appendChild(sep2Bubble);
  chatBody.appendChild(sep2);

  chatBody.scrollTop = chatBody.scrollHeight;
}

// ── Participants ──
function updateParticipants(users) {
  if (users !== null) lastParticipants = users;
  const list = lastParticipants;

  participantCount.textContent = list.length;
  participantList.innerHTML = "";

  list.forEach(name => {
    const isSelf = name.toLowerCase() === currentUser.toLowerCase();
    const isHostUser = name.toLowerCase() === currentHost.toLowerCase();
    const canManage = isHost() && !isSelf;

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
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);
  contextMenu.style.left = left + "px";
  contextMenu.style.top = top + "px";
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

  const payload = { type: "message", content };
  if (replyTarget) {
    payload.reply_to = replyTarget.id;
  }
  ws.send(JSON.stringify(payload));

  msgInput.value = "";
  clearReply();
}
function setReply(id, user, content) {
  replyTarget = { id, user, content };
  replyPreview.classList.add("visible");
  replyPreviewText.textContent = `↩ ${user}: "${content.length > 60 ? content.slice(0, 60) + "…" : content}"`;
  msgInput.focus();
}

function clearReply() {
  replyTarget = null;
  replyPreview.classList.remove("visible");
  replyPreviewText.textContent = "";
}
function renderReactions(msgId) {
  const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrapper) return;
  let container = wrapper.querySelector(".msg-reactions");
  if (!container) {
    container = document.createElement("div");
    container.className = "msg-reactions";
    wrapper.appendChild(container);
  }
  container.innerHTML = "";
  const data = reactionStore[msgId] || {};
  for (const [emoji, users] of Object.entries(data)) {
    const pill = document.createElement("span");
    pill.className = "reaction-pill" + (users.includes(currentUser) ? " reacted" : "");
    pill.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="reaction-count">${users.length}</span>`;
    pill.addEventListener("click", () => {
      ws.send(JSON.stringify({ type: "reaction", content: emoji, reply_to: parseInt(msgId) }));
    });
    container.appendChild(pill);
  }
}

function openReactPicker(msgId, x, y) {
  reactTargetId = parseInt(msgId);
  emojiPickerContainer.classList.remove("visible");
  reactPickerContainer.style.left = Math.min(x, window.innerWidth - 340) + "px";
  reactPickerContainer.style.top = Math.max(10, y - 350) + "px";
  reactPickerContainer.classList.add("visible");
}
function appendMessage(user, content, isSelf, id, replyTo, replySnip) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg " + (isSelf ? "self" : "other");
  if (id) wrapper.dataset.msgId = id;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = isSelf ? "you" : user;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (replyTo && replySnip) {
    const quote = document.createElement("div");
    quote.className = "msg-reply-quote";
    quote.textContent = replySnip;
    quote.addEventListener("click", () => {
      const original = document.querySelector(`[data-msg-id="${replyTo}"]`);
      if (!original) return;
      original.scrollIntoView({ behavior: "smooth", block: "center" });
      original.classList.add("msg-highlight");
      setTimeout(() => original.classList.remove("msg-highlight"), 1500);
    });
    bubble.appendChild(quote);
  }

  const text = document.createElement("span");
  text.textContent = content;
  bubble.appendChild(text);

  wrapper.appendChild(meta);
  wrapper.appendChild(bubble);

  if (id) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "msg-reply-btn";
    replyBtn.textContent = "↩";
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setReply(id, user, content);
    });
    wrapper.appendChild(replyBtn);
  }
    if (id) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "msg-reply-btn";
    replyBtn.textContent = "↩";
    replyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setReply(id, user, content);
    });
    wrapper.appendChild(replyBtn);
  }

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
replyPreviewClose.addEventListener("click", clearReply);
chatBody.addEventListener("contextmenu", (e) => {
  const msgEl = e.target.closest(".msg[data-msg-id]");
  if (!msgEl) return;
  e.preventDefault();
  const id = parseInt(msgEl.dataset.msgId);
  const user = msgEl.querySelector(".msg-meta").textContent;
  const text = msgEl.querySelector(".msg-bubble span")?.textContent || "";
  setReply(id, user === "you" ? currentUser : user, text);
});
let touchStartX = 0;
let touchStartY = 0;
let touchTarget = null;

chatBody.addEventListener("touchstart", (e) => {
  const msgEl = e.target.closest(".msg[data-msg-id]");
  if (!msgEl) return;
  touchTarget = msgEl;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

chatBody.addEventListener("touchend", (e) => {
  if (!touchTarget) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);

  if (dx > 60 && dy < 40) {
    const id = parseInt(touchTarget.dataset.msgId);
    const user = touchTarget.querySelector(".msg-meta").textContent;
    const text = touchTarget.querySelector(".msg-bubble span")?.textContent || "";
    setReply(id, user === "you" ? currentUser : user, text);
  }

  touchTarget = null;
}, { passive: true });

// ── Init ──
// Only show login screen if not on pick_username flow
if (!new URLSearchParams(window.location.search).get("pick_username")) {
  connectWS();
}