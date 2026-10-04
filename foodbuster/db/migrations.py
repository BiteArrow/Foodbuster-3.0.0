"""Idempotent, additive migrations: they run on every start and never drop guest or menu data."""

from __future__ import annotations

import sqlite3

from foodbuster.core.logging import log
from foodbuster.core.utils import iso, jdump, jload, now_utc
from foodbuster.domain.hallmap import free_map_spot
from foodbuster.domain.options import removal_group
from foodbuster.domain.reference import load_json

COLUMNS = {
    "dining_tables": {"map_x": "REAL", "map_y": "REAL", "is_archived": "INTEGER NOT NULL DEFAULT 0"},
}


def _done(conn: sqlite3.Connection, key: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM meta WHERE key=?", (key,)).fetchone())


def _mark(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, iso(now_utc())))


def add_columns(conn: sqlite3.Connection) -> None:
    for table, columns in COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column, ddl in columns.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def place_tables(conn: sqlite3.Connection) -> None:
    seeded = {t["label"]: (t["x"], t["y"]) for t in load_json("menu_seed.json")["tables"]}
    rows = conn.execute("SELECT id, label, map_x, map_y FROM dining_tables ORDER BY sort, id").fetchall()
    taken = [(r["map_x"], r["map_y"]) for r in rows if r["map_x"] is not None and r["map_y"] is not None]
    for row in rows:
        if row["map_x"] is not None and row["map_y"] is not None:
            continue
        x, y = seeded.get(row["label"]) or free_map_spot(taken)
        conn.execute("UPDATE dining_tables SET map_x=?, map_y=? WHERE id=?", (x, y, row["id"]))
        taken.append((x, y))


def removable_ingredients(conn: sqlite3.Connection) -> None:
    """Adds the «Убрать из блюда» group with real КБЖУ to dishes created before this feature."""
    if _done(conn, "removals_v1"):
        return
    rows = conn.execute("SELECT m.*, c.code AS category FROM menu_items m JOIN categories c ON c.id=m.category_id").fetchall()
    changed = 0
    for row in rows:
        options = [g for g in jload(row["options_json"], []) if not (g.get("id") == "without" and not any(c.get("kcal") for c in g.get("choices", [])))]
        if any(g.get("id") == "without" for g in options):
            continue
        dish = {"name": row["name"], "category": row["category"], "ingredients": jload(row["ingredients_json"], []), "price": row["price"],
                "kcal": row["kcal"], "protein": row["protein"], "fat": row["fat"], "carbs": row["carbs"], "weight_g": row["weight_g"]}
        group = removal_group(dish)
        if group:
            options.append(group)
        if jdump(options) != row["options_json"]:
            conn.execute("UPDATE menu_items SET options_json=?, version=version+1 WHERE id=?", (jdump(options), row["id"]))
            changed += 1
    _mark(conn, "removals_v1")
    if changed:
        log.info("Removable ingredients added to %d dishes", changed)


def migrate(conn: sqlite3.Connection) -> None:
    add_columns(conn)
    place_tables(conn)
    removable_ingredients(conn)
