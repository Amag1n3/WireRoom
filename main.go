package main

import (
	"log"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"unicode"

	"github.com/gorilla/websocket"
)

type Room struct {
	code    string
	clients map[*websocket.Conn]string
	host    *websocket.Conn
	mu      sync.Mutex
}
type Message struct {
	Type    string   `json:"type"`
	User    string   `json:"user"`
	Content string   `json:"content"`
	Users   []string `json:"users,omitempty"`
	Target  string   `json:"target,omitempty"`
}

var (
	rooms    = make(map[string]*Room)
	roomsMu  sync.Mutex
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
)

const codeChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@$%^*"

func generateRoomCode() string {
	code := make([]byte, 8)
	for i := range code {
		code[i] = codeChars[rand.Intn(len(codeChars))]
	}
	return string(code)
}
func isUsernameTakenInRoom(room *Room, name string) bool {
	for _, existing := range room.clients {
		if strings.EqualFold(name, existing) {
			return true
		}
	}
	return false
}
func createRoom() *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	var code string
	for {
		code = generateRoomCode()
		if _, exists := rooms[code]; !exists {
			break
		}
	}

	room := &Room{
		code:    code,
		clients: make(map[*websocket.Conn]string),
		host:    nil,
	}
	rooms[code] = room
	return room
}
func joinRoom(code string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	return rooms[code]
}
func (r *Room) memberList() []string {
	names := make([]string, 0, len(r.clients))
	for _, name := range r.clients {
		names = append(names, name)
	}
	return names
}
func (r *Room) broadcastAll(msg Message) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for client := range r.clients {
		client.WriteJSON(msg)
	}
}
func (r *Room) connForUser(name string) *websocket.Conn {
	for conn, n := range r.clients {
		if strings.EqualFold(n, name) {
			return conn
		}
	}
	return nil
}

func (r *Room) pickNewHost(exclude *websocket.Conn) *websocket.Conn {
	for conn := range r.clients {
		if conn != exclude {
			return conn
		}
	}
	return nil
}

const (
	maxUsernameLen = 20
	maxMessageLen  = 500
)

func validateUsername(raw string) (string, string) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", "username cannot be empty"
	}
	if len(name) > maxUsernameLen {
		return "", "username too long (max 20 characters)"
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' {
			return "", "username can only have letters, digits, _ or -"
		}
	}
	return name, ""
}

func (r *Room) broadcastLocked(sender *websocket.Conn, msg Message) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for client := range r.clients {
		if client != sender {
			client.WriteJSON(msg)
		}
	}
}

func sendError(reason string, conn *websocket.Conn) {
	conn.WriteJSON(Message{
		Type:    "error",
		Content: reason,
	})
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxMessageLen * 5)
	var room *Room
	var uname string
outer:
	for {
		for {
			var msg Message
			err := conn.ReadJSON(&msg)
			if err != nil {
				return
			}

			if msg.Type != "join" {
				continue
			}

			name, errmsg := validateUsername(msg.User)
			if errmsg != "" {
				sendError(errmsg, conn)
				continue
			}

			uname = name
			break
		}
		conn.WriteJSON(Message{Type: "join_ok", Content: "Welcome, " + uname + "!"})

		for {
			var msg Message
			err := conn.ReadJSON(&msg)
			if err != nil {
				return
			}
			switch msg.Type {
			case "create_room":
				room = createRoom()
				conn.WriteJSON(Message{Type: "room_created", Content: room.code})
			case "join_room":
				room = joinRoom(msg.Content)
				if room == nil {
					sendError("Invalid room code", conn)
					continue
				}
				room.mu.Lock()
				taken := isUsernameTakenInRoom(room, uname)
				room.mu.Unlock()
				if taken {
					conn.WriteJSON(Message{Type: "username_taken_in_room", Content: "that username is already taken in this room"})
					room = nil
					continue outer
				}
				conn.WriteJSON(Message{Type: "room_joined", Content: room.code})

			default:
				continue

			}
			break
		}
		break outer
	}

	room.mu.Lock()
	room.clients[conn] = uname
	if room.host == nil {
		room.host = conn
	}
	members := room.memberList()
	host := room.clients[room.host]
	room.mu.Unlock()
	room.broadcastAll(Message{Type: "room_members", Users: members})
	conn.WriteJSON(Message{Type: "host_changed", User: host})
	defer func() {
		room.mu.Lock()
		delete(room.clients, conn)
		empty := len(room.clients) == 0
		if !empty && room.host == conn {
			room.host = room.pickNewHost(conn)
			newHost := room.clients[room.host]
			members := room.memberList()
			room.mu.Unlock()
			room.broadcastLocked(conn, Message{Type: "system", Content: uname + " left the room"})
			room.broadcastAll(Message{Type: "host_changed", User: newHost})
			room.broadcastAll(Message{Type: "room_members", Users: members})
		} else {
			members := room.memberList()
			room.mu.Unlock()
			room.broadcastLocked(conn, Message{Type: "system", Content: uname + " left the room"})
			if !empty {
				room.broadcastAll(Message{Type: "room_members", Users: members})
			}
		}
		if empty {
			roomsMu.Lock()
			delete(rooms, room.code)
			roomsMu.Unlock()
		}
	}()

	room.broadcastLocked(conn, Message{Type: "system", Content: uname + " joined the room"})

	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}

		switch msg.Type {
		case "typing":
			room.broadcastLocked(conn, Message{Type: "typing", User: uname, Content: msg.Content})
		case "kick":
			room.mu.Lock()
			isHost := room.host == conn
			target := room.connForUser(msg.Target)
			room.mu.Unlock()

			if !isHost || target == nil {
				continue
			}
			target.WriteJSON(Message{Type: "kicked", Content: "you were kicked by the host"})
			target.Close()

		case "transfer_host":
			room.mu.Lock()
			isHost := room.host == conn
			target := room.connForUser(msg.Target)
			if isHost && target != nil {
				room.host = target
			}
			newHost := room.clients[room.host]
			room.mu.Unlock()

			if !isHost || target == nil {
				continue
			}
			room.broadcastAll(Message{Type: "host_changed", User: newHost})
		default:
			content := strings.TrimSpace(msg.Content)
			if content == "" {
				continue
			}
			if len(content) > maxMessageLen {
				sendError("Message too long (max 500 characters)", conn)
				continue
			}
			room.broadcastLocked(conn, Message{Type: "message", Content: content, User: uname})
		}
	}
}

func main() {
	http.HandleFunc("/ws", wsHandler)
	http.Handle("/", http.FileServer(http.Dir("public")))

	log.Println("Server running on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
