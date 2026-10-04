"""Restaurant administration: menu CRUD with allergens and КБЖУ, categories, tables and QR codes (up to settings.max_tables)."""

from __future__ import annotations

import base64
import contextlib
import re
import secrets
import sqlite3
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import clamp, clean_text, iso, jdump, jload, normalize_text, now_utc
from foodbuster.db.database import Database, audit
from foodbuster.domain.hallmap import free_map_spot, grid_layout
from foodbuster.domain.reference import validate_allergen_codes, validate_diet_codes
from foodbuster.services.context import StaffCtx
from foodbuster.services.menu import MenuService
from foodbuster.services.realtime import EventBus
from foodbuster.services.sessions import SessionService


IMAGE_SIGNATURES = {"png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff", "webp": b"RIFF"}


def name_clash(conn: sqlite3.Connection, sql: str, params: tuple, value: str) -> bool:
    target = normalize_text(value)
    return any(normalize_text(row["name"]) == target for row in conn.execute(sql, params).fetchall())


class AdminService:
    def __init__(self, db: Database, bus: EventBus, menu: MenuService, sessions: SessionService) -> None:
        self.db = db
        self.bus = bus
        self.menu = menu
        self.sessions = sessions

    def _normalize_options(self, groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result, used_groups = [], set()
        for group in groups:
            gid = re.sub(r"[^a-z0-9_-]", "", (group.get("id") or "").lower())[:24] or f"g{secrets.token_hex(3)}"
            while gid in used_groups:
                gid = f"g{secrets.token_hex(3)}"
            used_groups.add(gid)
            choices, used = [], set()
            for choice in group["choices"]:
                cid = re.sub(r"[^a-z0-9_-]", "", (choice.get("id") or "").lower())[:24] or f"c{secrets.token_hex(3)}"
                while cid in used:
                    cid = f"c{secrets.token_hex(3)}"
                used.add(cid)
                choices.append({
                    "id": cid, "name": clean_text(choice["name"], 40), "price": int(choice.get("price_tiyn", 0)), "weight_g": int(choice.get("weight_g", 0)),
                    "kcal": int(choice.get("kcal", 0)), "protein": round(float(choice.get("protein", 0)), 1),
                    "fat": round(float(choice.get("fat", 0)), 1), "carbs": round(float(choice.get("carbs", 0)), 1),
                    "add_allergens": validate_allergen_codes(choice.get("add_allergens") or []),
                    "remove_allergens": validate_allergen_codes(choice.get("remove_allergens") or []),
                    "add_traces": validate_allergen_codes(choice.get("add_traces") or []),
                })
            if not choices:
                raise ApiError(422, "options_empty", f"В группе «{group['name']}» нет вариантов")
            kind = group.get("type", "single")
            result.append({"id": gid, "name": clean_text(group["name"], 40), "type": kind, "required": bool(group.get("required")) and kind == "single",
                           "max": 1 if kind == "single" else int(clamp(group.get("max") or len(choices), 1, len(choices))), "choices": choices})
        return result

    def save_item(self, data: dict[str, Any], actor: StaffCtx, item_id: Optional[int] = None) -> dict[str, Any]:
        category = self.db.one("SELECT * FROM categories WHERE id=? AND restaurant_id=?", (data["category_id"], self.menu.restaurant_id))
        if not category:
            raise ApiError(422, "category_invalid", "Выберите категорию")
        allergens = validate_allergen_codes(data.get("allergens") or [])
        traces = [c for c in validate_allergen_codes(data.get("traces") or []) if c not in allergens]
        diets = validate_diet_codes(data.get("diets") or [])
        if "vegan" in diets and set(allergens) & {"milk", "eggs", "fish", "crustaceans", "molluscs"}:
            raise ApiError(422, "vegan_conflict", "Веганское блюдо не может содержать молоко, яйца, рыбу или морепродукты")
        ingredients = []
        for raw in data.get("ingredients") or []:
            value = clean_text(raw, 40)
            if value and value.lower() not in [i.lower() for i in ingredients]:
                ingredients.append(value)
        kcal = data.get("kcal")
        if kcal is None:
            kcal = int(round(4 * data["protein"] + 9 * data["fat"] + 4 * data["carbs"]))
        options = self._normalize_options(data.get("options") or [])
        stamp = iso(now_utc())
        values = {
            "category_id": category["id"], "name": clean_text(data["name"], 80), "description": clean_text(data.get("description"), 400),
            "ingredients_json": jdump(ingredients), "price": int(data["price_tiyn"]), "weight_g": int(data.get("weight_g") or 0),
            "kcal": int(kcal), "protein": round(float(data["protein"]), 1), "fat": round(float(data["fat"]), 1), "carbs": round(float(data["carbs"]), 1),
            "allergens_json": jdump(allergens), "traces_json": jdump(traces), "diets_json": jdump(diets), "options_json": jdump(options),
            "cook_minutes": int(data["cook_minutes"]), "emoji": clean_text(data.get("emoji") or "🍽", 8) or "🍽",
            "is_popular": 1 if data.get("popular") else 0, "is_new": 1 if data.get("new") else 0,
            "is_available": 1 if data.get("available", True) else 0,
        }
        if not values["name"]:
            raise ApiError(422, "name_required", "Название блюда обязательно")
        with self.db.tx() as conn:
            if name_clash(conn, "SELECT name FROM menu_items WHERE restaurant_id=? AND is_archived=0 AND id<>?",
                          (self.menu.restaurant_id, item_id or 0), values["name"]):
                raise ApiError(409, "name_taken", f"Блюдо «{values['name']}» уже есть в меню")
            if item_id is None:
                sort = conn.execute("SELECT coalesce(max(sort),0)+1 AS s FROM menu_items WHERE restaurant_id=?", (self.menu.restaurant_id,)).fetchone()["s"]
                columns = list(values) + ["restaurant_id", "sort", "created_at", "updated_at"]
                params = list(values.values()) + [self.menu.restaurant_id, sort, stamp, stamp]
                item_id = conn.execute(f"INSERT INTO menu_items({', '.join(columns)}) VALUES ({','.join('?' * len(columns))})", params).lastrowid
                action = "dish_created"
            else:
                existing = conn.execute("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", (item_id, self.menu.restaurant_id)).fetchone()
                if not existing:
                    raise ApiError(404, "dish_not_found", "Блюдо не найдено")
                changed = {k: v for k, v in values.items() if existing[k] != v}
                if not changed:
                    return self.menu.get(item_id, include_archived=True)
                conn.execute(f"UPDATE menu_items SET {', '.join(f'{k}=?' for k in changed)}, version=version+1, updated_at=? WHERE id=?",
                             (*changed.values(), stamp, item_id))
                action = "dish_updated"
            audit(conn, "staff", actor.actor, action, "menu_item", item_id, payload={"name": values["name"], "price": values["price"]})
        self.menu.invalidate(action)
        return self.menu.get(item_id, include_archived=True)

    def set_availability(self, item_id: int, available: bool, actor: StaffCtx) -> dict[str, Any]:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", (item_id, self.menu.restaurant_id)).fetchone()
            if not row:
                raise ApiError(404, "dish_not_found", "Блюдо не найдено")
            conn.execute("UPDATE menu_items SET is_available=?, version=version+1, updated_at=? WHERE id=?", (1 if available else 0, iso(now_utc()), item_id))
            audit(conn, "staff", actor.actor, "stop_list" if not available else "back_in_stock", "menu_item", item_id, payload={"name": row["name"]})
        self.menu.invalidate("availability")
        return self.menu.get(item_id, include_archived=True)

    def delete_item(self, item_id: int, actor: StaffCtx) -> dict[str, Any]:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", (item_id, self.menu.restaurant_id)).fetchone()
            if not row:
                raise ApiError(404, "dish_not_found", "Блюдо не найдено")
            used = conn.execute("SELECT count(*) AS n FROM order_items WHERE menu_item_id=?", (item_id,)).fetchone()["n"]
            sessions = [r["session_id"] for r in conn.execute("SELECT DISTINCT session_id FROM cart_items WHERE menu_item_id=?", (item_id,)).fetchall()]
            conn.execute("DELETE FROM cart_items WHERE menu_item_id=?", (item_id,))
            if used:
                conn.execute("UPDATE menu_items SET is_archived=1, is_available=0, version=version+1, updated_at=? WHERE id=?", (iso(now_utc()), item_id))
                mode = "archived"
            else:
                conn.execute("DELETE FROM menu_items WHERE id=?", (item_id,))
                mode = "deleted"
            audit(conn, "staff", actor.actor, f"dish_{mode}", "menu_item", item_id, payload={"name": row["name"], "orders": used})
        if mode == "deleted" and row["image_path"]:
            with contextlib.suppress(OSError):
                (settings.media_dir / row["image_path"]).unlink()
        for sid in sessions:
            self.sessions.notify(sid, "cart", f"«{row['name']}» убрали из меню — позиция удалена из корзины", staff=False)
        self.menu.invalidate("deleted")
        return {"mode": mode, "orders_with_dish": used}

    def restore_item(self, item_id: int, actor: StaffCtx) -> dict[str, Any]:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM menu_items WHERE id=? AND restaurant_id=? AND is_archived=1", (item_id, self.menu.restaurant_id)).fetchone()
            if not row:
                raise ApiError(404, "dish_not_found", "В архиве нет такого блюда")
            conn.execute("UPDATE menu_items SET is_archived=0, is_available=1, version=version+1, updated_at=? WHERE id=?", (iso(now_utc()), item_id))
            audit(conn, "staff", actor.actor, "dish_restored", "menu_item", item_id, payload={"name": row["name"]})
        self.menu.invalidate("restored")
        return self.menu.get(item_id, include_archived=True)

    def set_image(self, item_id: int, data_url: str, actor: StaffCtx) -> dict[str, Any]:
        match = re.match(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$", data_url or "")
        if not match:
            raise ApiError(422, "image_format", "Загрузите фото в формате JPG, PNG или WebP")
        try:
            blob = base64.b64decode(match.group(2), validate=False)
        except ValueError as exc:
            raise ApiError(422, "image_decode", "Файл повреждён — попробуйте другое фото") from exc
        if len(blob) > settings.max_image_bytes:
            raise ApiError(413, "image_large", f"Фото больше {settings.max_image_bytes // 1024 // 1024} МБ — уменьшите его")
        ext = "jpg" if match.group(1) in ("jpeg", "jpg") else match.group(1)
        if not blob.startswith(IMAGE_SIGNATURES[ext]) or (ext == "webp" and blob[8:12] != b"WEBP"):
            raise ApiError(422, "image_signature", "Содержимое файла не похоже на изображение")
        row = self.db.one("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", (item_id, self.menu.restaurant_id))
        if not row:
            raise ApiError(404, "dish_not_found", "Блюдо не найдено")
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        filename = f"dish-{item_id}-{secrets.token_hex(5)}.{ext}"
        (settings.media_dir / filename).write_bytes(blob)
        with self.db.tx() as conn:
            conn.execute("UPDATE menu_items SET image_path=?, version=version+1, updated_at=? WHERE id=?", (filename, iso(now_utc()), item_id))
            audit(conn, "staff", actor.actor, "dish_photo", "menu_item", item_id, payload={"bytes": len(blob)})
        if row["image_path"]:
            with contextlib.suppress(OSError):
                (settings.media_dir / row["image_path"]).unlink()
        self.menu.invalidate("photo")
        return self.menu.get(item_id, include_archived=True)

    def remove_image(self, item_id: int, actor: StaffCtx) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM menu_items WHERE id=? AND restaurant_id=?", (item_id, self.menu.restaurant_id))
        if not row:
            raise ApiError(404, "dish_not_found", "Блюдо не найдено")
        with self.db.tx() as conn:
            conn.execute("UPDATE menu_items SET image_path=NULL, version=version+1, updated_at=? WHERE id=?", (iso(now_utc()), item_id))
            audit(conn, "staff", actor.actor, "dish_photo_removed", "menu_item", item_id)
        if row["image_path"]:
            with contextlib.suppress(OSError):
                (settings.media_dir / row["image_path"]).unlink()
        self.menu.invalidate("photo")
        return self.menu.get(item_id, include_archived=True)

    def save_category(self, data: dict[str, Any], actor: StaffCtx, category_id: Optional[int] = None) -> dict[str, Any]:
        name = clean_text(data["name"], 40)
        if not name:
            raise ApiError(422, "name_required", "Введите название категории")
        emoji = clean_text(data.get("emoji") or "🍽", 8) or "🍽"
        with self.db.tx() as conn:
            if name_clash(conn, "SELECT name FROM categories WHERE restaurant_id=? AND id<>?", (self.menu.restaurant_id, category_id or 0), name):
                raise ApiError(409, "name_taken", f"Категория «{name}» уже есть")
            if category_id is None:
                sort = conn.execute("SELECT coalesce(max(sort),0)+1 AS s FROM categories WHERE restaurant_id=?", (self.menu.restaurant_id,)).fetchone()["s"]
                code = f"c{secrets.token_hex(3)}"
                category_id = conn.execute("INSERT INTO categories(restaurant_id, code, name, emoji, sort, is_active) VALUES (?,?,?,?,?,?)",
                                           (self.menu.restaurant_id, code, name, emoji, sort, 1 if data.get("active", True) else 0)).lastrowid
            else:
                if not conn.execute("SELECT 1 FROM categories WHERE id=? AND restaurant_id=?", (category_id, self.menu.restaurant_id)).fetchone():
                    raise ApiError(404, "category_not_found", "Категория не найдена")
                conn.execute("UPDATE categories SET name=?, emoji=?, is_active=? WHERE id=?", (name, emoji, 1 if data.get("active", True) else 0, category_id))
            audit(conn, "staff", actor.actor, "category_saved", "category", category_id, payload={"name": name})
        self.menu.invalidate("category")
        return next(c for c in self.menu.categories(include_inactive=True) if c["id"] == category_id)

    def delete_category(self, category_id: int, actor: StaffCtx) -> None:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM categories WHERE id=? AND restaurant_id=?", (category_id, self.menu.restaurant_id)).fetchone()
            if not row:
                raise ApiError(404, "category_not_found", "Категория не найдена")
            count = conn.execute("SELECT count(*) AS n FROM menu_items WHERE category_id=?", (category_id,)).fetchone()["n"]
            if count:
                raise ApiError(409, "category_not_empty", f"В категории {count} блюд(а) — перенесите их или скройте категорию")
            conn.execute("DELETE FROM categories WHERE id=?", (category_id,))
            audit(conn, "staff", actor.actor, "category_deleted", "category", category_id, payload={"name": row["name"]})
        self.menu.invalidate("category")

    def reorder_categories(self, ids: list[int], actor: StaffCtx) -> None:
        existing = {c["id"] for c in self.menu.categories(include_inactive=True)}
        if set(ids) != existing:
            raise ApiError(422, "reorder_invalid", "Передайте полный список категорий")
        with self.db.tx() as conn:
            conn.executemany("UPDATE categories SET sort=? WHERE id=?", [(i, cid) for i, cid in enumerate(ids)])
            audit(conn, "staff", actor.actor, "categories_reordered", "category", "")
        self.menu.invalidate("category")

    def tables(self, base_url: str) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM dining_tables WHERE restaurant_id=? AND is_archived=0 ORDER BY sort, id", (self.menu.restaurant_id,))
        open_sessions = {s["table_id"]: s for s in self.db.all("SELECT * FROM sessions WHERE restaurant_id=? AND status IN ('open','locked') AND table_id IS NOT NULL",
                                                                   (self.menu.restaurant_id,))}
        result = []
        for row in rows:
            session = open_sessions.get(row["id"])
            guests = self.db.scalar("SELECT count(*) FROM participants WHERE session_id=?", (session["id"],), 0) if session else 0
            result.append({"id": row["id"], "label": row["label"], "zone": row["zone"], "seats": row["seats"], "active": bool(row["is_active"]),
                           "x": row["map_x"], "y": row["map_y"], "join_url": f"{base_url}/t/{row['qr_token']}", "qr_url": f"/api/tables/{row['qr_token']}/qr.svg",
                           "busy": bool(session), "guests": guests, "session_code": session["code"] if session else None})
        return result

    def save_table(self, data: dict[str, Any], actor: StaffCtx, table_id: Optional[int] = None) -> None:
        label = clean_text(data["label"], 30)
        if not label:
            raise ApiError(422, "label_required", "Введите название стола")
        with self.db.tx() as conn:
            if name_clash(conn, "SELECT label AS name FROM dining_tables WHERE restaurant_id=? AND id<>?", (self.menu.restaurant_id, table_id or 0), label):
                raise ApiError(409, "label_taken", f"Стол «{label}» уже есть")
            if table_id is None:
                self._check_capacity(conn, 1)
                sort = conn.execute("SELECT coalesce(max(sort),0)+1 AS s FROM dining_tables WHERE restaurant_id=?", (self.menu.restaurant_id,)).fetchone()["s"]
                spots = [(r["map_x"], r["map_y"]) for r in conn.execute("SELECT map_x, map_y FROM dining_tables WHERE restaurant_id=? AND is_archived=0", (self.menu.restaurant_id,))]
                map_x, map_y = free_map_spot(spots)
                table_id = conn.execute(
                    "INSERT INTO dining_tables(restaurant_id, label, zone, seats, qr_token, is_active, sort, created_at, map_x, map_y) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (self.menu.restaurant_id, label, clean_text(data.get("zone"), 40), int(data["seats"]), secrets.token_urlsafe(9),
                     1 if data.get("active", True) else 0, sort, iso(now_utc()), map_x, map_y)).lastrowid
            else:
                row = conn.execute("SELECT * FROM dining_tables WHERE id=? AND restaurant_id=?", (table_id, self.menu.restaurant_id)).fetchone()
                if not row:
                    raise ApiError(404, "table_not_found", "Стол не найден")
                busy = conn.execute("SELECT 1 FROM sessions WHERE table_id=? AND status IN ('open','locked')", (table_id,)).fetchone()
                if busy and not data.get("active", True):
                    raise ApiError(409, "table_busy", "За столом сейчас гости — закройте стол перед отключением")
                conn.execute("UPDATE dining_tables SET label=?, zone=?, seats=?, is_active=? WHERE id=?",
                             (label, clean_text(data.get("zone"), 40), int(data["seats"]), 1 if data.get("active", True) else 0, table_id))
            audit(conn, "staff", actor.actor, "table_saved", "table", table_id, payload={"label": label})
        self._tables_changed("tables")

    def save_layout(self, items: list[dict[str, Any]], actor: StaffCtx) -> None:
        with self.db.tx() as conn:
            for item in items:
                conn.execute("UPDATE dining_tables SET map_x=?, map_y=? WHERE id=? AND restaurant_id=?",
                             (clamp(item["x"], 4, 96), clamp(item["y"], 6, 94), item["id"], self.menu.restaurant_id))
            audit(conn, "staff", actor.actor, "layout_saved", "table", "", payload={"tables": len(items)})
        self._tables_changed("layout")

    def _check_capacity(self, conn: sqlite3.Connection, adding: int) -> int:
        count = conn.execute("SELECT count(*) AS n FROM dining_tables WHERE restaurant_id=? AND is_archived=0", (self.menu.restaurant_id,)).fetchone()["n"]
        if count + adding > settings.max_tables:
            raise ApiError(409, "tables_limit", f"Можно не больше {settings.max_tables} столов с QR — сейчас {count}")
        return count

    def bulk_create_tables(self, count: int, seats: int, zone: str, prefix: str, actor: StaffCtx) -> list[str]:
        prefix = clean_text(prefix, 20) or "Стол"
        created: list[str] = []
        rid = self.menu.restaurant_id
        with self.db.tx() as conn:
            self._check_capacity(conn, count)
            labels = {normalize_text(r["label"]) for r in conn.execute("SELECT label FROM dining_tables WHERE restaurant_id=?", (rid,))}
            sort = conn.execute("SELECT coalesce(max(sort),0) AS s FROM dining_tables WHERE restaurant_id=?", (rid,)).fetchone()["s"]
            spots = [(r["map_x"], r["map_y"]) for r in conn.execute("SELECT map_x, map_y FROM dining_tables WHERE restaurant_id=? AND is_archived=0", (rid,))]
            number = 1
            for _ in range(count):
                while normalize_text(f"{prefix} {number}") in labels:
                    number += 1
                label = f"{prefix} {number}"
                labels.add(normalize_text(label))
                sort += 1
                x, y = free_map_spot(spots)
                spots.append((x, y))
                conn.execute(
                    "INSERT INTO dining_tables(restaurant_id, label, zone, seats, qr_token, is_active, sort, created_at, map_x, map_y) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (rid, label, clean_text(zone, 40), seats, secrets.token_urlsafe(9), 1, sort, iso(now_utc()), x, y))
                created.append(label)
            audit(conn, "staff", actor.actor, "tables_bulk", "table", "", payload={"count": count, "first": created[0] if created else ""})
        self._tables_changed("bulk")
        return created

    def delete_table(self, table_id: int, actor: StaffCtx) -> str:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM dining_tables WHERE id=? AND restaurant_id=? AND is_archived=0", (table_id, self.menu.restaurant_id)).fetchone()
            if not row:
                raise ApiError(404, "table_not_found", "Стол не найден")
            if conn.execute("SELECT 1 FROM sessions WHERE table_id=? AND status IN ('open','locked')", (table_id,)).fetchone():
                raise ApiError(409, "table_busy", "За столом сейчас гости — закройте стол, потом удаляйте")
            if conn.execute("SELECT 1 FROM sessions WHERE table_id=?", (table_id,)).fetchone():
                conn.execute("UPDATE dining_tables SET is_archived=1, is_active=0, qr_token=? WHERE id=?", (secrets.token_urlsafe(12), table_id))
                mode = "archived"
            else:
                conn.execute("DELETE FROM dining_tables WHERE id=?", (table_id,))
                mode = "deleted"
            audit(conn, "staff", actor.actor, "table_deleted", "table", table_id, payload={"label": row["label"], "mode": mode})
        self._tables_changed("deleted")
        return mode

    def auto_layout(self, actor: StaffCtx) -> None:
        with self.db.tx() as conn:
            rows = conn.execute("SELECT id FROM dining_tables WHERE restaurant_id=? AND is_archived=0 ORDER BY sort, id", (self.menu.restaurant_id,)).fetchall()
            for row, (x, y) in zip(rows, grid_layout(len(rows))):
                conn.execute("UPDATE dining_tables SET map_x=?, map_y=? WHERE id=?", (x, y, row["id"]))
            audit(conn, "staff", actor.actor, "layout_saved", "table", "", payload={"tables": len(rows), "auto": True})
        self._tables_changed("layout")

    def _tables_changed(self, reason: str) -> None:
        self.bus.publish("public", "tables", {})
        self.bus.publish(f"staff:{self.menu.restaurant_id}", "floor", {"reason": reason})

    def rotate_qr(self, table_id: int, actor: StaffCtx) -> None:
        with self.db.tx() as conn:
            if not conn.execute("SELECT 1 FROM dining_tables WHERE id=? AND restaurant_id=?", (table_id, self.menu.restaurant_id)).fetchone():
                raise ApiError(404, "table_not_found", "Стол не найден")
            conn.execute("UPDATE dining_tables SET qr_token=? WHERE id=?", (secrets.token_urlsafe(9), table_id))
            audit(conn, "staff", actor.actor, "qr_rotated", "table", table_id)
        self.bus.publish("public", "tables", {})

    def restaurant(self) -> dict[str, Any]:
        row = self.menu.restaurant()
        return {"name": row["name"], "city": row["city"], "service_percent": row["service_percent"], "currency": row["currency"]}

    def update_restaurant(self, data: dict[str, Any], actor: StaffCtx) -> dict[str, Any]:
        with self.db.tx() as conn:
            conn.execute("UPDATE restaurants SET name=?, city=?, service_percent=?, updated_at=? WHERE id=?",
                         (clean_text(data["name"], 60), clean_text(data.get("city"), 40), float(data["service_percent"]), iso(now_utc()), self.menu.restaurant_id))
            audit(conn, "staff", actor.actor, "restaurant_updated", "restaurant", self.menu.restaurant_id, payload=data)
        self.bus.publish("public", "tables", {})
        return self.restaurant()

    def audit_log(self, limit: int, offset: int) -> dict[str, Any]:
        rows = self.db.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset))
        total = self.db.scalar("SELECT count(*) FROM audit_log", default=0)
        return {"total": total, "items": [{**r, "payload": jload(r.pop("payload_json"), {})} for r in rows]}
