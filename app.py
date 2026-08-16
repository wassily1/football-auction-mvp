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
    "/api/admin/player/release",
    "/api/trade/create",
    "/api/trade/respond",
    "/api/trade/cancel",
    "/api/admin/match/save",
    "/api/admin/match/delete",
    "/api/admin/match/stats/save",
    "/api/admin/auction/queue",
    "/api/admin/auction/start",
    "/api/admin/auction/settle",
    "/api/admin/auction/withdraw",
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
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_team_id INTEGER NOT NULL REFERENCES teams(id),
                status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rejected', 'cancelled', 'invalid')),
                created_at INTEGER NOT NULL,
                resolved_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS trade_participants (
                trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
                team_id INTEGER NOT NULL REFERENCES teams(id),
                response TEXT NOT NULL CHECK (response IN ('pending', 'accepted', 'rejected')),
                responded_at INTEGER,
                PRIMARY KEY (trade_id, team_id)
            );
            CREATE TABLE IF NOT EXISTS trade_legs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
                from_team_id INTEGER NOT NULL REFERENCES teams(id),
                to_team_id INTEGER NOT NULL REFERENCES teams(id),
                cash_amount INTEGER NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
                UNIQUE (trade_id, from_team_id)
            );
            CREATE TABLE IF NOT EXISTS trade_players (
                trade_leg_id INTEGER NOT NULL REFERENCES trade_legs(id) ON DELETE CASCADE,
                player_id TEXT NOT NULL REFERENCES players(id),
                acquired_price INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (trade_leg_id, player_id)
            );
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stage TEXT NOT NULL CHECK (stage IN ('group', 'knockout')),
                group_name TEXT,
                round_name TEXT NOT NULL,
                home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                home_team_name TEXT NOT NULL,
                away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                away_team_name TEXT NOT NULL,
                home_score INTEGER CHECK (home_score >= 0),
                away_score INTEGER CHECK (away_score >= 0),
                home_penalties INTEGER CHECK (home_penalties >= 0),
                away_penalties INTEGER CHECK (away_penalties >= 0),
                played_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS match_player_stats (
                match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
                player_id TEXT NOT NULL REFERENCES players(id),
                player_name TEXT NOT NULL,
                team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                team_name TEXT NOT NULL,
                goals INTEGER NOT NULL DEFAULT 0 CHECK (goals BETWEEN 0 AND 99),
                assists INTEGER NOT NULL DEFAULT 0 CHECK (assists BETWEEN 0 AND 99),
                PRIMARY KEY (match_id, player_id)
            );
            """
        )
        auction_columns = {row["name"] for row in db.execute("PRAGMA table_info(auctions)")}
        if "auction_type" not in auction_columns:
            db.execute(
                "ALTER TABLE auctions ADD COLUMN auction_type TEXT NOT NULL DEFAULT 'open'"
            )
        db.execute(
            """
            DELETE FROM bids
            WHERE user_id IN (
                SELECT id FROM users
                WHERE role = 'participant' AND team_id IS NULL AND username LIKE 'released-%'
            )
            """
        )
        db.execute(
            """
            DELETE FROM users
            WHERE role = 'participant' AND team_id IS NULL AND username LIKE 'released-%'
            """
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


def auction_bids(db: sqlite3.Connection, auction_id: int) -> list[dict]:
    return [
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
            (auction_id,),
        )
    ]


def completed_auction_payload(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    item = dict(row)
    item["player"] = player_from_row(row)
    item.pop("payload", None)
    item["bids"] = auction_bids(db, row["id"])
    item["bid_count"] = len({bid["team_id"] for bid in item["bids"]})
    return item


def match_payloads(db: sqlite3.Connection) -> list[dict]:
    matches = [
        dict(row)
        for row in db.execute(
            """
            SELECT m.id, m.stage, m.group_name, m.round_name,
                   m.home_team_id, COALESCE(home.name, m.home_team_name) AS home_team_name,
                   m.away_team_id, COALESCE(away.name, m.away_team_name) AS away_team_name,
                   m.home_score, m.away_score, m.home_penalties, m.away_penalties,
                   m.played_at, m.created_at, m.updated_at
            FROM matches m
            LEFT JOIN teams home ON home.id = m.home_team_id
            LEFT JOIN teams away ON away.id = m.away_team_id
            ORDER BY m.stage = 'knockout', COALESCE(m.group_name, ''),
                     COALESCE(m.played_at, m.created_at), m.id
            """
        )
    ]
    for match in matches:
        match["player_stats"] = []
        for row in db.execute(
            """
            SELECT s.player_id, s.player_name, s.team_id, s.team_name,
                   s.goals, s.assists, p.payload
            FROM match_player_stats s
            JOIN players p ON p.id = s.player_id
            WHERE s.match_id = ?
            ORDER BY s.goals DESC, s.assists DESC, s.player_name
            """,
            (match["id"],),
        ):
            item = dict(row)
            item["player"] = player_from_row(row)
            item.pop("payload")
            match["player_stats"].append(item)
    return matches


def player_stat_leaders(matches: list[dict]) -> dict:
    totals: dict[str, dict] = {}
    for match in matches:
        for stat in match["player_stats"]:
            player = totals.setdefault(
                stat["player_id"],
                {
                    "player_id": stat["player_id"],
                    "player_name": stat["player_name"],
                    "team_name": stat["team_name"],
                    "goals": 0,
                    "assists": 0,
                    "appearances": 0,
                    "player": stat["player"],
                },
            )
            player["team_name"] = stat["team_name"]
            player["goals"] += stat["goals"]
            player["assists"] += stat["assists"]
            player["appearances"] += 1
    players = list(totals.values())
    scorers = sorted(
        (item for item in players if item["goals"]),
        key=lambda item: (-item["goals"], -item["assists"], item["player_name"]),
    )
    assists = sorted(
        (item for item in players if item["assists"]),
        key=lambda item: (-item["assists"], -item["goals"], item["player_name"]),
    )
    return {"scorers": scorers, "assists": assists}


def group_standings(matches: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for match in matches:
        if match["stage"] == "group":
            groups.setdefault(match["group_name"], []).append(match)
    payload = []
    for group_name, group_matches in groups.items():
        table: dict[str, dict] = {}

        def team_entry(team_id: int | None, team_name: str) -> tuple[str, dict]:
            key = f"id:{team_id}" if team_id is not None else f"name:{team_name}"
            if key not in table:
                table[key] = {
                    "team_id": team_id,
                    "team_name": team_name,
                    "played": 0,
                    "wins": 0,
                    "draws": 0,
                    "losses": 0,
                    "goals_for": 0,
                    "goals_against": 0,
                    "goal_difference": 0,
                    "points": 0,
                }
            return key, table[key]

        for match in group_matches:
            home_key, home = team_entry(match["home_team_id"], match["home_team_name"])
            away_key, away = team_entry(match["away_team_id"], match["away_team_name"])
            if match["home_score"] is None or match["away_score"] is None:
                continue
            home_score = match["home_score"]
            away_score = match["away_score"]
            home["played"] += 1
            away["played"] += 1
            home["goals_for"] += home_score
            home["goals_against"] += away_score
            away["goals_for"] += away_score
            away["goals_against"] += home_score
            if home_score > away_score:
                home["wins"] += 1
                home["points"] += 3
                away["losses"] += 1
            elif away_score > home_score:
                away["wins"] += 1
                away["points"] += 3
                home["losses"] += 1
            else:
                home["draws"] += 1
                away["draws"] += 1
                home["points"] += 1
                away["points"] += 1
            table[home_key] = home
            table[away_key] = away
        for item in table.values():
            item["goal_difference"] = item["goals_for"] - item["goals_against"]
        ordered = sorted(
            table.items(),
            key=lambda pair: (
                -pair[1]["points"],
                -pair[1]["goal_difference"],
                -pair[1]["goals_for"],
                pair[1]["team_name"],
            ),
        )
        final_order = []
        index = 0
        while index < len(ordered):
            base = ordered[index][1]
            end = index + 1
            while end < len(ordered):
                candidate = ordered[end][1]
                if (
                    candidate["points"],
                    candidate["goal_difference"],
                    candidate["goals_for"],
                ) != (base["points"], base["goal_difference"], base["goals_for"]):
                    break
                end += 1
            tied = ordered[index:end]
            if len(tied) > 1:
                tied_keys = {key for key, _ in tied}
                head_to_head = {key: {"points": 0, "goal_difference": 0, "goals_for": 0} for key in tied_keys}
                for match in group_matches:
                    if match["home_score"] is None or match["away_score"] is None:
                        continue
                    home_key = f"id:{match['home_team_id']}" if match["home_team_id"] is not None else f"name:{match['home_team_name']}"
                    away_key = f"id:{match['away_team_id']}" if match["away_team_id"] is not None else f"name:{match['away_team_name']}"
                    if home_key not in tied_keys or away_key not in tied_keys:
                        continue
                    home_score = match["home_score"]
                    away_score = match["away_score"]
                    head_to_head[home_key]["goal_difference"] += home_score - away_score
                    head_to_head[away_key]["goal_difference"] += away_score - home_score
                    head_to_head[home_key]["goals_for"] += home_score
                    head_to_head[away_key]["goals_for"] += away_score
                    if home_score > away_score:
                        head_to_head[home_key]["points"] += 3
                    elif away_score > home_score:
                        head_to_head[away_key]["points"] += 3
                    else:
                        head_to_head[home_key]["points"] += 1
                        head_to_head[away_key]["points"] += 1
                tied.sort(
                    key=lambda pair: (
                        -head_to_head[pair[0]]["points"],
                        -head_to_head[pair[0]]["goal_difference"],
                        -head_to_head[pair[0]]["goals_for"],
                        -pair[1]["wins"],
                        pair[1]["team_name"],
                    )
                )
            final_order.extend(tied)
            index = end
        rows = []
        for rank, (_, item) in enumerate(final_order, 1):
            rows.append({"rank": rank, **item})
        payload.append({"group_name": group_name, "rows": rows})
    return payload


def trade_payload(db: sqlite3.Connection, trade_id: int) -> dict:
    trade = db.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
    if not trade:
        raise AppError("交易申请不存在", HTTPStatus.NOT_FOUND)
    payload = dict(trade)
    payload["participants"] = [
        dict(row)
        for row in db.execute(
            """
            SELECT tp.team_id, t.name AS team_name, tp.response, tp.responded_at
            FROM trade_participants tp JOIN teams t ON t.id = tp.team_id
            WHERE tp.trade_id = ? ORDER BY tp.team_id
            """,
            (trade_id,),
        )
    ]
    payload["legs"] = []
    for row in db.execute(
        """
        SELECT l.*, source.name AS from_team_name, target.name AS to_team_name
        FROM trade_legs l
        JOIN teams source ON source.id = l.from_team_id
        JOIN teams target ON target.id = l.to_team_id
        WHERE l.trade_id = ? ORDER BY l.id
        """,
        (trade_id,),
    ):
        leg = dict(row)
        leg["players"] = []
        for player_row in db.execute(
            """
            SELECT tp.player_id, tp.acquired_price, p.payload
            FROM trade_players tp JOIN players p ON p.id = tp.player_id
            WHERE tp.trade_leg_id = ? ORDER BY tp.player_id
            """,
            (row["id"],),
        ):
            item = {
                "player_id": player_row["player_id"],
                "acquired_price": player_row["acquired_price"],
                "player": player_from_row(player_row),
            }
            leg["players"].append(item)
        payload["legs"].append(leg)
    return payload


def execute_trade(db: sqlite3.Connection, trade_id: int) -> None:
    trade = db.execute(
        "SELECT * FROM trades WHERE id = ? AND status = 'pending'", (trade_id,)
    ).fetchone()
    if not trade:
        raise AppError("交易状态已变化", HTTPStatus.CONFLICT)
    participant_ids = [
        row["team_id"]
        for row in db.execute(
            "SELECT team_id FROM trade_participants WHERE trade_id = ?", (trade_id,)
        )
    ]
    placeholders = ",".join("?" for _ in participant_ids)
    active_count = db.execute(
        f"""
        SELECT COUNT(DISTINCT team_id) AS count FROM users
        WHERE role = 'participant' AND team_id IN ({placeholders})
        """,
        participant_ids,
    ).fetchone()["count"]
    if active_count != len(participant_ids):
        raise AppError("参与球队账号已变化")
    legs = list(db.execute("SELECT * FROM trade_legs WHERE trade_id = ?", (trade_id,)))
    player_moves = list(
        db.execute(
            """
            SELECT tp.player_id, l.from_team_id, l.to_team_id, r.team_id AS owner_team_id
            FROM trade_players tp
            JOIN trade_legs l ON l.id = tp.trade_leg_id
            LEFT JOIN roster r ON r.player_id = tp.player_id
            WHERE l.trade_id = ?
            """,
            (trade_id,),
        )
    )
    for move in player_moves:
        if move["owner_team_id"] != move["from_team_id"]:
            raise AppError("交易球员归属已变化")
    funds = {
        row["id"]: row["funds"]
        for row in db.execute(
            f"SELECT id, funds FROM teams WHERE id IN ({placeholders})", participant_ids
        )
    }
    deltas = {team_id: 0 for team_id in participant_ids}
    for leg in legs:
        deltas[leg["from_team_id"]] -= leg["cash_amount"]
        deltas[leg["to_team_id"]] += leg["cash_amount"]
    final_funds = {team_id: funds[team_id] + deltas[team_id] for team_id in participant_ids}
    if any(amount < 0 for amount in final_funds.values()):
        raise AppError("交易资金不足")
    active_leader = db.execute(
        """
        SELECT b.team_id, b.amount FROM bids b
        JOIN auctions a ON a.id = b.auction_id AND a.status = 'active'
        ORDER BY b.amount DESC, b.created_at ASC, b.id ASC LIMIT 1
        """
    ).fetchone()
    if (
        active_leader
        and active_leader["team_id"] in final_funds
        and final_funds[active_leader["team_id"]] < active_leader["amount"]
    ):
        raise AppError("交易后资金不足以覆盖当前最高报价")
    for team_id, amount in final_funds.items():
        db.execute("UPDATE teams SET funds = ? WHERE id = ?", (amount, team_id))
    for move in player_moves:
        updated = db.execute(
            """
            UPDATE roster SET team_id = ?, lineup_role = 'bench'
            WHERE team_id = ? AND player_id = ?
            """,
            (move["to_team_id"], move["from_team_id"], move["player_id"]),
        )
        if not updated.rowcount:
            raise AppError("交易球员归属已变化")
    now = int(time.time())
    db.execute(
        "UPDATE trades SET status = 'completed', resolved_at = ? WHERE id = ?",
        (now, trade_id),
    )
    if player_moves:
        player_placeholders = ",".join("?" for _ in player_moves)
        db.execute(
            f"""
            UPDATE trades SET status = 'invalid', resolved_at = ?
            WHERE status = 'pending' AND id != ? AND id IN (
                SELECT DISTINCT l.trade_id FROM trade_legs l
                JOIN trade_players tp ON tp.trade_leg_id = l.id
                WHERE tp.player_id IN ({player_placeholders})
            )
            """,
            (now, trade_id, *[move["player_id"] for move in player_moves]),
        )


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


def optional_nonnegative_integer(value: object, label: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = int(str(value))
    except (TypeError, ValueError) as exc:
        raise AppError(f"{label}必须是整数") from exc
    if number < 0 or number > 99:
        raise AppError(f"{label}需要在 0–99 之间")
    return number


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
        self.read_json()
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
            self.close_connection = True
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
            bids = auction_bids(db, active["id"])
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
            completed_auction_payload(db, row)
            for row in db.execute(
                """
                SELECT a.*, p.payload, t.name AS winner_team_name
                FROM auctions a JOIN players p ON p.id = a.player_id
                LEFT JOIN teams t ON t.id = a.winner_team_id
                WHERE a.status IN ('sold', 'unsold') ORDER BY a.id DESC LIMIT 8
                """
            )
        ]
        teams = [
            dict(row)
            for row in db.execute(
                """
                SELECT t.id, t.name, t.funds
                FROM teams t
                JOIN users u ON u.team_id = t.id AND u.role = 'participant'
                ORDER BY t.id
                """
            )
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

    def api_get_auction_history(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_user(user)
        auctions = [
            completed_auction_payload(db, row)
            for row in db.execute(
                """
                SELECT a.*, p.payload, t.name AS winner_team_name
                FROM auctions a JOIN players p ON p.id = a.player_id
                LEFT JOIN teams t ON t.id = a.winner_team_id
                WHERE a.status IN ('sold', 'unsold')
                ORDER BY a.id DESC
                """
            )
        ]
        self.send_json({"auctions": auctions})

    def api_get_matches(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_user(user)
        matches = match_payloads(db)
        teams = [
            dict(row)
            for row in db.execute(
                """
                SELECT t.id, t.name FROM teams t
                JOIN users u ON u.team_id = t.id AND u.role = 'participant'
                ORDER BY t.id
                """
            )
        ]
        self.send_json(
            {
                "matches": matches,
                "standings": group_standings(matches),
                "leaders": player_stat_leaders(matches),
                "teams": teams,
            }
        )

    def api_post_admin_match_save(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        data = self.read_json()
        try:
            match_id = int(data.get("match_id", 0))
            home_team_id = int(data.get("home_team_id", 0))
            away_team_id = int(data.get("away_team_id", 0))
            played_at = int(data["played_at"]) if data.get("played_at") not in (None, "") else None
        except (TypeError, ValueError) as exc:
            raise AppError("比赛、球队或时间格式错误") from exc
        stage = str(data.get("stage", "")).strip()
        group_name = str(data.get("group_name", "")).strip()
        round_name = str(data.get("round_name", "")).strip()
        if stage not in {"group", "knockout"}:
            raise AppError("请选择小组赛或淘汰赛")
        if home_team_id <= 0 or away_team_id <= 0 or home_team_id == away_team_id:
            raise AppError("请选择两支不同球队")
        if stage == "group":
            group_name = group_name or "A组"
            round_name = round_name or "小组赛"
        else:
            group_name = ""
            if not round_name:
                raise AppError("淘汰赛必须填写轮次")
        if len(group_name) > 30 or len(round_name) > 30:
            raise AppError("小组和轮次名称不能超过 30 个字符")
        home_score = optional_nonnegative_integer(data.get("home_score"), "主队进球")
        away_score = optional_nonnegative_integer(data.get("away_score"), "客队进球")
        home_penalties = optional_nonnegative_integer(data.get("home_penalties"), "主队点球")
        away_penalties = optional_nonnegative_integer(data.get("away_penalties"), "客队点球")
        if (home_score is None) != (away_score is None):
            raise AppError("主客队比分需要同时填写")
        if (home_penalties is None) != (away_penalties is None):
            raise AppError("点球比分需要同时填写")
        if stage == "group" and home_penalties is not None:
            raise AppError("小组赛不能录入点球比分")
        if stage == "knockout" and home_score is not None:
            if home_score == away_score:
                if home_penalties is None or home_penalties == away_penalties:
                    raise AppError("淘汰赛战平时需要填写不相同的点球比分")
            elif home_penalties is not None:
                raise AppError("常规比分已分胜负时不需要填写点球比分")
        elif home_penalties is not None:
            raise AppError("需要先填写常规比分")
        team_rows = list(
            db.execute(
                "SELECT id, name FROM teams WHERE id IN (?, ?)",
                (home_team_id, away_team_id),
            )
        )
        if len(team_rows) != 2:
            raise AppError("所选球队不存在", HTTPStatus.NOT_FOUND)
        team_names = {row["id"]: row["name"] for row in team_rows}
        if match_id:
            recorded_stats = list(
                db.execute(
                    """
                    SELECT team_id, SUM(goals) AS goals, SUM(assists) AS assists
                    FROM match_player_stats WHERE match_id = ? GROUP BY team_id
                    """,
                    (match_id,),
                )
            )
            if recorded_stats and home_score is None:
                raise AppError("已有球员进球助攻记录，不能清空比赛比分")
            score_limits = {home_team_id: home_score, away_team_id: away_score}
            for stat in recorded_stats:
                if stat["team_id"] not in score_limits:
                    raise AppError("已有球员记录属于原对阵球队，请先清空球员记录")
                if stat["goals"] > score_limits[stat["team_id"]]:
                    raise AppError("新比分低于已记录的球员进球数")
                if stat["assists"] > score_limits[stat["team_id"]]:
                    raise AppError("新比分低于已记录的球员助攻数")
        now = int(time.time())
        if home_score is not None and played_at is None:
            played_at = now
        values = (
            stage,
            group_name or None,
            round_name,
            home_team_id,
            team_names[home_team_id],
            away_team_id,
            team_names[away_team_id],
            home_score,
            away_score,
            home_penalties,
            away_penalties,
            played_at,
            now,
        )
        with AUCTION_STATE_LOCK:
            if match_id:
                updated = db.execute(
                    """
                    UPDATE matches SET stage = ?, group_name = ?, round_name = ?,
                        home_team_id = ?, home_team_name = ?, away_team_id = ?,
                        away_team_name = ?, home_score = ?, away_score = ?,
                        home_penalties = ?, away_penalties = ?, played_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (*values, match_id),
                )
                if not updated.rowcount:
                    raise AppError("比赛不存在", HTTPStatus.NOT_FOUND)
            else:
                match_id = db.execute(
                    """
                    INSERT INTO matches(
                        stage, group_name, round_name, home_team_id, home_team_name,
                        away_team_id, away_team_name, home_score, away_score,
                        home_penalties, away_penalties, played_at, updated_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (*values, now),
                ).lastrowid
            db.commit()
        self.send_json({"ok": True, "match_id": match_id})

    def api_post_admin_match_delete(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        try:
            match_id = int(self.read_json().get("match_id", 0))
        except (TypeError, ValueError) as exc:
            raise AppError("比赛编号格式错误") from exc
        with AUCTION_STATE_LOCK:
            deleted = db.execute("DELETE FROM matches WHERE id = ?", (match_id,))
            if not deleted.rowcount:
                raise AppError("比赛不存在", HTTPStatus.NOT_FOUND)
            db.commit()
        self.send_json({"ok": True, "match_id": match_id})

    def api_post_admin_match_stats_save(
        self, db: sqlite3.Connection, user: dict | None
    ) -> None:
        require_admin(user)
        data = self.read_json()
        try:
            match_id = int(data.get("match_id", 0))
        except (TypeError, ValueError) as exc:
            raise AppError("比赛编号格式错误") from exc
        raw_stats = data.get("stats")
        if not isinstance(raw_stats, list):
            raise AppError("球员记录格式错误")
        match = db.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise AppError("比赛不存在", HTTPStatus.NOT_FOUND)
        if match["home_score"] is None or match["away_score"] is None:
            raise AppError("需要先录入比赛比分")
        team_limits = {
            match["home_team_id"]: match["home_score"],
            match["away_team_id"]: match["away_score"],
        }
        stats = []
        player_ids = set()
        try:
            for raw_stat in raw_stats:
                player_id = str(raw_stat.get("player_id", "")).strip()
                team_id = int(raw_stat.get("team_id", 0))
                goals = int(str(raw_stat.get("goals", 0)))
                assists = int(str(raw_stat.get("assists", 0)))
                if (
                    not player_id
                    or player_id in player_ids
                    or team_id not in team_limits
                    or goals < 0
                    or assists < 0
                    or goals > 99
                    or assists > 99
                ):
                    raise ValueError
                player_ids.add(player_id)
                if goals or assists:
                    stats.append(
                        {
                            "player_id": player_id,
                            "team_id": team_id,
                            "goals": goals,
                            "assists": assists,
                        }
                    )
        except (AttributeError, TypeError, ValueError) as exc:
            raise AppError("球员、球队、进球或助攻数据无效") from exc
        for team_id, score in team_limits.items():
            team_stats = [stat for stat in stats if stat["team_id"] == team_id]
            if sum(stat["goals"] for stat in team_stats) > score:
                raise AppError("球员进球合计不能超过该队比赛进球数")
            if sum(stat["assists"] for stat in team_stats) > score:
                raise AppError("球员助攻合计不能超过该队比赛进球数")
        if player_ids:
            placeholders = ",".join("?" for _ in player_ids)
            player_rows = list(
                db.execute(
                    f"SELECT id, payload FROM players WHERE id IN ({placeholders})",
                    tuple(player_ids),
                )
            )
            if len(player_rows) != len(player_ids):
                raise AppError("存在无效球员", HTTPStatus.NOT_FOUND)
        else:
            player_rows = []
        players = {row["id"]: player_from_row(row) for row in player_rows}
        team_names = {
            row["id"]: row["name"]
            for row in db.execute(
                "SELECT id, name FROM teams WHERE id IN (?, ?)",
                tuple(team_limits),
            )
        }
        with AUCTION_STATE_LOCK:
            db.execute("DELETE FROM match_player_stats WHERE match_id = ?", (match_id,))
            db.executemany(
                """
                INSERT INTO match_player_stats(
                    match_id, player_id, player_name, team_id, team_name, goals, assists
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        match_id,
                        stat["player_id"],
                        players[stat["player_id"]]["name_zh"],
                        stat["team_id"],
                        team_names.get(stat["team_id"], "历史球队"),
                        stat["goals"],
                        stat["assists"],
                    )
                    for stat in stats
                ],
            )
            db.commit()
        self.send_json({"ok": True, "match_id": match_id, "recorded_players": len(stats)})

    def api_post_bid(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user["team_id"]:
            raise AppError("当前账号没有参与球队", HTTPStatus.FORBIDDEN)
        data = self.read_json()
        try:
            amount = int(str(data.get("amount", 0)))
            requested_auction_id = int(data.get("auction_id", 0) or 0)
        except (TypeError, ValueError) as exc:
            raise AppError("报价必须是整数金额") from exc
        if amount <= 0:
            raise AppError("报价必须大于零")
        with AUCTION_STATE_LOCK:
            now = int(time.time())
            auction = db.execute("SELECT * FROM auctions WHERE status = 'active' LIMIT 1").fetchone()
            if not auction:
                raise AppError("当前没有可报价的竞拍", HTTPStatus.CONFLICT)
            if requested_auction_id and requested_auction_id != auction["id"]:
                raise AppError("竞拍场次已变化，请确认当前拍品后重新报价", HTTPStatus.CONFLICT)
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
            ends_at = auction["ends_at"]
            if auction["auction_type"] == "open":
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

    def api_get_trade_options(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user.get("team_id"):
            raise AppError("仅参与者可以发起交易", HTTPStatus.FORBIDDEN)
        teams = []
        for row in db.execute(
            """
            SELECT t.id, t.name, t.funds
            FROM teams t JOIN users u ON u.team_id = t.id AND u.role = 'participant'
            ORDER BY t.id
            """
        ):
            team = dict(row)
            team["roster"] = []
            for roster_row in db.execute(
                """
                SELECT r.player_id, r.acquired_price, p.payload
                FROM roster r JOIN players p ON p.id = r.player_id
                WHERE r.team_id = ? ORDER BY r.acquired_at
                """,
                (row["id"],),
            ):
                team["roster"].append(
                    {
                        "player_id": roster_row["player_id"],
                        "acquired_price": roster_row["acquired_price"],
                        "player": player_from_row(roster_row),
                    }
                )
            teams.append(team)
        self.send_json({"teams": teams})

    def api_get_trades(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] == "admin":
            rows = db.execute(
                """
                SELECT * FROM trades
                ORDER BY status = 'pending' DESC, id DESC
                """
            )
        elif user.get("team_id"):
            rows = db.execute(
                """
                SELECT tr.* FROM trades tr
                JOIN trade_participants tp ON tp.trade_id = tr.id
                WHERE tp.team_id = ?
                ORDER BY tr.status = 'pending' DESC, tr.id DESC
                """,
                (user["team_id"],),
            )
        else:
            raise AppError("当前账号没有参与球队", HTTPStatus.FORBIDDEN)
        self.send_json({"trades": [trade_payload(db, row["id"]) for row in rows]})

    def api_post_trade_create(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user.get("team_id"):
            raise AppError("仅参与者可以发起交易", HTTPStatus.FORBIDDEN)
        data = self.read_json()
        raw_legs = data.get("legs")
        if not isinstance(raw_legs, list):
            raise AppError("交易方案格式错误")
        legs = []
        player_ids = set()
        try:
            for raw_leg in raw_legs:
                from_team_id = int(raw_leg.get("from_team_id", 0))
                to_team_id = int(raw_leg.get("to_team_id", 0))
                cash_amount = int(str(raw_leg.get("cash_amount", 0)))
                raw_players = raw_leg.get("player_ids", [])
                if not isinstance(raw_players, list):
                    raise ValueError
                leg_player_ids = [str(player_id).strip() for player_id in raw_players]
                if cash_amount < 0 or from_team_id <= 0 or to_team_id <= 0:
                    raise ValueError
                if any(not player_id or player_id in player_ids for player_id in leg_player_ids):
                    raise AppError("同一球员不能在一笔交易中重复出现")
                player_ids.update(leg_player_ids)
                legs.append(
                    {
                        "from_team_id": from_team_id,
                        "to_team_id": to_team_id,
                        "cash_amount": cash_amount,
                        "player_ids": leg_player_ids,
                    }
                )
        except (AttributeError, TypeError, ValueError) as exc:
            raise AppError("球队、球员和金额格式错误") from exc
        participant_ids = {leg["from_team_id"] for leg in legs}
        recipient_ids = {leg["to_team_id"] for leg in legs}
        if len(participant_ids) not in (2, 3) or len(legs) != len(participant_ids):
            raise AppError("交易必须包含 2 支或 3 支球队，且每队只有一条转出关系")
        if participant_ids != recipient_ids or any(
            leg["from_team_id"] == leg["to_team_id"] for leg in legs
        ):
            raise AppError("每支球队必须向另一支参与球队转出，并且各有一个接收方")
        if user["team_id"] not in participant_ids:
            raise AppError("发起人的球队必须参与交易", HTTPStatus.FORBIDDEN)
        if not player_ids and not any(leg["cash_amount"] for leg in legs):
            raise AppError("交易至少需要包含一名球员或一笔资金")
        placeholders = ",".join("?" for _ in participant_ids)
        active_count = db.execute(
            f"""
            SELECT COUNT(DISTINCT team_id) AS count FROM users
            WHERE role = 'participant' AND team_id IN ({placeholders})
            """,
            tuple(participant_ids),
        ).fetchone()["count"]
        if active_count != len(participant_ids):
            raise AppError("交易中存在无有效参与者账号的球队")
        with AUCTION_STATE_LOCK:
            acquired_prices = {}
            for leg in legs:
                for player_id in leg["player_ids"]:
                    roster_item = db.execute(
                        "SELECT acquired_price FROM roster WHERE team_id = ? AND player_id = ?",
                        (leg["from_team_id"], player_id),
                    ).fetchone()
                    if not roster_item:
                        raise AppError("所选球员归属已变化", HTTPStatus.CONFLICT)
                    acquired_prices[player_id] = roster_item["acquired_price"]
            now = int(time.time())
            trade_id = db.execute(
                "INSERT INTO trades(creator_team_id, status, created_at) VALUES (?, 'pending', ?)",
                (user["team_id"], now),
            ).lastrowid
            db.executemany(
                """
                INSERT INTO trade_participants(trade_id, team_id, response, responded_at)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        trade_id,
                        team_id,
                        "accepted" if team_id == user["team_id"] else "pending",
                        now if team_id == user["team_id"] else None,
                    )
                    for team_id in participant_ids
                ],
            )
            for leg in legs:
                leg_id = db.execute(
                    """
                    INSERT INTO trade_legs(trade_id, from_team_id, to_team_id, cash_amount)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        trade_id,
                        leg["from_team_id"],
                        leg["to_team_id"],
                        leg["cash_amount"],
                    ),
                ).lastrowid
                db.executemany(
                    """
                    INSERT INTO trade_players(trade_leg_id, player_id, acquired_price)
                    VALUES (?, ?, ?)
                    """,
                    [
                        (leg_id, player_id, acquired_prices[player_id])
                        for player_id in leg["player_ids"]
                    ],
                )
            db.commit()
        self.send_json({"trade": trade_payload(db, trade_id)}, HTTPStatus.CREATED)

    def api_post_trade_respond(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user.get("team_id"):
            raise AppError("仅交易参与者可以处理申请", HTTPStatus.FORBIDDEN)
        data = self.read_json()
        trade_id = int(data.get("trade_id", 0))
        decision = str(data.get("decision", "")).strip()
        if decision not in ("accepted", "rejected"):
            raise AppError("请选择同意或拒绝")
        with AUCTION_STATE_LOCK:
            trade = db.execute(
                "SELECT * FROM trades WHERE id = ? AND status = 'pending'", (trade_id,)
            ).fetchone()
            if not trade:
                raise AppError("交易申请已处理或不存在", HTTPStatus.CONFLICT)
            participant = db.execute(
                """
                SELECT response FROM trade_participants
                WHERE trade_id = ? AND team_id = ?
                """,
                (trade_id, user["team_id"]),
            ).fetchone()
            if not participant:
                raise AppError("你不在这笔交易中", HTTPStatus.FORBIDDEN)
            if participant["response"] != "pending":
                raise AppError("你已经处理过这笔交易", HTTPStatus.CONFLICT)
            now = int(time.time())
            db.execute(
                """
                UPDATE trade_participants SET response = ?, responded_at = ?
                WHERE trade_id = ? AND team_id = ?
                """,
                (decision, now, trade_id, user["team_id"]),
            )
            if decision == "rejected":
                db.execute(
                    "UPDATE trades SET status = 'rejected', resolved_at = ? WHERE id = ?",
                    (now, trade_id),
                )
            else:
                pending = db.execute(
                    """
                    SELECT COUNT(*) AS count FROM trade_participants
                    WHERE trade_id = ? AND response = 'pending'
                    """,
                    (trade_id,),
                ).fetchone()["count"]
                if not pending:
                    db.execute("SAVEPOINT trade_execution")
                    try:
                        execute_trade(db, trade_id)
                    except AppError as exc:
                        db.execute("ROLLBACK TO trade_execution")
                        db.execute("RELEASE trade_execution")
                        db.execute(
                            "UPDATE trades SET status = 'invalid', resolved_at = ? WHERE id = ?",
                            (now, trade_id),
                        )
                        db.commit()
                        raise AppError(f"交易条件已变化：{exc}", HTTPStatus.CONFLICT) from exc
                    else:
                        db.execute("RELEASE trade_execution")
            db.commit()
        self.send_json({"trade": trade_payload(db, trade_id)})

    def api_post_trade_cancel(self, db: sqlite3.Connection, user: dict | None) -> None:
        user = require_user(user)
        if user["role"] != "participant" or not user.get("team_id"):
            raise AppError("仅发起人可以撤回交易", HTTPStatus.FORBIDDEN)
        trade_id = int(self.read_json().get("trade_id", 0))
        with AUCTION_STATE_LOCK:
            updated = db.execute(
                """
                UPDATE trades SET status = 'cancelled', resolved_at = ?
                WHERE id = ? AND creator_team_id = ? AND status = 'pending'
                """,
                (int(time.time()), trade_id, user["team_id"]),
            )
            if not updated.rowcount:
                raise AppError("只能撤回自己发起且仍待确认的交易", HTTPStatus.CONFLICT)
            db.commit()
        self.send_json({"trade": trade_payload(db, trade_id)})

    def api_get_admin_teams(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        teams = [
            dict(row)
            for row in db.execute(
                """
                SELECT t.*, u.id AS participant_user_id, u.username,
                       (SELECT COUNT(*) FROM roster r WHERE r.team_id = t.id) AS roster_count,
                       (SELECT COALESCE(SUM(r.acquired_price), 0)
                        FROM roster r WHERE r.team_id = t.id) AS roster_value
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
        with AUCTION_STATE_LOCK:
            participant = db.execute(
                "SELECT id, username FROM users WHERE role = 'participant' AND team_id = ?",
                (team_id,),
            ).fetchone()
            if not participant:
                raise AppError("该球队没有可释放的参与者账号", HTTPStatus.NOT_FOUND)
            roster_summary = db.execute(
                """
                SELECT COUNT(*) AS player_count, COALESCE(SUM(acquired_price), 0) AS refund
                FROM roster WHERE team_id = ?
                """,
                (team_id,),
            ).fetchone()
            deleted_bids = db.execute(
                "SELECT COUNT(*) AS count FROM bids WHERE user_id = ?",
                (participant["id"],),
            ).fetchone()["count"]
            db.execute(
                """
                UPDATE trades SET status = 'invalid', resolved_at = ?
                WHERE status = 'pending' AND id IN (
                    SELECT trade_id FROM trade_participants WHERE team_id = ?
                )
                """,
                (int(time.time()), team_id),
            )
            db.execute("DELETE FROM sessions WHERE user_id = ?", (participant["id"],))
            db.execute("DELETE FROM bids WHERE user_id = ?", (participant["id"],))
            db.execute("DELETE FROM roster WHERE team_id = ?", (team_id,))
            db.execute(
                "UPDATE teams SET funds = funds + ? WHERE id = ?",
                (roster_summary["refund"], team_id),
            )
            db.execute("DELETE FROM users WHERE id = ?", (participant["id"],))
            funds = db.execute("SELECT funds FROM teams WHERE id = ?", (team_id,)).fetchone()[
                "funds"
            ]
            db.commit()
        self.send_json(
            {
                "ok": True,
                "released_players": roster_summary["player_count"],
                "deleted_bids": deleted_bids,
                "refunded_amount": roster_summary["refund"],
                "funds": funds,
            }
        )

    def api_post_admin_player_release(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        data = self.read_json()
        team_id = int(data.get("team_id", 0))
        player_id = str(data.get("player_id", "")).strip()
        with AUCTION_STATE_LOCK:
            roster_item = db.execute(
                """
                SELECT r.acquired_price, p.payload
                FROM roster r JOIN players p ON p.id = r.player_id
                WHERE r.team_id = ? AND r.player_id = ?
                """,
                (team_id, player_id),
            ).fetchone()
            if not roster_item:
                raise AppError("该球员不在指定球队中", HTTPStatus.NOT_FOUND)
            player = player_from_row(roster_item)
            db.execute(
                """
                UPDATE trades SET status = 'invalid', resolved_at = ?
                WHERE status = 'pending' AND id IN (
                    SELECT l.trade_id FROM trade_legs l
                    JOIN trade_players tp ON tp.trade_leg_id = l.id
                    WHERE tp.player_id = ?
                )
                """,
                (int(time.time()), player_id),
            )
            db.execute(
                "DELETE FROM roster WHERE team_id = ? AND player_id = ?",
                (team_id, player_id),
            )
            db.execute(
                "UPDATE teams SET funds = funds + ? WHERE id = ?",
                (roster_item["acquired_price"], team_id),
            )
            funds = db.execute("SELECT funds FROM teams WHERE id = ?", (team_id,)).fetchone()[
                "funds"
            ]
            db.commit()
        self.send_json(
            {
                "ok": True,
                "player_id": player_id,
                "player_name": player["name_zh"],
                "refunded_amount": roster_item["acquired_price"],
                "funds": funds,
            }
        )

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
        auction_type = str(data.get("auction_type", "open"))
        if auction_type not in {"open", "sealed"}:
            raise AppError("竞拍方式无效")
        try:
            start_price = int(data.get("start_price", 0))
            min_increment = int(data.get("min_increment", 10))
            duration_seconds = int(data.get("duration_seconds", 30))
        except (TypeError, ValueError) as exc:
            raise AppError("竞拍规则必须填写整数") from exc
        if start_price < 0 or min_increment <= 0:
            raise AppError("起拍价不能小于零，最小加价必须大于零")
        if not 10 <= duration_seconds <= 3600:
            raise AppError("倒计时需要设置为 10–3600 秒")
        start_immediately = bool(data.get("start_immediately"))
        now = int(time.time())
        values = (
            player_id,
            auction_type,
            start_price,
            min_increment,
            duration_seconds,
            now,
        )
        with AUCTION_STATE_LOCK:
            if db.execute("SELECT 1 FROM roster WHERE player_id = ?", (player_id,)).fetchone():
                raise AppError("该球员已经属于某支球队")
            if db.execute(
                "SELECT 1 FROM auctions WHERE player_id = ? AND status IN ('queued', 'active')",
                (player_id,),
            ).fetchone():
                raise AppError("该球员已经在拍卖池中")
            if start_immediately and db.execute(
                "SELECT 1 FROM auctions WHERE status = 'active'"
            ).fetchone():
                raise AppError("已有一场竞拍正在进行", HTTPStatus.CONFLICT)
            status = "active" if start_immediately else "queued"
            cursor = db.execute(
                """
                INSERT INTO auctions(
                    player_id, auction_type, status, start_price, min_increment,
                    duration_seconds, starts_at, ends_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    *values[:2],
                    status,
                    *values[2:5],
                    now if start_immediately else None,
                    now + duration_seconds if start_immediately else None,
                    values[5],
                ),
            )
            db.commit()
        self.send_json(
            {
                "ok": True,
                "auction_id": cursor.lastrowid,
                "status": status,
                "ends_at": now + duration_seconds if start_immediately else None,
            },
            HTTPStatus.CREATED,
        )

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

    def api_post_admin_auction_settle(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        self.read_json()
        with AUCTION_STATE_LOCK:
            auction = db.execute(
                "SELECT id FROM auctions WHERE status = 'active' LIMIT 1"
            ).fetchone()
            if not auction:
                raise AppError("当前没有进行中的竞拍", HTTPStatus.CONFLICT)
            if not db.execute(
                "SELECT 1 FROM bids WHERE auction_id = ? LIMIT 1", (auction["id"],)
            ).fetchone():
                raise AppError("还没有有效报价，不能落槌成交", HTTPStatus.CONFLICT)
            db.execute(
                "UPDATE auctions SET ends_at = ? WHERE id = ?",
                (int(time.time()), auction["id"]),
            )
            db.commit()
            if not finish_expired_auction(db):
                raise AppError("竞拍状态已变化，请刷新后重试", HTTPStatus.CONFLICT)
        self.send_json({"ok": True, "auction_id": auction["id"]})

    def api_post_admin_auction_withdraw(self, db: sqlite3.Connection, user: dict | None) -> None:
        require_admin(user)
        self.read_json()
        with AUCTION_STATE_LOCK:
            auction = db.execute(
                "SELECT id FROM auctions WHERE status = 'active' LIMIT 1"
            ).fetchone()
            if not auction:
                raise AppError("当前没有进行中的竞拍", HTTPStatus.CONFLICT)
            db.execute("DELETE FROM bids WHERE auction_id = ?", (auction["id"],))
            db.execute(
                """
                UPDATE auctions
                SET status = 'queued', starts_at = NULL, ends_at = NULL,
                    winner_team_id = NULL, final_price = NULL
                WHERE id = ?
                """,
                (auction["id"],),
            )
            db.commit()
        self.send_json({"ok": True, "auction_id": auction["id"]})

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
