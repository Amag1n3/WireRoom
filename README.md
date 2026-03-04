# WireRoom

> Real-time, room-based chat — built with Go, WebSockets, and PostgreSQL.

`[screenshot: login screen showing Google/GitHub OAuth buttons and password login]`

**Live demo:** [wireroom.up.railway.app](https://wireroom.up.railway.app)

---

## Overview

WireRoom is a full-stack real-time chat application built from scratch. Users authenticate via Google, GitHub, or a username/password, then create or join private rooms using shareable 8-character codes. Every interaction — messages, typing indicators, reactions, participant updates — is delivered instantly over persistent WebSocket connections.

The backend is written in Go and handles concurrent rooms using goroutines and mutexes. There are no third-party real-time services — the WebSocket server is hand-rolled.

---

## Features

**Authentication**
- Google and GitHub OAuth 2.0 with state parameter CSRF protection
- Username/password fallback with bcrypt hashing
- JWT-based sessions stored in HTTP-only cookies with 30-day expiry
- Auto-login on page refresh via persisted session token

**Rooms**
- Create private rooms with randomly generated 8-character codes
- Optional room password set at creation — joiners are prompted if required
- Join any room by code — shareable via one-click copy
- Per-room username uniqueness enforced at the server
- Host role with crown indicator — automatically transferred if host leaves

**Chat**
- Message history: last 24 hours loaded on join, separated from live messages
- Real-time typing indicators with multi-user support ("alice and bob are typing...")
- Emoji reactions on messages — toggle on/off, live count shown as pills
- 500 character message limit enforced server-side

**Host Controls**
- Kick participants — kicked users are redirected immediately with a notification
- Transfer host role to any participant via right-click context menu

`[screenshot: participant sidebar showing host crown, right-click context menu with Make Host and Kick options]`

`[screenshot: chat room showing message bubbles, typing indicator, participant sidebar, and emoji reaction pills]`

---

## Architecture

```
┌─────────────┐     HTTPS/WSS      ┌──────────────────────┐
│   Browser   │ ◄────────────────► │   Go HTTP Server     │
│  HTML/CSS/JS│                    │   (net/http)         │
└─────────────┘                    │                      │
                                   │  ┌────────────────┐  │
                                   │  │  WS Handler    │  │
                                   │  │  goroutine     │  │
                                   │  │  per client    │  │
                                   │  └───────┬────────┘  │
                                   │          │            │
                                   │  ┌───────▼────────┐  │
                                   │  │  Room Registry │  │
                                   │  │  sync.Mutex    │  │
                                   │  └───────┬────────┘  │
                                   └──────────┼───────────┘
                                              │
                                   ┌──────────▼───────────┐
                                   │   PostgreSQL          │
                                   │   (Supabase)          │
                                   │                       │
                                   │   users               │
                                   │   messages            │
                                   └───────────────────────┘
```

**Concurrency model:** Each WebSocket connection runs in its own goroutine. Shared room state (client map, host pointer, member list) is protected by a `sync.Mutex`. Broadcasts iterate the client map under the lock and write to each connection.

**Message flow:**
1. Client sends `{type: "message", content: "..."}` over WS
2. Server saves to PostgreSQL, gets back the row ID
3. Server broadcasts `{type: "message", id: X, user: "...", content: "..."}` to all room members including sender
4. Frontend renders on receipt — no optimistic UI, single source of truth

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Go 1.25, `gorilla/websocket` |
| Auth | OAuth 2.0 (`golang.org/x/oauth2`), bcrypt, JWT (`golang-jwt/jwt`) |
| Database | PostgreSQL via Supabase (`lib/pq`) |
| Frontend | Vanilla HTML, CSS, JavaScript — no framework |
| Deployment | Railway (backend), Supabase (database) |

---

## Database Schema

```sql
CREATE TABLE users (
    id         SERIAL PRIMARY KEY,
    username   TEXT UNIQUE,
    password   TEXT,                    -- bcrypt hash, nullable for OAuth users
    google_id  TEXT UNIQUE,
    github_id  TEXT UNIQUE,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
    id         BIGSERIAL PRIMARY KEY,
    room_code  TEXT NOT NULL,
    username   TEXT NOT NULL,
    "content"  TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_room_created ON messages(room_code, created_at);
```

---

## Running Locally

**Prerequisites:** Go 1.20+, a PostgreSQL database (Supabase free tier works)

```bash
git clone https://github.com/Amag1n3/WireRoom
cd WireRoom
go mod download
```

Create a `.env` or set environment variables:

```bash
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres?sslmode=require
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
JWT_SECRET=your-long-random-secret
```

Run the schema from `schema.sql` against your database, then:

```bash
go run main.go
```

Open [http://localhost:8080](http://localhost:8080).

> For local OAuth, set redirect URIs to `http://localhost:8080/auth/google/callback` and `http://localhost:8080/auth/github/callback` in your OAuth app settings.

---

## Project Structure

```
WireRoom/
├── main.go          # Server, WebSocket handler, auth, DB, OAuth
├── go.mod
├── go.sum
└── public/
    ├── index.html   # App shell and screen templates
    ├── style.css    # Design system and component styles
    └── app.js       # WebSocket client, state management, UI logic
```

---

## Security Considerations

- Passwords are hashed with bcrypt (cost factor 10) — plaintext never stored or logged
- OAuth state parameter validated via cookie to prevent CSRF
- JWT tokens are signed with HS256 and expire after 30 days
- SSL enforced on all database connections
- Login lockout after 5 failed attempts with a 2-minute cooldown

---

## Roadmap

- [ ] Message delete (own messages; host can delete any)
- [ ] Reply to specific messages
- [ ] Mobile responsive layout
- [ ] Rate limiting on message sends
- [ ] Persistent emoji reactions (currently in-memory per session)
- [x] Room passwords

---

## Author

Built by Amogh — open to internship and junior engineering opportunities.

[![GitHub](https://img.shields.io/badge/GitHub-Amag1n3-181717?style=flat&logo=github)](https://github.com/Amag1n3)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-amag1n3-0A66C2?style=flat&logo=linkedin)](https://www.linkedin.com/in/amag1n3/)
[![Email](https://img.shields.io/badge/Email-amoghtyagi22092005@gmail.com-EA4335?style=flat&logo=gmail)](mailto:amoghtyagi22092005@gmail.com)
