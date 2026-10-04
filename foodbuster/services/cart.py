"""Shared cart: every guest edits only their own lines; prices and КБЖУ are frozen at the moment of adding."""

from __future__ import annotations

import contextlib
import sqlite3
from collections import defaultdict
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import clean_text, iso, jdump, jload, new_id, normalize_text, now_utc
from foodbuster.db.database import Database
from foodbuster.domain.allergens import effective_allergens
from foodbuster.domain.options import resolve_choices, totals
from foodbuster.services.context import GuestCtx
from foodbuster.services.menu import MenuService
from foodbuster.services.sessions import SessionService


class CartService:
    def __init__(self, db: Database, menu: MenuService, sessions: SessionService) -> None:
        self.db = db
        self.menu = menu
        self.sessions = sessions

    def _validate_shared(self, conn: sqlite3.Connection, ctx: GuestCtx, shared_with: list[str]) -> list[str]:
        if not shared_with:
            return []
        ids = {r["id"] for r in conn.execute("SELECT id FROM participants WHERE session_id=?", (ctx.sid,)).fetchall()}
        clean = []
        for pid in shared_with:
            if pid == ctx.pid:
                continue
            if pid not in ids:
                raise ApiError(422, "unknown_participant", "Этого человека нет за столом")
            if pid not in clean:
                clean.append(pid)
        return clean

    def add(self, ctx: GuestCtx, menu_item_id: int, qty: int, options: dict[str, list[str]], note: str, shared_with: list[str]) -> str:
        self.sessions.require_open(ctx.session)
        item = self.menu.get(menu_item_id)
        if not item["available"]:
            raise ApiError(409, "dish_unavailable", f"«{item['name']}» сейчас закончилось — выберите другое блюдо")
        chosen = resolve_choices(item, options)
        contains, traces = effective_allergens(item["allergens"], item["traces"], chosen)
        portion = totals(item, chosen)
        unit_price = portion["price"]
        note = clean_text(note, settings.max_note_length)
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            shared = self._validate_shared(conn, ctx, shared_with)
            key = "|".join(sorted(f"{c['group_id']}:{c['id']}" for c in chosen)) + "#" + normalize_text(note) + "#" + ",".join(sorted(shared))
            existing = conn.execute(
                """SELECT * FROM cart_items WHERE participant_id=? AND menu_item_id=? AND options_key=? AND unit_price=? AND menu_version=?""",
                (ctx.pid, menu_item_id, key, unit_price, item["version"]),
            ).fetchone()
            if existing:
                new_qty = existing["qty"] + qty
                if new_qty > settings.max_qty_per_line:
                    raise ApiError(422, "qty_limit", f"Не больше {settings.max_qty_per_line} шт. одной позиции")
                conn.execute("UPDATE cart_items SET qty=?, updated_at=? WHERE id=?", (new_qty, stamp, existing["id"]))
                line_id = existing["id"]
            else:
                lines = conn.execute("SELECT count(*) AS n FROM cart_items WHERE participant_id=?", (ctx.pid,)).fetchone()["n"]
                if lines >= settings.max_cart_lines_per_participant:
                    raise ApiError(409, "cart_limit", "В корзине слишком много позиций — отправьте часть заказа")
                line_id = new_id("ci")
                conn.execute(
                    """INSERT INTO cart_items(id, session_id, participant_id, menu_item_id, menu_version, name, emoji, category_code, base_price,
                       unit_price, kcal, protein, fat, carbs, allergens_json, traces_json, options_json, options_key, cook_minutes, qty, note,
                       shared_with_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (line_id, ctx.sid, ctx.pid, item["id"], item["version"], item["name"], item["emoji"], item["category_code"], item["price"],
                     unit_price, portion["kcal"], portion["protein"], portion["fat"], portion["carbs"],
                     jdump(contains), jdump(traces), jdump(chosen), key, item["cook_minutes"], qty, note, jdump(shared), stamp, stamp),
                )
            conn.execute("UPDATE participants SET ready=0 WHERE id=?", (ctx.pid,))
            conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (stamp, ctx.sid))
        verb = "добавил(а)" if not shared else "добавил(а) на компанию"
        self.sessions.notify(ctx.sid, "cart", f"{ctx.participant['name']} {verb} «{item['name']}»", ctx.participant, staff=False,
                             extra={"menu_item_id": item["id"]})
        return line_id

    def _own_line(self, conn: sqlite3.Connection, ctx: GuestCtx, line_id: str) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM cart_items WHERE id=? AND session_id=?", (line_id, ctx.sid)).fetchone()
        if not row:
            raise ApiError(404, "line_not_found", "Позиция уже отправлена на кухню или удалена")
        if row["participant_id"] != ctx.pid:
            raise ApiError(403, "not_your_line", "Менять можно только свои позиции — попросите автора")
        return row

    def update(self, ctx: GuestCtx, line_id: str, qty: Optional[int], note: Optional[str], shared_with: Optional[list[str]]) -> None:
        self.sessions.require_open(ctx.session)
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            row = self._own_line(conn, ctx, line_id)
            if qty is not None and qty <= 0:
                conn.execute("DELETE FROM cart_items WHERE id=?", (line_id,))
                text = f"{ctx.participant['name']} убрал(а) «{row['name']}»"
            else:
                new_note = row["note"] if note is None else clean_text(note, settings.max_note_length)
                new_shared = jload(row["shared_with_json"], []) if shared_with is None else self._validate_shared(conn, ctx, shared_with)
                new_qty = row["qty"] if qty is None else qty
                if new_qty > settings.max_qty_per_line:
                    raise ApiError(422, "qty_limit", f"Не больше {settings.max_qty_per_line} шт. одной позиции")
                options = jload(row["options_json"], [])
                key = "|".join(sorted(f"{c['group_id']}:{c['id']}" for c in options)) + "#" + normalize_text(new_note) + "#" + ",".join(sorted(new_shared))
                conn.execute(
                    "UPDATE cart_items SET qty=?, note=?, shared_with_json=?, options_key=?, updated_at=? WHERE id=?",
                    (new_qty, new_note, jdump(new_shared), key, stamp, line_id),
                )
                text = f"{ctx.participant['name']} изменил(а) «{row['name']}»"
                if shared_with is not None and new_shared:
                    text = f"{ctx.participant['name']} делит «{row['name']}» на {len(new_shared) + 1}"
            conn.execute("UPDATE participants SET ready=0 WHERE id=?", (ctx.pid,))
        self.sessions.notify(ctx.sid, "cart", text, ctx.participant, staff=False)

    def remove(self, ctx: GuestCtx, line_id: str) -> None:
        self.update(ctx, line_id, 0, None, None)

    def repeat(self, ctx: GuestCtx, order_id: str) -> int:
        self.sessions.require_open(ctx.session)
        rows = self.db.all("SELECT * FROM order_items WHERE order_id=? AND session_id=? AND participant_id=? AND status<>'cancelled'",
                           (order_id, ctx.sid, ctx.pid))
        if not rows:
            raise ApiError(404, "nothing_to_repeat", "В этом заказе нет ваших блюд")
        added = 0
        for row in rows:
            item = self.menu.index().get(row["menu_item_id"])
            if not item or not item["available"]:
                continue
            selected: dict[str, list[str]] = defaultdict(list)
            names = {(o["group"], o["choice"]) for o in jload(row["options_json"], [])}
            for group in item["options"]:
                for choice in group["choices"]:
                    if (group["name"], choice["name"]) in names:
                        selected[group["id"]].append(choice["id"])
            with contextlib.suppress(ApiError):
                self.add(ctx, item["id"], row["qty"], dict(selected), row["note"], [])
                added += 1
        if not added:
            raise ApiError(409, "repeat_unavailable", "Эти блюда сейчас недоступны")
        return added
