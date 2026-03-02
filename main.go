package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	_ "github.com/lib/pq"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"
	"golang.org/x/oauth2/google"
)

var db *sql.DB
var (
	googleOAuthConfig *oauth2.Config
	githubOAuthConfig *oauth2.Config
	jwtSecret         []byte
)

// ── JWT ──
func generateToken(userID int, username string) (string, error) {
	claims := jwt.MapClaims{
		"user_id":  userID,
		"username": username,
		"exp":      time.Now().Add(30 * 24 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

func validateToken(tokenStr string) (int, string, error) {
	token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return 0, "", fmt.Errorf("invalid token")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return 0, "", fmt.Errorf("invalid claims")
	}
	userID := int(claims["user_id"].(float64))
	username, _ := claims["username"].(string)
	return userID, username, nil
}
func handleGoogleLogin(w http.ResponseWriter, r *http.Request) {
	url := googleOAuthConfig.AuthCodeURL("state", oauth2.AccessTypeOffline)
	http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}

func handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	token, err := googleOAuthConfig.Exchange(context.Background(), code)
	if err != nil {
		log.Println("Google token exchange error:", err)
		http.Error(w, "Failed to exchange token", http.StatusInternalServerError)
		return
	}

	client := googleOAuthConfig.Client(context.Background(), token)
	resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
	if err != nil {
		http.Error(w, "Failed to get user info", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	var info struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	json.NewDecoder(resp.Body).Decode(&info)

	// Upsert user
	var userID int
	var username sql.NullString
	err = db.QueryRow(
		`INSERT INTO users (google_id, avatar_url)
         VALUES ($1, $2)
         ON CONFLICT (google_id) DO UPDATE SET avatar_url = $2
         RETURNING id, username`,
		info.ID, info.Picture,
	).Scan(&userID, &username)
	if err != nil {
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}

	jwtToken, _ := generateToken(userID, username.String)
	http.SetCookie(w, &http.Cookie{
		Name:     "wr_token",
		Value:    jwtToken,
		Path:     "/",
		HttpOnly: false, // needs to be readable by JS
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 60 * 60,
	})

	if !username.Valid || username.String == "" {
		http.Redirect(w, r, "/?pick_username=1", http.StatusTemporaryRedirect)
	} else {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
	}
}
func handleGithubLogin(w http.ResponseWriter, r *http.Request) {
	url := githubOAuthConfig.AuthCodeURL("state", oauth2.AccessTypeOffline)
	http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}

func handleGithubCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	token, err := githubOAuthConfig.Exchange(context.Background(), code)
	if err != nil {
		log.Println("GitHub token exchange error:", err)
		http.Error(w, "Failed to exchange token", http.StatusInternalServerError)
		return
	}

	client := githubOAuthConfig.Client(context.Background(), token)
	resp, err := client.Get("https://api.github.com/user")
	if err != nil {
		http.Error(w, "Failed to get user info", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	var info struct {
		ID     int    `json:"id"`
		Login  string `json:"login"`
		Avatar string `json:"avatar_url"`
	}
	json.NewDecoder(resp.Body).Decode(&info)

	githubID := fmt.Sprintf("%d", info.ID)

	var userID int
	var username sql.NullString
	err = db.QueryRow(
		`INSERT INTO users (github_id, avatar_url)
         VALUES ($1, $2)
         ON CONFLICT (github_id) DO UPDATE SET avatar_url = $2
         RETURNING id, username`,
		githubID, info.Avatar,
	).Scan(&userID, &username)
	if err != nil {
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}

	jwtToken, _ := generateToken(userID, username.String)
	http.SetCookie(w, &http.Cookie{
		Name:     "wr_token",
		Value:    jwtToken,
		Path:     "/",
		HttpOnly: false,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 60 * 60,
	})

	if !username.Valid || username.String == "" {
		http.Redirect(w, r, "/?pick_username=1", http.StatusTemporaryRedirect)
	} else {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
	}
}

func initOAuth() {
	jwtSecret = []byte(os.Getenv("JWT_SECRET"))

	googleOAuthConfig = &oauth2.Config{
		ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		RedirectURL:  "https://wireroom.up.railway.app/auth/google/callback",
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint:     google.Endpoint,
	}

	githubOAuthConfig = &oauth2.Config{
		ClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		ClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		RedirectURL:  "https://wireroom.up.railway.app/auth/github/callback",
		Scopes:       []string{"user:email"},
		Endpoint:     github.Endpoint,
	}
}
func initDB() {
	connStr := os.Getenv("DATABASE_URL")
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal("failed to open db:", err)
	}
	if err = db.Ping(); err != nil {
		log.Fatal("failed to connect to db:", err)
	}
	log.Println("connected to database")
}

func registerUser(username, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO users (username, password) VALUES ($1, $2)", username, string(hash))
	return err
}

func authUser(username, password string) bool {
	var hash sql.NullString
	err := db.QueryRow(
		"SELECT password FROM users WHERE LOWER(username) = LOWER($1)", username,
	).Scan(&hash)
	if err != nil || !hash.Valid {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash.String), []byte(password)) == nil
}
func handleSetUsername(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cookie, err := r.Cookie("wr_token")
	if err != nil {
		http.Error(w, "not authenticated", http.StatusUnauthorized)
		return
	}

	userID, _, err := validateToken(cookie.Value)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	var body struct {
		Username string `json:"username"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	name, errmsg := validateUsername(body.Username)
	if errmsg != "" {
		http.Error(w, errmsg, http.StatusBadRequest)
		return
	}

	// Check not taken
	var existing int
	err = db.QueryRow("SELECT id FROM users WHERE LOWER(username) = LOWER($1)", name).Scan(&existing)
	if err == nil {
		http.Error(w, "username already taken", http.StatusConflict)
		return
	}

	_, err = db.Exec("UPDATE users SET username = $1 WHERE id = $2", name, userID)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	// Issue new token with username set
	newToken, _ := generateToken(userID, name)
	http.SetCookie(w, &http.Cookie{
		Name:     "wr_token",
		Value:    newToken,
		Path:     "/",
		HttpOnly: false,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 60 * 60,
	})

	w.WriteHeader(http.StatusOK)
}

func saveMessage(roomCode, username, content string) int64 {
	var id int64
	err := db.QueryRow(`INSERT INTO messages (room_code, username, "content") values ($1,$2,$3) RETURNING id`, roomCode, username, content).Scan(&id)
	if err != nil {
		log.Println("saveMessage error: ", err)
	}
	return id
}

func getRecentMessages(roomCode string) []Message {
	rows, err := db.Query(`SELECT id, username, "content" FROM messages WHERE room_code = $1 AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at ASC`, roomCode)
	if err != nil {
		log.Println("getRecentMessages error: ", err)
	}
	defer rows.Close()
	var msgs []Message
	for rows.Next() {
		var m Message
		err := rows.Scan(&m.ID, &m.User, &m.Content)
		if err != nil {
			continue
		}
		m.Type = "message"
		msgs = append(msgs, m)
	}
	return msgs
}

type Room struct {
	code    string
	clients map[*websocket.Conn]string
	host    *websocket.Conn
	mu      sync.Mutex
}
type Message struct {
	ID       int64     `json:"id,omitempty"`
	Type     string    `json:"type"`
	User     string    `json:"user"`
	Content  string    `json:"content"`
	Users    []string  `json:"users,omitempty"`
	Target   string    `json:"target,omitempty"`
	Messages []Message `json:"messages,omitempty"`
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

			if msg.Type == "auth" {
				// JWT auth from OAuth
				userID, username, err := validateToken(msg.Content)
				if err != nil {
					sendError("invalid session, please log in again", conn)
					continue
				}
				// Check if username is set
				if username == "" {
					sendError("please pick a username first", conn)
					continue
				}
				_ = userID
				uname = username
				break
			}

			if msg.Type != "join" {
				continue
			}

			// Password auth
			name, errmsg := validateUsername(msg.User)
			if errmsg != "" {
				sendError(errmsg, conn)
				continue
			}

			var existingHash sql.NullString
			err = db.QueryRow(
				"SELECT password FROM users WHERE LOWER(username) = LOWER($1)", name,
			).Scan(&existingHash)

			if err == sql.ErrNoRows {
				if regErr := registerUser(name, msg.Content); regErr != nil {
					sendError("could not register user", conn)
					continue
				}
			} else if err != nil {
				sendError("database error", conn)
				continue
			} else {
				if !existingHash.Valid {
					sendError("this account uses OAuth login", conn)
					continue
				}
				if !authUser(name, msg.Content) {
					sendError("incorrect password", conn)
					continue
				}
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

	history := getRecentMessages(room.code)
	conn.WriteJSON(Message{Type: "history", Messages: history})
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
			id := saveMessage(room.code, uname, content)
			room.broadcastAll(Message{Type: "message", Content: content, User: uname, ID: id})
		}
	}
}

func main() {
	initDB()
	initOAuth()
	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/auth/google", handleGoogleLogin)
	http.HandleFunc("/auth/google/callback", handleGoogleCallback)
	http.HandleFunc("/auth/github", handleGithubLogin)
	http.HandleFunc("/auth/github/callback", handleGithubCallback)
	http.HandleFunc("/auth/set-username", handleSetUsername)
	http.Handle("/", http.FileServer(http.Dir("public")))
	log.Println("Server running on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
