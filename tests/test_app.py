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

        with ThreadPoolExecutor(max_workers=2) as executor:
            simultaneous = list(
                executor.map(
                    lambda client: client.request("bid", "POST", {"amount": 200})[0],
                    [self.alpha, self.bravo],
                )
            )
        self.assertEqual(sorted(simultaneous), [201, 400])
        self.assertEqual(self.bravo.request("bid", "POST", {"amount": 250})[0], 201)
        status, rejected = self.alpha.request("bid", "POST", {"amount": 255})
        self.assertEqual(status, 400)
        self.assertIn("最低有效报价", rejected["error"])

        _, live = self.alpha.request("auction")
        self.assertEqual(live["active"]["bids"][0]["team_name"], "Bravo FC")
        self.assertEqual(live["active"]["bids"][0]["amount"], 250)
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
        _, result = self.alpha.request("auction")
        self.assertIsNone(result["active"])
        self.assertEqual(result["recent"][0]["winner_team_name"], "Bravo FC")
        self.assertEqual(result["recent"][0]["final_price"], 250)

        _, roster = self.bravo.request("roster")
        self.assertEqual(roster["team"]["funds"], 750)
        self.assertEqual(len(roster["roster"]), 1)
        self.assertEqual(roster["roster"][0]["lineup_role"], "bench")
        self.assertEqual(
            self.bravo.request("lineup/toggle", "POST", {"player_id": player_id})[0], 200
        )
        _, lineup = self.bravo.request("roster")
        self.assertEqual(lineup["roster"][0]["lineup_role"], "starter")

    def test_participant_cannot_use_admin_routes(self) -> None:
        self.alpha.request(
            "register",
            "POST",
            {"username": "alpha", "password": "pass1", "team_name": "Alpha FC"},
        )
        self.login(self.alpha, "alpha", "pass1")
        status, _ = self.alpha.request("admin/teams")
        self.assertEqual(status, 403)

    def test_seed_has_expected_player_shape(self) -> None:
        players = json.loads(app.PLAYER_SEED.read_text(encoding="utf-8"))
        self.assertEqual(len(players), 312)
        self.assertEqual(len({player["id"] for player in players}), 312)
        self.assertTrue(all(len(player["stats"]) == 6 for player in players))
        self.assertTrue(all(player["photo_path"] for player in players))

    def test_static_server_does_not_expose_parent_files(self) -> None:
        request = urllib.request.Request(f"{self.base_url}/../app.py")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(raised.exception.code, 404)
        raised.exception.close()


if __name__ == "__main__":
    unittest.main()
