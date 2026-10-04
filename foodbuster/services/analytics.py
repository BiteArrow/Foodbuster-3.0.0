from __future__ import annotations

import threading
import time
from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any

from foodbuster.core.money import percent_of
from foodbuster.core.utils import UTC, clamp, iso, jload, now_utc, parse_dt, to_local
from foodbuster.db.database import Database
from foodbuster.domain.recommend import recommend_items
from foodbuster.domain.reference import PAYMENT_METHODS
from foodbuster.services.menu import MenuService


class AnalyticsService:
    def __init__(self, db: Database, menu: MenuService) -> None:
        self.db = db
        self.menu = menu
        self._pairs: tuple[float, dict[int, Counter], Counter] = (0.0, {}, Counter())
        self._lock = threading.Lock()

    def pair_stats(self) -> tuple[dict[int, Counter], Counter]:
        with self._lock:
            stamp, pairs, counts = self._pairs
            if time.time() - stamp < 300 and counts:
                return pairs, counts
        rows = self.db.all("SELECT order_id, menu_item_id FROM order_items WHERE status<>'cancelled'")
        by_order: dict[str, set[int]] = defaultdict(set)
        for row in rows:
            by_order[row["order_id"]].add(row["menu_item_id"])
        pairs = defaultdict(Counter)
        counts = Counter()
        for ids in by_order.values():
            for a in ids:
                counts[a] += 1
                for b in ids:
                    if a != b:
                        pairs[a][b] += 1
        with self._lock:
            self._pairs = (time.time(), dict(pairs), counts)
        return dict(pairs), counts

    def recommendations(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        pairs, counts = self.pair_stats()
        me = state.get("me") or {}
        cart_ids = [c["menu_item_id"] for c in state["cart"]["items"] if c["participant_id"] == me.get("id")]
        if not cart_ids:
            cart_ids = [c["menu_item_id"] for c in state["cart"]["items"]]
        menu = self.menu.items()
        picks = recommend_items(menu, cart_ids, pairs, counts, me.get("allergens", []), me.get("diets", []), to_local(now_utc()).hour)
        index = {m["id"]: m for m in menu}
        return [{"id": p["id"], "reason": p["reason"], "name": index[p["id"]]["name"], "emoji": index[p["id"]]["emoji"],
                 "price": index[p["id"]]["price"], "kcal": index[p["id"]]["kcal"]} for p in picks]

    def report(self, days: int) -> dict[str, Any]:
        days = int(clamp(days, 1, 90))
        now = now_utc()
        start_local = to_local(now).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
        start = iso(start_local.astimezone(UTC))
        rid = self.menu.restaurant_id
        orders = self.db.all("SELECT * FROM orders WHERE restaurant_id=? AND created_at>=? AND status<>'cancelled'", (rid, start))
        order_ids = {o["id"] for o in orders}
        items = [i for i in self.db.all(
            "SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.restaurant_id=? AND o.created_at>=? AND i.status<>'cancelled'",
            (rid, start)) if i["order_id"] in order_ids]
        cancelled_items = self.db.scalar(
            "SELECT count(*) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.restaurant_id=? AND o.created_at>=? AND i.status='cancelled'",
            (rid, start), 0)
        payments = self.db.all(
            "SELECT p.* FROM payments p JOIN sessions s ON s.id=p.session_id WHERE s.restaurant_id=? AND p.created_at>=? AND p.status='paid' AND p.kind='payment'",
            (rid, start))
        sessions = self.db.all(
            "SELECT s.id, s.kind, (SELECT count(*) FROM participants p WHERE p.session_id=s.id) AS guests FROM sessions s WHERE s.restaurant_id=? AND s.created_at>=?",
            (rid, start))
        session_with_orders = {o["session_id"] for o in orders}
        sessions = [s for s in sessions if s["id"] in session_with_orders]
        revenue_items = sum(i["line_total"] for i in items)
        service = 0
        by_order_total: dict[str, int] = defaultdict(int)
        for i in items:
            by_order_total[i["order_id"]] += i["line_total"]
        for o in orders:
            service += percent_of(by_order_total[o["id"]], o["service_percent"])
        guests = sum(s["guests"] for s in sessions)
        ticket_minutes = [(parse_dt(o["ready_at"]) - parse_dt(o["created_at"])).total_seconds() / 60 for o in orders if o["ready_at"]]
        on_time = [o for o in orders if o["ready_at"] and o["eta_at"]]
        on_time_ok = sum(1 for o in on_time if parse_dt(o["ready_at"]) <= parse_dt(o["eta_at"]) + timedelta(minutes=1))
        dish_qty: Counter = Counter()
        dish_rev: Counter = Counter()
        dish_meta: dict[int, tuple[str, str]] = {}
        cat_rev: Counter = Counter()
        for i in items:
            dish_qty[i["menu_item_id"]] += i["qty"]
            dish_rev[i["menu_item_id"]] += i["line_total"]
            dish_meta[i["menu_item_id"]] = (i["name"], i["emoji"])
            cat_rev[i["category_code"]] += i["line_total"]
        categories = {c["code"]: c for c in self.menu.categories(include_inactive=True)}
        hours: dict[int, dict[str, int]] = {h: {"orders": 0, "revenue": 0} for h in range(8, 24)}
        daily: dict[str, int] = {}
        for d in range(days):
            daily[(start_local + timedelta(days=d)).strftime("%Y-%m-%d")] = 0
        for o in orders:
            local = to_local(parse_dt(o["created_at"]))
            bucket = hours.setdefault(local.hour, {"orders": 0, "revenue": 0})
            bucket["orders"] += 1
            bucket["revenue"] += by_order_total[o["id"]]
            key = local.strftime("%Y-%m-%d")
            if key in daily:
                daily[key] += by_order_total[o["id"]]
        methods: dict[str, dict[str, int]] = defaultdict(lambda: {"count": 0, "amount": 0})
        for p in payments:
            methods[p["method"]]["count"] += 1
            methods[p["method"]]["amount"] += p["amount"]
        tips = sum(p["tip"] for p in payments)
        tip_base = sum(p["amount"] for p in payments if p["method"] != "cash")
        payers_by_session = Counter(p["session_id"] for p in payments)
        multi_payer = sum(1 for s in sessions if payers_by_session.get(s["id"], 0) > 1)
        group_sessions = [s for s in sessions if s["guests"] > 1]
        reorders = len({o["session_id"] for o in orders if o["batch"] > 1})
        allergy_items = sum(1 for i in items if jload(i["conflicts_json"], []))
        allergy_guests = self.db.scalar(
            "SELECT count(*) FROM participants p JOIN sessions s ON s.id=p.session_id WHERE s.restaurant_id=? AND s.created_at>=? AND p.allergens_json<>'[]'",
            (rid, start), 0)
        kcal_per_guest = (sum(i["kcal"] * i["qty"] for i in items) / guests) if guests else 0
        return {
            "period_days": days, "since": start, "demo_data": bool(self.db.scalar("SELECT count(*) FROM sessions WHERE is_demo=1", default=0)),
            "kpi": {
                "revenue": revenue_items + service, "items_revenue": revenue_items, "service": service, "tips": tips,
                "orders": len(orders), "sessions": len(sessions), "guests": guests,
                "avg_check_guest": (revenue_items + service) // guests if guests else 0,
                "avg_check_table": (revenue_items + service) // len(sessions) if sessions else 0,
                "avg_ticket_minutes": round(sum(ticket_minutes) / len(ticket_minutes), 1) if ticket_minutes else None,
                "on_time_rate": round(on_time_ok / len(on_time), 3) if on_time else None,
                "tip_rate": round(tips / tip_base, 4) if tip_base else 0,
                "group_share": round(len(group_sessions) / len(sessions), 3) if sessions else 0,
                "avg_party": round(guests / len(sessions), 2) if sessions else 0,
                "split_sessions": multi_payer,
                "split_minutes_saved": multi_payer * 9,
                "reorder_share": round(reorders / len(sessions), 3) if sessions else 0,
                "allergy_flagged_items": allergy_items, "allergy_guests": allergy_guests,
                "cancelled_items": cancelled_items, "avg_kcal_guest": round(kcal_per_guest),
            },
            "top_dishes": [{"id": mid, "name": dish_meta[mid][0], "emoji": dish_meta[mid][1], "qty": qty, "revenue": dish_rev[mid]}
                           for mid, qty in dish_qty.most_common(10)],
            "categories": [{"code": code, "name": categories.get(code, {}).get("name", code), "emoji": categories.get(code, {}).get("emoji", ""),
                            "revenue": value} for code, value in cat_rev.most_common()],
            "hours": [{"hour": h, **v} for h, v in sorted(hours.items())],
            "daily": [{"date": k, "revenue": v} for k, v in daily.items()],
            "payment_methods": [{"method": k, "title": PAYMENT_METHODS.get(k, {}).get("title", k), **v} for k, v in methods.items()],
        }
