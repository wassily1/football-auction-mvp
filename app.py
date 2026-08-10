#!/usr/bin/env python3
"""Small internal football auction server using only the Python standard library."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "auction.db"
PLAYER_SEED = DATA_DIR / "players.json"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
AUCTION_STATE_LOCK = threading.RLock()
REALTIME_CONDITION = threading.Condition()
REALTIME_REVISION = 0
REALTIME_MUTATION_PATHS = {
    "/api/register",
    "/api/bid",
    "/api/team/name",
    "/api/admin/funds",
    "/api/admin/participant/release",
    "/api/admin/auction/queue",
    "/api/admin/auction/start",
}


class AppError(Exception):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return f"{salt.hex()}:{digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    salt_hex, expected = encoded.split(":", 1)
    actual = hash_password(password, bytes.fromhex(salt_hex)).split(":", 1)[1]
    return hmac.compare_digest(actual, expected)


def init_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = connect()
    try:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                funds INTEGER NOT NULL DEFAULT 0 CHECK (funds >= 0)
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'participant')),
                team_id INTEGER REFERENCES teams(id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS players (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auctions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL REFERENCES players(id),
                auction_type TEXT NOT NULL DEFAULT 'open' CHECK (auction_type IN ('open', 'sealed')),
                status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'sold', 'unsold', 'cancelled')),
                start_price INTEGER NOT NULL CHECK (start_price >= 0),
                min_increment INTEGER NOT NULL CHECK (min_increment > 0),
                duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 10 AND 3600),
                starts_at INTEGER,
                ends_at INTEGER,
                winner_team_id INTEGER REFERENCES teams(id),
                final_price INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
                team_id INTEGER NOT NULL REFERENCES teams(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                amount INTEGER NOT NULL CHECK (amount >= 0),
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS roster (
                team_id INTEGER NOT NULL REFERENCES teams(id),
                player_id TEXT NOT NULL REFERENCES players(id),
                lineup_role TEXT NOT NULL DEFAULT 'bench' CHECK (lineup_role IN ('starter', 'bench')),
                acquired_price INTEGER NOT NULL DEFAULT 0,
                acquired_at INTEGER NOT NULL,
                PRIMARY KEY (team_id, player_id),
                UNIQUE(player_id)
            );
            """
        )
        auction_columns = {row["name"] for row in db.execute("PRAGMA table_info(auctions)")}
        if "auction_type" not in auction_columns:
            db.execute(
                "ALTER TABLE auctions ADD COLUMN auction_type TEXT NOT NULL DEFAULT 'open'"
            )
        admin = db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if not admin:
            password = os.environ.get("AUCTION_ADMIN_PASSWORD", "admin123")
            db.execute(
                "INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')",
                ("admin", hash_password(password)),
            )
        players = json.loads(PLAYER_SEED.read_text(encoding="utf-8"))
        db.executemany(
            """
            INSERT INTO players(id, payload) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
            """,
            [(player["id"], json.dumps(player, ensure_ascii=False)) for player in players],
        )
        db.commit()
    finally:
        db.close()


def row_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None


def player_from_row(row: sqlite3.Row) -> dict:
    player = json.loads(row["payload"])
    if not player.get("photo_path"):
        player["photo_path"] = player.get("photo_source_url", "")
    return player


def publish_realtime_event() -> None:
    global REALTIME_REVISION
    with REALTIME_CONDITION:
        REALTIME_REVISION += 1
        REALTIME_CONDITION.notify_all()


def finish_expired_auction(db: sqlite3.Connection) -> bool:
    with AUCTION_STATE_LOCK:
        now = int(time.time())
        auction = db.execute(
            "SELECT * FROM auctions WHERE status = 'active' AND ends_at <= ? LIMIT 1", (now,)
        ).fetchone()
        if not auction:
            return False
        leader = db.execute(
            """
            SELECT b.team_id, b.amount
            FROM bids b
            WHERE b.auction_id = ?
            ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
            LIMIT 1
            """,
            (auction["id"],),
        ).fetchone()
        if not leader:
            db.execute("UPDATE auctions SET status = 'unsold' WHERE id = ?", (auction["id"],))
            db.commit()
            return True
        team = db.execute("SELECT funds FROM teams WHERE id = ?", (leader["team_id"],)).fetchone()
        if not team or team["funds"] < leader["amount"]:
            db.execute("UPDATE auctions SET status = 'unsold' WHERE id = ?", (auction["id"],))
            db.commit()
            return True
        db.execute(
            "UPDATE teams SET funds = funds - ? WHERE id = ?",
            (leader["amount"], leader["team_id"]),
        )
        db.execute(
            """
            INSERT INTO roster(team_id, player_id, acquired_price, acquired_at)
            VALUES (?, ?, ?, ?)
            """,
            (leader["team_id"], auction["player_id"], leader["amount"], now),
        )
        db.execute(
            """
            UPDATE auctions
            SET status = 'sold', winner_team_id = ?, final_price = ?
            WHERE id = ?
            """,
            (leader["team_id"], leader["amount"], auction["id"]),
        )
        db.commit()
        return True


def current_user(db: sqlite3.Connection, cookie_header: str | None) -> dict | None:
    if not cookie_header:
        return None
    cookie = SimpleCookie(cookie_header)
    token = cookie.get("session")
    if not token:
        return None
    row = db.execute(
        """
        SELECT u.id, u.username, u.role, u.team_id, t.name AS team_name, t.funds
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN teams t ON t.id = u.team_id
        WHERE s.token = ? AND s.expires_at > ?
        """,
        (token.value, int(time.time())),
    ).fetchone()
    return row_dict(row)


def require_user(user: dict | None) -> dict:
    if not user:
        raise AppError("请先登录", HTTPStatus.UNAUTHORIZED)
    return user


def require_admin(user: dict | None) -> dict:
    user = require_user(user)
    if user["role"] != "admin":
        raise AppError("仅管理员可以操作", HTTPStatus.FORBIDDEN)
    return user


class AuctionHandler(SimpleHTTPRequestHandler):
    server_version = "AuctionMVP/1.0"
    protocol_version = "HTTP/1.1"

    def translate_path(self, path: str) -> str:
        relative = urlparse(path).path.lstrip("/") or "index.html"
        destination = (STATIC_DIR / relative).resolve()
        if not destination.is_relative_to(STATIC_DIR.resolve()):
            return str(STATIC_DIR / "not-found")
        return str(destination)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload: object, status: int = HTTPStatus.OK, cookie: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            raise AppError("请求格式错误") from exc

    def dispatch(self, method: str) -> None:
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            if method != "GET":
                self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
                return
            super().do_GET()
            return
        db = connect()
        try:
            with db:
                if finish_expired_auction(db):
                    publish_realtime_event()
                user = current_user(db, self.headers.get("Cookie"))
                handler = getattr(self, f"api_{method.lower()}_{path[5:].replace('/', '_').strip('_')}", None)
                if not handler:
                    raise AppError("接口不存在", HTTPStatus.NOT_FOUND)
                handler(db, user)
            if method == "POST" and path in REALTIME_MUTATION_PATHS:
                publish_realtime_event()
        except AppError as exc:
            self.send_json({"error": str(exc)}, exc.status)
        except sqlite3.IntegrityError as exc:
            self.send_json({"error": "数据冲突，请刷新后重试"}, HTTPStatus.CONFLICT)
            self.log_error("database integrity error: %s", exc)
        except Exception as exc:
            self.send_json({"error": "服务器暂时无法完成操作"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            self.log_error("unhandled error: %s", exc)
        finally:
            db.close()

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def api_post_register(self, db: sqlite3.Connection, user: dict | None) -> None:
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        team_name = str(data.get("team_name", "")).strip()
        if len(username) < 2 or len(password) < 4 or len(team_name) < 2:
            raise AppError("用户名和球队名至少 2 个字符，密码至少 4 个字符")
        cursor = db.execute("INSERT INTO teams(name) VALUES (?)", (team_name,))
        team_id = cursor.lastrowid
        db.execute(
            "INSERT INTO users(username, password_hash, role, team_id) VALUES (?, ?, 'participant', ?)",
            (username, hash_password(password), team_id),
        )
        self.send_json({"ok": True}, HTTPStatus.CREATED)

    def api_post_login(self, db: sqlite3.Connection, user: dict | None) -> None:
        data = self.read_json()
        row = db.execute(
            "SELECT * FROM users WHERE username = ?", (str(data.get("username", "")).strip(),)
        ).fetchone()
        if not row or not verify_password(str(data.get("password", "")), row["password_hash"]):
            raise AppError("用户名或密码错误", HTTPStatus.UNAUTHORIZED)
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + SESSION_TTL_SECONDS
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        db.execute(
            "INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, row["id"], expires_at),
        )
        self.send_json(
            {"ok": True},
            cookie=f"session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}",
        )

    def api_post_logout(self, db: sqlite3.Connection, user: dict | None) -> None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        token = cookie.get("session")
        if token:
            db.execute("DELETE FROM sessions WHERE token = ?", (token.value,))
        self.send_json({"ok": True}, cookie="session=; Path=/; HttpOnly; Max-Age=0")

    def api_get_me(self, db: sqlite3.Connection, user: dict | None) -> None:
        self.send_json({"user": user})

    def api_get_players(self, db: sqlite3.Connection, user: dict | None) -> None:
        query = parse_qs(urlparse(self.path).query)
        search = query.get("search", [""])[0].strip().lower()
        position = query.get("position", [""])[0].strip().upper()
        rows = db.execute(
            """
            SELECT p.payload,
                   CASE WHEN r.player_id IS NULL THEN 0 ELSE 1 END AS owned,
                   t.name AS team_name
            FROM players p
            LEFT JOIN roster r ON r.player_id = p.id
            LEFT JOIN teams t ON t.id = r.team_id
            ORDER BY CAST(json_extract(p.payload, '$.overall') AS INTEGER) DESC,
                     json_extract(p.payload, '$.name_zh')
            """
        ).fetchall()
        players = []
        for row in rows:
            player = player_from_row(row)
            if search and search not in f'{player["name_zh"]} {player["name_en"]}'.lower():
                continue
            positions = [player["primary_position"], *player["secondary_positions"]]
            if position and position not in positions:
                continue
            player["owned"] = bool(row["owned"])
            player["team_name"] = row["team_name"]
            players.append(player)
        self.send_json({"players": players})

    def api_get_events(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_user(user)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        revision = -1
        try:
            while True:
                with REALTIME_CONDITION:
                    if revision == REALTIME_REVISION:
                        REALTIME_CONDITION.wait(timeout=15)
                    current_revision = REALTIME_REVISION
                if current_revision == revision:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    payload = json.dumps({"revision": current_revision}).encode()
                    self.wfile.write(b"data: " + payload + b"\n\n")
                    revision = current_revision
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def api_get_auction(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_user(user)
        active = db.execute(
            """
            SELECT a.*, p.payload, t.name AS winner_team_name
            FROM auctions a
            JOIN players p ON p.id = a.player_id
            LEFT JOIN teams t ON t.id = a.winner_team_id
            WHERE a.status = 'active'
            ORDER BY a.id DESC LIMIT 1
            """
        ).fetchone()
        active_payload = None
        if active:
            active_payload = dict(active)
            active_payload["player"] = player_from_row(active)
            del active_payload["payload"]
            bids = [
                dict(row)
                for row in db.execute(
                    """
                    SELECT b.amount, b.created_at, t.id AS team_id, t.name AS team_name,
                           u.username
                    FROM bids b
                    JOIN teams t ON t.id = b.team_id
                    JOIN users u ON u.id = b.user_id
                    WHERE b.auction_id = ?
                    ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
                    """,
                    (active["id"],),
                )
            ]
            active_payload["bid_count"] = len({bid["team_id"] for bid in bids})
            active_payload["has_bid"] = bool(
                user
                and user.get("team_id")
                and any(bid["team_id"] == user["team_id"] for bid in bids)
            )
            active_payload["bids"] = [] if active["auction_type"] == "sealed" else bids
        queued = []
        for row in db.execute(
            """
            SELECT a.*, p.payload FROM auctions a
            JOIN players p ON p.id = a.player_id
            WHERE a.status = 'queued' ORDER BY a.id
            """
        ):
            item = dict(row)
            item["player"] = player_from_row(row)
            del item["payload"]
            queued.append(item)
        recent = [
            {**dict(row), "player": player_from_row(row)}
            for row in db.execute(
                """
                SELECT a.*, p.payload, t.name AS winner_team_name
                FROM auctions a JOIN players p ON p.id = a.player_id
                LEFT JOIN teams t ON t.id = a.winner_team_id
                WHERE a.status IN ('sold', 'unsold') ORDER BY a.id DESC LIMIT 8
                """
            )
        ]
        for item in recent:
            item.pop("payload", None)
        teams = [
            dict(row)
            for row in db.execute("SELECT id, name, funds FROM teams ORDER BY id")
        ]
        self.send_json(
            {
                "active": active_payload,
                "queued": queued,
                "recent": recent,
                "teams": teams,
                "server_time": int(time.time()),
            }
        )

    def api_post_bid(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user["team_id"]:
            raise AppError("当前账号没有参与球队", HTTPStatus.FORBIDDEN)
        data = self.read_json()
        try:
            amount = int(str(data.get("amount", 0)))
        except (TypeError, ValueError) as exc:
            raise AppError("报价必须是整数金额") from exc
        if amount <= 0:
            raise AppError("报价必须大于零")
        with AUCTION_STATE_LOCK:
            now = int(time.time())
            auction = db.execute("SELECT * FROM auctions WHERE status = 'active' LIMIT 1").fetchone()
            if not auction:
                raise AppError("当前没有可报价的竞拍", HTTPStatus.CONFLICT)
            if auction["starts_at"] is None or auction["ends_at"] is None or not (
                auction["starts_at"] <= now < auction["ends_at"]
            ):
                raise AppError("本轮竞拍已结束，报价未受理", HTTPStatus.CONFLICT)
            existing = db.execute(
                "SELECT 1 FROM bids WHERE auction_id = ? AND team_id = ? LIMIT 1",
                (auction["id"], user["team_id"]),
            ).fetchone()
            if auction["auction_type"] == "sealed" and existing:
                raise AppError("暗拍每支球队只能出价一次", HTTPStatus.CONFLICT)
            top = db.execute(
                """
                SELECT team_id, amount FROM bids
                WHERE auction_id = ?
                ORDER BY amount DESC, created_at ASC, id ASC
                LIMIT 1
                """,
                (auction["id"],),
            ).fetchone()
            if auction["auction_type"] == "open" and top and top["team_id"] == user["team_id"]:
                raise AppError("你已经是当前最高报价方，不能继续自我加价", HTTPStatus.CONFLICT)
            minimum = auction["start_price"]
            if auction["auction_type"] == "open" and top:
                minimum = top["amount"] + auction["min_increment"]
            if amount < minimum:
                raise AppError(f"当前最低有效报价为 {minimum} 万")
            team = db.execute("SELECT funds FROM teams WHERE id = ?", (user["team_id"],)).fetchone()
            if not team:
                raise AppError("参与球队不存在", HTTPStatus.FORBIDDEN)
            if amount > team["funds"]:
                raise AppError("可用资金不足")
            db.execute(
                "INSERT INTO bids(auction_id, team_id, user_id, amount, created_at) VALUES (?, ?, ?, ?, ?)",
                (auction["id"], user["team_id"], user["id"], amount, now),
            )
            ends_at = now + auction["duration_seconds"]
            db.execute("UPDATE auctions SET ends_at = ? WHERE id = ?", (ends_at, auction["id"]))
            db.commit()
        self.send_json({"ok": True, "amount": amount, "ends_at": ends_at}, HTTPStatus.CREATED)

    def api_post_team_name(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user.get("team_id"):
            raise AppError("当前账号没有参与球队", HTTPStatus.FORBIDDEN)
        name = str(self.read_json().get("name", "")).strip()
        if len(name) < 2 or len(name) > 30:
            raise AppError("球队名需要 2–30 个字符")
        db.execute("UPDATE teams SET name = ? WHERE id = ?", (name, user["team_id"]))
        self.send_json({"ok": True, "name": name})

    def api_get_roster(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        query = parse_qs(urlparse(self.path).query)
        team_id = int(query.get("team_id", [user.get("team_id") or 0])[0])
        if user["role"] != "admin" and team_id != user["team_id"]:
            raise AppError("只能查看自己的球队", HTTPStatus.FORBIDDEN)
        team = db.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        if not team:
            raise AppError("球队不存在", HTTPStatus.NOT_FOUND)
        roster = []
        for row in db.execute(
            """
            SELECT r.*, p.payload FROM roster r JOIN players p ON p.id = r.player_id
            WHERE r.team_id = ? ORDER BY r.lineup_role DESC, r.acquired_at
            """,
            (team_id,),
        ):
            item = dict(row)
            item["player"] = player_from_row(row)
            item.pop("payload")
            roster.append(item)
        self.send_json({"team": dict(team), "roster": roster})

    def api_post_lineup_toggle(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if not user.get("team_id"):
            raise AppError("当前账号没有球队")
        player_id = str(self.read_json().get("player_id", ""))
        row = db.execute(
            "SELECT lineup_role FROM roster WHERE team_id = ? AND player_id = ?",
            (user["team_id"], player_id),
        ).fetchone()
        if not row:
            raise AppError("该球员不在你的球队")
        target = "bench" if row["lineup_role"] == "starter" else "starter"
        if target == "starter":
            count = db.execute(
                "SELECT COUNT(*) AS count FROM roster WHERE team_id = ? AND lineup_role = 'starter'",
                (user["team_id"],),
            ).fetchone()["count"]
            if count >= 11:
                raise AppError("首发最多 11 人，请先移下一名球员")
        db.execute(
            "UPDATE roster SET lineup_role = ? WHERE team_id = ? AND player_id = ?",
            (target, user["team_id"], player_id),
        )
        self.send_json({"ok": True, "lineup_role": target})

    def api_get_admin_teams(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        teams = [
            dict(row)
            for row in db.execute(
                """
                SELECT t.*, u.id AS participant_user_id, u.username
                FROM teams t
                LEFT JOIN users u ON u.team_id = t.id AND u.role = 'participant'
                ORDER BY t.id
                """
            )
        ]
        self.send_json({"teams": teams})

    def api_post_admin_participant_release(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        team_id = int(self.read_json().get("team_id", 0))
        participant = db.execute(
            "SELECT id, username FROM users WHERE role = 'participant' AND team_id = ?",
            (team_id,),
        ).fetchone()
        if not participant:
            raise AppError("该球队没有可释放的参与者账号", HTTPStatus.NOT_FOUND)
        released_username = f"released-{participant['id']}-{int(time.time())}-{participant['username']}"
        db.execute("DELETE FROM sessions WHERE user_id = ?", (participant["id"],))
        db.execute(
            "UPDATE users SET username = ?, team_id = NULL WHERE id = ?",
            (released_username, participant["id"]),
        )
        self.send_json({"ok": True})

    def api_post_admin_funds(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        data = self.read_json()
        team_id = int(data.get("team_id", 0))
        funds = int(data.get("funds", -1))
        if funds < 0:
            raise AppError("资金不能小于零")
        with AUCTION_STATE_LOCK:
            leader = db.execute(
                """
                SELECT MAX(b.amount) AS amount FROM bids b
                JOIN auctions a ON a.id = b.auction_id AND a.status = 'active'
                WHERE b.team_id = ?
                """,
                (team_id,),
            ).fetchone()["amount"]
            if leader is not None:
                top = db.execute(
                    """
                    SELECT MAX(b.amount) AS amount FROM bids b
                    JOIN auctions a ON a.id = b.auction_id AND a.status = 'active'
                    """
                ).fetchone()["amount"]
                if leader == top and funds < leader:
                    raise AppError("该球队是当前最高报价方，资金不能低于其报价")
            updated = db.execute("UPDATE teams SET funds = ? WHERE id = ?", (funds, team_id))
            if not updated.rowcount:
                raise AppError("球队不存在", HTTPStatus.NOT_FOUND)
            db.commit()
        self.send_json({"ok": True, "funds": funds})

    def api_post_admin_auction_queue(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        data = self.read_json()
        player_id = str(data.get("player_id", ""))
        if db.execute("SELECT 1 FROM roster WHERE player_id = ?", (player_id,)).fetchone():
            raise AppError("该球员已经属于某支球队")
        if db.execute(
            "SELECT 1 FROM auctions WHERE player_id = ? AND status IN ('queued', 'active')", (player_id,)
        ).fetchone():
            raise AppError("该球员已经在拍卖池中")
        auction_type = str(data.get("auction_type", "open"))
        if auction_type not in {"open", "sealed"}:
            raise AppError("竞拍方式无效")
        values = (
            player_id,
            auction_type,
            int(data.get("start_price", 0)),
            int(data.get("min_increment", 10)),
            int(data.get("duration_seconds", 60)),
            int(time.time()),
        )
        db.execute(
            """
            INSERT INTO auctions(player_id, auction_type, status, start_price, min_increment, duration_seconds, created_at)
            VALUES (?, ?, 'queued', ?, ?, ?, ?)
            """,
            values,
        )
        self.send_json({"ok": True}, HTTPStatus.CREATED)

    def api_post_admin_auction_start(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        auction_id = int(self.read_json().get("auction_id", 0))
        with AUCTION_STATE_LOCK:
            if db.execute("SELECT 1 FROM auctions WHERE status = 'active'").fetchone():
                raise AppError("已有一场竞拍正在进行", HTTPStatus.CONFLICT)
            auction = db.execute(
                "SELECT * FROM auctions WHERE id = ? AND status = 'queued'", (auction_id,)
            ).fetchone()
            if not auction:
                raise AppError("拍卖池中没有该竞拍")
            now = int(time.time())
            db.execute(
                "UPDATE auctions SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?",
                (now, now + auction["duration_seconds"], auction_id),
            )
            db.commit()
        self.send_json({"ok": True, "ends_at": now + auction["duration_seconds"]})

def main() -> None:
    init_database()
    host = os.environ.get("AUCTION_HOST", "0.0.0.0")
    port = int(os.environ.get("AUCTION_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), AuctionHandler)
    print(f"Football auction MVP: http://127.0.0.1:{port}")
    print("Default admin: admin / admin123 (override with AUCTION_ADMIN_PASSWORD)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
