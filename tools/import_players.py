#!/usr/bin/env python3
"""Create the local 312-player seed snapshot from the public catalog."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


BASE_URL = "https://84452cup.com"
CATALOG_URL = f"{BASE_URL}/players/"
CARD_PATTERN = re.compile(
    r'<article class="catalog-player-card[^>]*>(.*?)</article>', re.DOTALL
)


def clean(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def first(pattern: str, source: str, default: str = "") -> str:
    match = re.search(pattern, source, re.DOTALL)
    return clean(match.group(1)) if match else default


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "AuctionMVP/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def parse_card(card: str) -> dict:
    title = first(r'<div class="catalog-card-link" title="([^"]+)"', card)
    corner = first(r'<div class="catalog-card-corner">(.*?)</div>\s*</div>', card)
    names = re.search(
        r'<div class="catalog-card-body">\s*<h3>(.*?)</h3>\s*<p>(.*?)</p>',
        card,
        re.DOTALL,
    )
    stats = {
        label: int(value)
        for value, label in re.findall(
            r'<div><b>(\d+)</b><span>([A-Z]+)</span></div>', card
        )
    }
    photo_match = re.search(r'<img class="catalog-card-photo" src="([^"]+)"', card)
    photo_url = urllib.parse.urljoin(BASE_URL, html.unescape(photo_match.group(1))) if photo_match else ""
    source_match = re.search(r"/avatars/(\d+)\.", photo_url)
    source_key = source_match.group(1) if source_match else hashlib.sha1(title.encode()).hexdigest()[:12]
    secondary = first(r'title="副位置：([^"]+)"', card)
    height_weight = re.search(r'aria-label="身高 (\d+)cm，体重 (\d+)kg"', card)
    roles = [clean(value) for value in re.findall(r'title="Role\+\+?：([^"]+)"', card)]

    return {
        "id": source_key,
        "name_zh": clean(names.group(1)) if names else title.split(" · ")[0],
        "name_en": clean(names.group(2)) if names else "",
        "category": first(r'<span class="catalog-category[^>]*>(.*?)</span>', card),
        "overall": int(first(r'<div class="catalog-card-corner">\s*<strong>(\d+)</strong>', card, "0")),
        "primary_position": first(r'<div class="catalog-card-corner">.*?<b>([^<]+)</b>', card),
        "secondary_positions": [value.strip() for value in secondary.split("/") if value.strip()],
        "nationality": first(r'<i class="nation" title="([^"]+)"', card),
        "club": first(r'<i class="club(?: fallback)?" title="([^"]+)"', card),
        "height_cm": int(height_weight.group(1)) if height_weight else None,
        "weight_kg": int(height_weight.group(2)) if height_weight else None,
        "stats": stats,
        "skill_moves": int(first(r'title="花式 (\d+) 星"', card, "0")),
        "weak_foot": int(first(r'title="逆足 (\d+) 星"', card, "0")),
        "gold_abilities": [value.strip() for value in first(r'title="金徽章：([^"]+)"', card).split("、") if value.strip()],
        "silver_abilities": [value.strip() for value in first(r'title="银徽章：([^"]+)"', card).split("、") if value.strip()],
        "roles": roles,
        "original_team": first(r'<footer><span>(.*?)</span></footer>', card),
        "photo_source_url": photo_url,
        "photo_path": f"/player-images/{source_key}.png" if photo_url else "",
    }


def download_photo(player: dict, image_dir: Path) -> tuple[str, bool]:
    if not player["photo_source_url"]:
        return player["id"], False
    destination = image_dir / f'{player["id"]}.png'
    if destination.exists() and destination.stat().st_size:
        return player["id"], True
    try:
        destination.write_bytes(fetch(player["photo_source_url"]))
        return player["id"], True
    except Exception:
        return player["id"], False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-dir", type=Path)
    args = parser.parse_args()

    players: list[dict] = []
    for page in range(1, 11):
        url = CATALOG_URL if page == 1 else f"{CATALOG_URL}?page={page}"
        page_html = fetch(url).decode("utf-8")
        players.extend(parse_card(card) for card in CARD_PATTERN.findall(page_html))

    if len(players) != 312:
        raise SystemExit(f"Expected 312 players, parsed {len(players)}")
    if len({player["id"] for player in players}) != 312:
        raise SystemExit("Player source keys are not unique")

    if args.image_dir:
        args.image_dir.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda player: download_photo(player, args.image_dir), players))
        downloaded = {player_id for player_id, ok in results if ok}
        for player in players:
            if player["id"] not in downloaded:
                player["photo_path"] = ""

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(players, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(players)} players to {args.output}")


if __name__ == "__main__":
    main()
