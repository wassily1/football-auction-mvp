from __future__ import annotations

import http.cookiejar
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class Client:
    def __init__(self, base_url: str):
        self.base_url = base_url
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request(self, path: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}/api/{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.load(exc)
            finally:
                exc.close()


class AuctionFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.temp_dir.name) / "test.db"
        app.init_database()
        self.server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.AuctionHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.admin = Client(self.base_url)
        self.alpha = Client(self.base_url)
        self.bravo = Client(self.base_url)
        self.charlie = Client(self.base_url)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temp_dir.cleanup()

    def login(self, client: Client, username: str, password: str) -> None:
        status, payload = client.request(
            "login", "POST", {"username": username, "password": password}
        )
        self.assertEqual(status, 200, payload)

    def test_complete_multi_user_auction_and_lineup_flow(self) -> None:
        self.assertEqual(
            self.alpha.request(
                "register",
                "POST",
                {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
            )[0],
            201,
        )
        self.assertEqual(
            self.bravo.request(
                "register",
                "POST",
                {"username": "bravo", "password": "pass2", "team_name": "Bravo FC"},
            )[0],
            201,
        )
        self.login(self.admin, "admin", "admin123")
        self.login(self.alpha, "alpha", "pass1")
        self.login(self.bravo, "bravo", "pass2")

        _, teams_payload = self.admin.request("admin/teams")
        teams = {team["name"]: team for team in teams_payload["teams"]}
        for team in teams.values():
            status, _ = self.admin.request(
                "admin/funds", "POST", {"team_id": team["id"], "funds": 1000}
            )
            self.assertEqual(status, 200)

        player_id = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))[0]["id"]
        status, _ = self.admin.request(
            "admin/auction/queue",
            "POST",
            {"player_id": player_id, "start_price": 100, "min_increment": 10, "duration_seconds": 10},
        )
        self.assertEqual(status, 201)
        _, market = self.admin.request("auction")
        auction_id = market["queued"][0]["id"]
        self.assertEqual(
            self.admin.request("admin/auction/start", "POST", {"auction_id": auction_id})[0],
            200,
        )
        db = app.connect()
        try:
            db.execute("UPDATE auctions SET ends_at = ? WHERE id = ?", (int(time.time()) + 3, auction_id))
            db.commit()
        finally:
            db.close()

        status, rejected = self.alpha.request("bid", "POST", {"amount": 100.5})
        self.assertEqual(status, 400)
        self.assertIn("整数金额", rejected["error"])
        with ThreadPoolExecutor(max_workers=2) as executor:
            simultaneous = list(
                executor.map(
                    lambda client: client.request("bid", "POST", {"amount": 200}),
                    [self.alpha, self.bravo],
                )
            )
        self.assertEqual(sorted(status for status, _ in simultaneous), [201, 400])
        if simultaneous[0][0] == 201:
            current_leader, challenger = self.alpha, self.bravo
            winning_team_name = "Bravo FC"
        else:
            current_leader, challenger = self.bravo, self.alpha
            winning_team_name = "Alpha FC"
        status, rejected = current_leader.request("bid", "POST", {"amount": 220})
        self.assertEqual(status, 409)
        self.assertIn("最高报价方", rejected["error"])
        self.assertEqual(challenger.request("bid", "POST", {"amount": 250})[0], 201)
        status, rejected = current_leader.request("bid", "POST", {"amount": 255})
        self.assertEqual(status, 400)
        self.assertIn("最低有效报价", rejected["error"])

        _, live = self.alpha.request("auction")
        self.assertEqual(live["active"]["bids"][0]["team_name"], winning_team_name)
        self.assertEqual(live["active"]["bids"][0]["amount"], 250)
        self.assertGreaterEqual(live["active"]["ends_at"], int(time.time()) + 8)
        self.assertEqual(
            {team["name"] for team in live["teams"]}, {"Alpha FC", "Bravo FC"}
        )
        self.assertTrue(all("funds" in team for team in live["teams"]))

        db = app.connect()
        try:
            db.execute("UPDATE auctions SET ends_at = ? WHERE id = ?", (int(time.time()) - 1, auction_id))
            db.commit()
        finally:
            db.close()
        status, rejected = current_leader.request("bid", "POST", {"amount": 300})
        self.assertEqual(status, 409)
        self.assertIn("没有可报价", rejected["error"])
        _, result = self.alpha.request("auction")
        self.assertIsNone(result["active"])
        self.assertEqual(result["recent"][0]["winner_team_name"], winning_team_name)
        self.assertEqual(result["recent"][0]["final_price"], 250)

        _, roster = challenger.request("roster")
        self.assertEqual(roster["team"]["funds"], 750)
        self.assertEqual(len(roster["roster"]), 1)
        self.assertEqual(roster["roster"][0]["lineup_role"], "bench")
        self.assertEqual(
            challenger.request("lineup/toggle", "POST", {"player_id": player_id})[0], 200
        )
        _, lineup = challenger.request("roster")
        self.assertEqual(lineup["roster"][0]["lineup_role"], "starter")

        status, admin_roster = self.admin.request(
            f"roster?team_id={teams[winning_team_name]['id']}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(admin_roster["team"]["name"], winning_team_name)
        self.assertEqual(admin_roster["team"]["funds"], 750)
        self.assertEqual(admin_roster["roster"][0]["player"]["id"], player_id)
        self.assertEqual(admin_roster["roster"][0]["lineup_role"], "starter")

        losing_client = self.bravo if challenger is self.alpha else self.alpha
        status, _ = losing_client.request(f"roster?team_id={teams[winning_team_name]['id']}")
        self.assertEqual(status, 403)

    def test_participant_cannot_use_admin_routes(self) -> None:
        self.alpha.request(
            "register",
            "POST",
            {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
        )
        self.login(self.alpha, "alpha", "pass1")
        status, _ = self.alpha.request("admin/teams")
        self.assertEqual(status, 403)

    def test_sealed_auction_hides_bids_and_allows_one_bid_per_team(self) -> None:
        for client, username, team_name in [
            (self.alpha, "alpha", "Alpha FC"),
            (self.bravo, "bravo", "Bravo FC"),
        ]:
            self.assertEqual(
                client.request(
                    "register",
                    "POST",
                    {"username": username, "password": "pass123", "team_name": team_name},
                )[0],
                201,
            )
        self.login(self.admin, "admin", "admin123")
        self.login(self.alpha, "alpha", "pass123")
        self.login(self.bravo, "bravo", "pass123")
        _, teams_payload = self.admin.request("admin/teams")
        teams = {team["name"]: team for team in teams_payload["teams"]}
        for team in teams.values():
            self.assertEqual(
                self.admin.request(
                    "admin/funds", "POST", {"team_id": team["id"], "funds": 1000}
                )[0],
                200,
            )
        player_id = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))[1]["id"]
        self.assertEqual(
            self.admin.request(
                "admin/auction/queue",
                "POST",
                {
                    "player_id": player_id,
                    "auction_type": "sealed",
                    "start_price": 100,
                    "min_increment": 10,
                    "duration_seconds": 10,
                },
            )[0],
            201,
        )
        _, market = self.admin.request("auction")
        auction_id = market["queued"][0]["id"]
        self.admin.request("admin/auction/start", "POST", {"auction_id": auction_id})
        _, started_market = self.admin.request("auction")
        sealed_ends_at = started_market["active"]["ends_at"]
        self.assertEqual(self.alpha.request("bid", "POST", {"amount": 300})[0], 201)
        self.assertEqual(self.alpha.request("bid", "POST", {"amount": 400})[0], 409)
        _, alpha_market = self.alpha.request("auction")
        self.assertEqual(alpha_market["active"]["auction_type"], "sealed")
        self.assertEqual(alpha_market["active"]["bids"], [])
        self.assertEqual(alpha_market["active"]["bid_count"], 1)
        self.assertTrue(alpha_market["active"]["has_bid"])
        self.assertEqual(alpha_market["active"]["ends_at"], sealed_ends_at)

        self.assertEqual(self.bravo.request("bid", "POST", {"amount": 350})[0], 201)
        _, admin_market = self.admin.request("auction")
        self.assertEqual(admin_market["active"]["bids"], [])
        self.assertEqual(admin_market["active"]["bid_count"], 2)
        self.assertEqual(admin_market["active"]["ends_at"], sealed_ends_at)
        db = app.connect()
        try:
            db.execute("UPDATE auctions SET ends_at = ? WHERE id = ?", (int(time.time()) - 1, auction_id))
            db.commit()
        finally:
            db.close()
        _, settled = self.admin.request("auction")
        self.assertEqual(settled["recent"][0]["winner_team_name"], "Bravo FC")
        self.assertEqual(settled["recent"][0]["final_price"], 350)
        self.assertEqual(
            [(bid["team_name"], bid["amount"]) for bid in settled["recent"][0]["bids"]],
            [("Bravo FC", 350), ("Alpha FC", 300)],
        )
        status, history = self.alpha.request("auction/history")
        self.assertEqual(status, 200)
        self.assertEqual(history["auctions"][0]["auction_type"], "sealed")
        self.assertEqual(
            [bid["amount"] for bid in history["auctions"][0]["bids"]], [350, 300]
        )

    def test_auction_history_is_authenticated_and_not_limited_to_recent_results(self) -> None:
        self.login(self.admin, "admin", "admin123")
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        now = int(time.time())
        db = app.connect()
        try:
            db.executemany(
                """
                INSERT INTO auctions(
                    player_id, auction_type, status, start_price, min_increment,
                    duration_seconds, starts_at, ends_at, created_at
                ) VALUES (?, ?, 'unsold', 100, 10, 30, ?, ?, ?)
                """,
                [
                    (player["id"], "sealed" if index % 2 else "open", now, now, now + index)
                    for index, player in enumerate(players[:10])
                ],
            )
            db.commit()
        finally:
            db.close()

        _, market = self.admin.request("auction")
        self.assertEqual(len(market["recent"]), 8)
        status, history = self.admin.request("auction/history")
        self.assertEqual(status, 200)
        self.assertEqual(len(history["auctions"]), 10)
        self.assertTrue(all("bids" in auction for auction in history["auctions"]))
        anonymous = Client(self.base_url)
        self.assertEqual(anonymous.request("auction/history")[0], 401)

    def test_team_rename_and_admin_account_release(self) -> None:
        self.alpha.request(
            "register",
            "POST",
            {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
        )
        self.bravo.request(
            "register",
            "POST",
            {"username": "bravo", "password": "pass2", "team_name": "Bravo FC"},
        )
        self.login(self.alpha, "alpha", "pass1")
        self.login(self.admin, "admin", "admin123")
        self.assertEqual(
            self.alpha.request("team/name", "POST", {"name": "Renamed FC"})[0], 200
        )
        _, profile = self.alpha.request("me")
        self.assertEqual(profile["user"]["team_name"], "Renamed FC")
        _, teams_payload = self.admin.request("admin/teams")
        teams = {item["username"]: item for item in teams_payload["teams"]}
        team = teams["alpha"]
        bravo_team = teams["bravo"]
        self.assertEqual(team["username"], "alpha")
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        db = app.connect()
        try:
            db.execute("UPDATE teams SET funds = 650 WHERE id = ?", (team["id"],))
            db.executemany(
                """
                INSERT INTO roster(team_id, player_id, acquired_price, acquired_at)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (team["id"], players[0]["id"], 120, int(time.time())),
                    (team["id"], players[1]["id"], 230, int(time.time())),
                ],
            )
            auction_id = db.execute(
                """
                INSERT INTO auctions(
                    player_id, auction_type, status, start_price, min_increment,
                    duration_seconds, starts_at, ends_at, created_at
                ) VALUES (?, 'open', 'active', 100, 10, 30, ?, ?, ?)
                """,
                (
                    players[2]["id"],
                    int(time.time()),
                    int(time.time()) + 30,
                    int(time.time()),
                ),
            ).lastrowid
            db.execute(
                """
                INSERT INTO bids(auction_id, team_id, user_id, amount, created_at)
                VALUES (?, ?, ?, 300, ?)
                """,
                (auction_id, team["id"], team["participant_user_id"], int(time.time())),
            )
            db.execute(
                """
                INSERT INTO bids(auction_id, team_id, user_id, amount, created_at)
                VALUES (?, ?, ?, 250, ?)
                """,
                (
                    auction_id,
                    bravo_team["id"],
                    bravo_team["participant_user_id"],
                    int(time.time()),
                ),
            )
            db.commit()
        finally:
            db.close()
        _, teams_payload = self.admin.request("admin/teams")
        self.assertEqual(teams_payload["teams"][0]["roster_count"], 2)
        self.assertEqual(teams_payload["teams"][0]["roster_value"], 350)
        status, released = self.admin.request(
            "admin/participant/release", "POST", {"team_id": team["id"]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(released["released_players"], 2)
        self.assertEqual(released["deleted_bids"], 1)
        self.assertEqual(released["refunded_amount"], 350)
        self.assertEqual(released["funds"], 1000)
        _, released_profile = self.alpha.request("me")
        self.assertIsNone(released_profile["user"])
        self.assertEqual(self.alpha.request("auction")[0], 401)
        _, teams_payload = self.admin.request("admin/teams")
        self.assertIsNone(teams_payload["teams"][0]["participant_user_id"])
        self.assertIsNone(teams_payload["teams"][0]["username"])
        self.assertEqual(teams_payload["teams"][0]["funds"], 1000)
        self.assertEqual(teams_payload["teams"][0]["roster_count"], 0)
        _, admin_roster = self.admin.request(f"roster?team_id={team['id']}")
        self.assertEqual(admin_roster["roster"], [])
        _, player_pool = self.admin.request("players")
        ownership = {player["id"]: player["owned"] for player in player_pool["players"]}
        self.assertFalse(ownership[players[0]["id"]])
        self.assertFalse(ownership[players[1]["id"]])
        _, auction = self.admin.request("auction")
        self.assertEqual(len(auction["active"]["bids"]), 1)
        self.assertEqual(auction["active"]["bids"][0]["team_name"], "Bravo FC")
        self.assertEqual(auction["active"]["bids"][0]["amount"], 250)
        self.assertNotIn(team["id"], {item["id"] for item in auction["teams"]})
        self.assertIn(bravo_team["id"], {item["id"] for item in auction["teams"]})
        db = app.connect()
        try:
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) AS count FROM users WHERE id = ?",
                    (team["participant_user_id"],),
                ).fetchone()["count"],
                0,
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) AS count FROM bids WHERE user_id = ?",
                    (team["participant_user_id"],),
                ).fetchone()["count"],
                0,
            )
        finally:
            db.close()

    def test_startup_removes_legacy_released_accounts_and_their_bids(self) -> None:
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        db = app.connect()
        try:
            team_id = db.execute("INSERT INTO teams(name) VALUES ('Legacy FC')").lastrowid
            user_id = db.execute(
                """
                INSERT INTO users(username, password_hash, role, team_id)
                VALUES ('released-9-legacy', ?, 'participant', NULL)
                """,
                (app.hash_password("pass1"),),
            ).lastrowid
            auction_id = db.execute(
                """
                INSERT INTO auctions(
                    player_id, auction_type, status, start_price, min_increment,
                    duration_seconds, created_at
                ) VALUES (?, 'open', 'sold', 100, 10, 30, ?)
                """,
                (players[0]["id"], int(time.time())),
            ).lastrowid
            db.execute(
                """
                INSERT INTO bids(auction_id, team_id, user_id, amount, created_at)
                VALUES (?, ?, ?, 200, ?)
                """,
                (auction_id, team_id, user_id, int(time.time())),
            )
            db.commit()
        finally:
            db.close()

        app.init_database()
        db = app.connect()
        try:
            self.assertEqual(
                db.execute("SELECT COUNT(*) AS count FROM users WHERE id = ?", (user_id,)).fetchone()["count"],
                0,
            )
            self.assertEqual(
                db.execute("SELECT COUNT(*) AS count FROM bids WHERE user_id = ?", (user_id,)).fetchone()["count"],
                0,
            )
        finally:
            db.close()

    def test_admin_can_release_one_player_and_refund_original_price(self) -> None:
        self.alpha.request(
            "register",
            "POST",
            {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
        )
        self.login(self.alpha, "alpha", "pass1")
        self.login(self.admin, "admin", "admin123")
        _, teams_payload = self.admin.request("admin/teams")
        team_id = teams_payload["teams"][0]["id"]
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        db = app.connect()
        try:
            db.execute("UPDATE teams SET funds = 700 WHERE id = ?", (team_id,))
            db.executemany(
                """
                INSERT INTO roster(team_id, player_id, acquired_price, acquired_at)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (team_id, players[0]["id"], 100, int(time.time())),
                    (team_id, players[1]["id"], 200, int(time.time())),
                ],
            )
            db.commit()
        finally:
            db.close()

        status, released = self.admin.request(
            "admin/player/release",
            "POST",
            {"team_id": team_id, "player_id": players[0]["id"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(released["player_id"], players[0]["id"])
        self.assertEqual(released["refunded_amount"], 100)
        self.assertEqual(released["funds"], 800)
        _, roster = self.alpha.request("roster")
        self.assertEqual([item["player_id"] for item in roster["roster"]], [players[1]["id"]])
        self.assertEqual(roster["team"]["funds"], 800)
        _, player_pool = self.admin.request("players")
        ownership = {player["id"]: player["owned"] for player in player_pool["players"]}
        self.assertFalse(ownership[players[0]["id"]])
        self.assertTrue(ownership[players[1]["id"]])
        status, _ = self.admin.request(
            "admin/player/release",
            "POST",
            {"team_id": team_id, "player_id": players[0]["id"]},
        )
        self.assertEqual(status, 404)
        self.assertEqual(
            self.alpha.request(
                "admin/player/release",
                "POST",
                {"team_id": team_id, "player_id": players[1]["id"]},
            )[0],
            403,
        )

    def test_two_team_trade_can_be_rejected_or_completed_atomically(self) -> None:
        for client, username, password, team_name in [
            (self.alpha, "alpha", "pass1", "Alpha FC"),
            (self.bravo, "bravo", "pass2", "Bravo FC"),
        ]:
            self.assertEqual(
                client.request(
                    "register",
                    "POST",
                    {"username": username, "password": password, "team_name": team_name},
                )[0],
                201,
            )
            self.login(client, username, password)
        self.login(self.admin, "admin", "admin123")
        _, teams_payload = self.admin.request("admin/teams")
        teams = {team["name"]: team for team in teams_payload["teams"]}
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        db = app.connect()
        try:
            db.execute("UPDATE teams SET funds = 1000 WHERE id = ?", (teams["Alpha FC"]["id"],))
            db.execute("UPDATE teams SET funds = 800 WHERE id = ?", (teams["Bravo FC"]["id"],))
            db.executemany(
                """
                INSERT INTO roster(team_id, player_id, acquired_price, acquired_at)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (teams["Alpha FC"]["id"], players[0]["id"], 120, int(time.time())),
                    (teams["Bravo FC"]["id"], players[1]["id"], 230, int(time.time())),
                ],
            )
            db.commit()
        finally:
            db.close()
        proposal = {
            "legs": [
                {
                    "from_team_id": teams["Alpha FC"]["id"],
                    "to_team_id": teams["Bravo FC"]["id"],
                    "cash_amount": 100,
                    "player_ids": [players[0]["id"]],
                },
                {
                    "from_team_id": teams["Bravo FC"]["id"],
                    "to_team_id": teams["Alpha FC"]["id"],
                    "cash_amount": 50,
                    "player_ids": [players[1]["id"]],
                },
            ]
        }
        status, created = self.alpha.request("trade/create", "POST", proposal)
        self.assertEqual(status, 201)
        trade_id = created["trade"]["id"]
        responses = {
            participant["team_name"]: participant["response"]
            for participant in created["trade"]["participants"]
        }
        self.assertEqual(responses, {"Alpha FC": "accepted", "Bravo FC": "pending"})
        status, rejected = self.bravo.request(
            "trade/respond", "POST", {"trade_id": trade_id, "decision": "rejected"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(rejected["trade"]["status"], "rejected")

        status, created = self.alpha.request("trade/create", "POST", proposal)
        self.assertEqual(status, 201)
        trade_id = created["trade"]["id"]
        status, accepted = self.bravo.request(
            "trade/respond", "POST", {"trade_id": trade_id, "decision": "accepted"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(accepted["trade"]["status"], "completed")
        _, alpha_roster = self.alpha.request("roster")
        _, bravo_roster = self.bravo.request("roster")
        self.assertEqual(alpha_roster["team"]["funds"], 950)
        self.assertEqual(bravo_roster["team"]["funds"], 850)
        self.assertEqual(alpha_roster["roster"][0]["player_id"], players[1]["id"])
        self.assertEqual(alpha_roster["roster"][0]["acquired_price"], 230)
        self.assertEqual(bravo_roster["roster"][0]["player_id"], players[0]["id"])
        self.assertEqual(bravo_roster["roster"][0]["acquired_price"], 120)
        self.assertEqual(alpha_roster["roster"][0]["lineup_role"], "bench")
        self.assertEqual(bravo_roster["roster"][0]["lineup_role"], "bench")

        status, stale_trade = self.alpha.request(
            "trade/create",
            "POST",
            {
                "legs": [
                    {
                        "from_team_id": teams["Alpha FC"]["id"],
                        "to_team_id": teams["Bravo FC"]["id"],
                        "cash_amount": 900,
                        "player_ids": [],
                    },
                    {
                        "from_team_id": teams["Bravo FC"]["id"],
                        "to_team_id": teams["Alpha FC"]["id"],
                        "cash_amount": 0,
                        "player_ids": [],
                    },
                ]
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(
            self.admin.request(
                "admin/funds",
                "POST",
                {"team_id": teams["Alpha FC"]["id"], "funds": 100},
            )[0],
            200,
        )
        status, invalid = self.bravo.request(
            "trade/respond",
            "POST",
            {"trade_id": stale_trade["trade"]["id"], "decision": "accepted"},
        )
        self.assertEqual(status, 409)
        self.assertIn("交易资金不足", invalid["error"])
        _, alpha_trades = self.alpha.request("trades")
        invalid_trade = next(
            trade for trade in alpha_trades["trades"] if trade["id"] == stale_trade["trade"]["id"]
        )
        self.assertEqual(invalid_trade["status"], "invalid")
        self.assertEqual(self.alpha.request("roster")[1]["team"]["funds"], 100)
        self.assertEqual(self.bravo.request("roster")[1]["team"]["funds"], 850)

    def test_three_team_trade_completes_only_after_every_team_accepts(self) -> None:
        registrations = [
            (self.alpha, "alpha", "pass1", "Alpha FC"),
            (self.bravo, "bravo", "pass2", "Bravo FC"),
            (self.charlie, "charlie", "pass3", "Charlie FC"),
        ]
        for client, username, password, team_name in registrations:
            self.assertEqual(
                client.request(
                    "register",
                    "POST",
                    {"username": username, "password": password, "team_name": team_name},
                )[0],
                201,
            )
            self.login(client, username, password)
        self.login(self.admin, "admin", "admin123")
        _, teams_payload = self.admin.request("admin/teams")
        teams = {team["name"]: team for team in teams_payload["teams"]}
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        team_names = ["Alpha FC", "Bravo FC", "Charlie FC"]
        db = app.connect()
        try:
            for index, team_name in enumerate(team_names):
                db.execute("UPDATE teams SET funds = 500 WHERE id = ?", (teams[team_name]["id"],))
                db.execute(
                    """
                    INSERT INTO roster(team_id, player_id, acquired_price, acquired_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (teams[team_name]["id"], players[index]["id"], 100 + index, int(time.time())),
                )
            db.commit()
        finally:
            db.close()
        proposal = {
            "legs": [
                {
                    "from_team_id": teams["Alpha FC"]["id"],
                    "to_team_id": teams["Bravo FC"]["id"],
                    "cash_amount": 10,
                    "player_ids": [players[0]["id"]],
                },
                {
                    "from_team_id": teams["Bravo FC"]["id"],
                    "to_team_id": teams["Charlie FC"]["id"],
                    "cash_amount": 20,
                    "player_ids": [players[1]["id"]],
                },
                {
                    "from_team_id": teams["Charlie FC"]["id"],
                    "to_team_id": teams["Alpha FC"]["id"],
                    "cash_amount": 30,
                    "player_ids": [players[2]["id"]],
                },
            ]
        }
        status, created = self.alpha.request("trade/create", "POST", proposal)
        self.assertEqual(status, 201)
        trade_id = created["trade"]["id"]
        status, waiting = self.bravo.request(
            "trade/respond", "POST", {"trade_id": trade_id, "decision": "accepted"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(waiting["trade"]["status"], "pending")
        status, completed = self.charlie.request(
            "trade/respond", "POST", {"trade_id": trade_id, "decision": "accepted"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(completed["trade"]["status"], "completed")
        rosters = {}
        for client, _, _, team_name in registrations:
            rosters[team_name] = client.request("roster")[1]
        self.assertEqual(rosters["Alpha FC"]["team"]["funds"], 520)
        self.assertEqual(rosters["Bravo FC"]["team"]["funds"], 490)
        self.assertEqual(rosters["Charlie FC"]["team"]["funds"], 490)
        self.assertEqual(rosters["Alpha FC"]["roster"][0]["player_id"], players[2]["id"])
        self.assertEqual(rosters["Bravo FC"]["roster"][0]["player_id"], players[0]["id"])
        self.assertEqual(rosters["Charlie FC"]["roster"][0]["player_id"], players[1]["id"])

    def test_direct_start_manual_settlement_and_withdrawal(self) -> None:
        self.assertEqual(
            self.alpha.request(
                "register",
                "POST",
                {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
            )[0],
            201,
        )
        self.login(self.admin, "admin", "admin123")
        self.login(self.alpha, "alpha", "pass1")
        _, teams_payload = self.admin.request("admin/teams")
        team_id = teams_payload["teams"][0]["id"]
        self.assertEqual(
            self.admin.request(
                "admin/funds", "POST", {"team_id": team_id, "funds": 1000}
            )[0],
            200,
        )
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        status, started = self.admin.request(
            "admin/auction/queue",
            "POST",
            {
                "player_id": players[0]["id"],
                "start_price": 100,
                "min_increment": 10,
                "start_immediately": True,
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(started["status"], "active")
        _, market = self.admin.request("auction")
        self.assertEqual(market["active"]["duration_seconds"], 30)
        self.assertEqual(market["queued"], [])
        status, rejected = self.alpha.request(
            "bid", "POST", {"amount": 100, "auction_id": started["auction_id"] + 1}
        )
        self.assertEqual(status, 409)
        self.assertIn("场次已变化", rejected["error"])

        status, rejected = self.admin.request("admin/auction/settle", "POST", {})
        self.assertEqual(status, 409)
        self.assertIn("没有有效报价", rejected["error"])
        self.assertEqual(self.alpha.request("bid", "POST", {"amount": 100})[0], 201)
        self.assertEqual(
            self.admin.request("admin/auction/settle", "POST", {})[0], 200
        )
        _, settled = self.admin.request("auction")
        self.assertIsNone(settled["active"])
        self.assertEqual(settled["recent"][0]["status"], "sold")
        self.assertEqual(settled["recent"][0]["final_price"], 100)

        status, second = self.admin.request(
            "admin/auction/queue",
            "POST",
            {
                "player_id": players[1]["id"],
                "start_price": 120,
                "min_increment": 10,
                "duration_seconds": 30,
                "start_immediately": True,
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(self.alpha.request("bid", "POST", {"amount": 120})[0], 201)
        self.assertEqual(
            self.admin.request("admin/auction/withdraw", "POST", {})[0], 200
        )
        _, withdrawn = self.admin.request("auction")
        self.assertIsNone(withdrawn["active"])
        self.assertEqual(withdrawn["queued"][0]["id"], second["auction_id"])
        db = app.connect()
        try:
            bid_count = db.execute(
                "SELECT COUNT(*) AS count FROM bids WHERE auction_id = ?",
                (second["auction_id"],),
            ).fetchone()["count"]
        finally:
            db.close()
        self.assertEqual(bid_count, 0)

    def test_seed_has_expected_player_shape(self) -> None:
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        self.assertEqual(len(players), 312)
        self.assertEqual(len({player["id"] for player in players}), 312)
        self.assertTrue(all(len(player["stats"]) == 6 for player in players))
        self.assertTrue(all(player["photo_path"] for player in players))
        self.assertTrue(all(player["nationality"] for player in players))
        self.assertTrue(all(player["club"] for player in players))
        db = app.connect()
        try:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(auctions)")}
        finally:
            db.close()
        self.assertIn("auction_type", columns)

    def test_static_server_does_not_expose_parent_files(self) -> None:
        request = urllib.request.Request(f"{self.base_url}/../app.py")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(raised.exception.code, 404)
        raised.exception.close()


if __name__ == "__main__":
    unittest.main()
