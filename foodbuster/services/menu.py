from __future__ import annotations

import threading
import time
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.money import fmt_money
from foodbuster.core.utils import jload
from foodbuster.db.database import Database
from foodbuster.domain.search import MenuIndex, match_menu, parse_search
from foodbuster.services.realtime import EventBus


class MenuService:
    def __init__(self, db: Database, bus: EventBus) -> None:
        self.db = db
        self.bus = bus
        self._cache: Optional[list[dict[str, Any]]] = None
        self._lock = threading.Lock()
        self.revision = int(time.time() * 1000)
        self._restaurant_id: Optional[int] = None
        self.index_fts = MenuIndex()

    @property
    def restaurant_id(self) -> int:
        if self._restaurant_id is None:
            row = self.db.one("SELECT id FROM restaurants WHERE slug=?", (settings.restaurant_slug,))
            if not row:
                raise ApiError(503, "not_ready", "Ресторан ещё не инициализирован")
            self._restaurant_id = row["id"]
        return self._restaurant_id

    def restaurant(self) -> dict[str, Any]:
        return self.db.one("SELECT * FROM restaurants WHERE id=?", (self.restaurant_id,))

    def drop_cache(self) -> None:
        with self._lock:
            self._cache = None

    def invalidate(self, reason: str = "menu") -> None:
        with self._lock:
            self._cache = None
            self.revision = max(self.revision + 1, int(time.time() * 1000))
        self.bus.publish("menu", "menu", {"revision": self.revision, "reason": reason})
        self.bus.publish(f"staff:{self.restaurant_id}", "menu", {"revision": self.revision})

    def categories(self, include_inactive: bool = False) -> list[dict[str, Any]]:
        rows = self.db.all(
            """SELECT c.*, (SELECT count(*) FROM menu_items m WHERE m.category_id=c.id AND m.is_archived=0) AS items_count
               FROM categories c WHERE c.restaurant_id=? ORDER BY c.sort, c.id""",
            (self.restaurant_id,),
        )
        return [
            {"id": r["id"], "code": r["code"], "name": r["name"], "emoji": r["emoji"], "sort": r["sort"],
             "active": bool(r["is_active"]), "items_count": r["items_count"]}
            for r in rows if include_inactive or r["is_active"]
        ]

    def serialize(self, row: dict[str, Any], categories: dict[int, dict[str, Any]]) -> dict[str, Any]:
        category = categories.get(row["category_id"], {"code": "other", "name": "Другое", "active": True})
        return {
            "id": row["id"], "category_id": row["category_id"], "category_code": category["code"], "category_name": category["name"],
            "name": row["name"], "description": row["description"], "ingredients": jload(row["ingredients_json"], []),
            "price": row["price"], "price_text": fmt_money(row["price"]), "weight_g": row["weight_g"], "kcal": row["kcal"],
            "protein": row["protein"], "fat": row["fat"], "carbs": row["carbs"],
            "allergens": jload(row["allergens_json"], []), "traces": jload(row["traces_json"], []), "diets": jload(row["diets_json"], []),
            "options": jload(row["options_json"], []), "cook_minutes": row["cook_minutes"], "emoji": row["emoji"],
            "image_url": f"/media/{row['image_path']}?v={row['version']}" if row["image_path"] else None,
            "popular": bool(row["is_popular"]), "new": bool(row["is_new"]),
            "available": bool(row["is_available"]) and not row["is_archived"] and category.get("active", True),
            "in_stock": bool(row["is_available"]), "archived": bool(row["is_archived"]), "sort": row["sort"], "version": row["version"],
            "updated_at": row["updated_at"],
        }

    def items(self, include_archived: bool = False) -> list[dict[str, Any]]:
        if not include_archived and self._cache is not None:
            return self._cache
        categories = {c["id"]: c for c in self.categories(include_inactive=True)}
        sql = "SELECT * FROM menu_items WHERE restaurant_id=?" + ("" if include_archived else " AND is_archived=0")
        order = {cid: c["sort"] for cid, c in categories.items()}
        rows = sorted(self.db.all(sql, (self.restaurant_id,)), key=lambda r: (order.get(r["category_id"], 999), r["sort"], r["id"]))
        result = [self.serialize(r, categories) for r in rows]
        if not include_archived:
            with self._lock:
                self._cache = result
        return result

    def index(self) -> dict[int, dict[str, Any]]:
        return {item["id"]: item for item in self.items()}

    def get(self, item_id: int, include_archived: bool = False) -> dict[str, Any]:
        for item in self.items(include_archived=include_archived):
            if item["id"] == item_id:
                return item
        raise ApiError(404, "dish_not_found", "Блюдо не найдено в меню")

    def public_menu(self) -> dict[str, Any]:
        return {"revision": self.revision, "categories": self.categories(), "items": self.items()}

    def search(self, raw: str) -> dict[str, Any]:
        query = parse_search(raw)
        items = [i for i in self.items() if i["available"] or not query.is_empty()]
        if query.is_empty():
            return {"query": raw, "chips": [], "results": [], "total": 0, "empty": True}
        self.index_fts.ensure(self.items(), self.revision)
        results = match_menu(items, query, self.index_fts)
        return {"query": raw, "chips": query.chips, "results": results, "total": len(results), "empty": False}
