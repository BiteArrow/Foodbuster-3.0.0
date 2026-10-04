"""Orders and the kitchen workflow: submit, accept with ETA, cook, ready, served, cancel — with a strict state machine."""

from __future__ import annotations

import sqlite3
from collections import Counter
from datetime import timedelta
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import clamp, clean_text, iso, jdump, jload, local_midnight_utc, new_id, now_utc, parse_dt
from foodbuster.db.database import Database, audit
from foodbuster.domain.allergens import allergen_conflicts
from foodbuster.domain.recommend import compute_eta_minutes
from foodbuster.domain.reference import ALLERGEN_BY_CODE, ITEM_TRANSITIONS, ORDER_STATUS, ORDER_TRANSITIONS, can_transition
from foodbuster.services.context import GuestCtx, StaffCtx
from foodbuster.services.integrations import IntegrationHub
from foodbuster.services.menu import MenuService
from foodbuster.services.realtime import EventBus
from foodbuster.services.sessions import SessionService


class OrderService:
    def __init__(self, db: Database, bus: EventBus, menu: MenuService, sessions: SessionService, hub: IntegrationHub) -> None:
        self.db = db
        self.bus = bus
        self.menu = menu
        self.sessions = sessions
        self.hub = hub

    @property
    def staff(self) -> str:
        return f"staff:{self.menu.restaurant_id}"

    def _next_number(self, conn: sqlite3.Connection) -> int:
        local_midnight = local_midnight_utc()
        count = conn.execute("SELECT count(*) AS n FROM orders WHERE restaurant_id=? AND created_at>=?",
                             (self.menu.restaurant_id, iso(local_midnight))).fetchone()["n"]
        return count + 1

    def orders_ahead(self, conn: sqlite3.Connection) -> int:
        return conn.execute("SELECT count(*) AS n FROM orders WHERE restaurant_id=? AND status IN ('submitted','accepted','cooking')",
                            (self.menu.restaurant_id,)).fetchone()["n"]

    def _conflicts(self, line: dict[str, Any], people: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        contains, traces = jload(line["allergens_json"], []), jload(line["traces_json"], [])
        result = []
        for holder in [line["participant_id"], *jload(line["shared_with_json"], [])]:
            person = people.get(holder)
            if not person:
                continue
            conflict = allergen_conflicts(contains, traces, jload(person["allergens_json"], []))
            if conflict["level"] in ("danger", "caution"):
                result.append({"participant_id": holder, "name": person["name"], "danger": conflict["danger"], "caution": conflict["caution"]})
        return result

    def _create(self, conn: sqlite3.Connection, session: dict[str, Any], lines: list[dict[str, Any]], by_id: Optional[str],
                by_name: str, scope: str, kitchen_note: str) -> dict[str, Any]:
        people = {p["id"]: p for p in conn.execute("SELECT * FROM participants WHERE session_id=?", (session["id"],)).fetchall()}
        stamp = iso(now_utc())
        order_id = new_id("ord")
        batch = conn.execute("SELECT coalesce(max(batch),0)+1 AS b FROM orders WHERE session_id=?", (session["id"],)).fetchone()["b"]
        number = self._next_number(conn)
        subtotal = sum(line["unit_price"] * line["qty"] for line in lines)
        predicted = compute_eta_minutes([line["cook_minutes"] for line in lines], self.orders_ahead(conn))
        conn.execute(
            """INSERT INTO orders(id, session_id, restaurant_id, number, batch, scope, status, submitted_by, submitted_by_name, subtotal,
               service_percent, kitchen_note, eta_predicted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (order_id, session["id"], self.menu.restaurant_id, number, batch, scope, "submitted", by_id, by_name, subtotal,
             session["service_percent"], kitchen_note, predicted, stamp),
        )
        for line in lines:
            options = [{"group": o["group"], "choice": o["name"]} for o in jload(line["options_json"], [])]
            shared = [p for p in jload(line["shared_with_json"], []) if p in people]
            conn.execute(
                """INSERT INTO order_items(id, order_id, session_id, participant_id, participant_name, menu_item_id, name, emoji, category_code,
                   unit_price, qty, line_total, kcal, protein, fat, carbs, allergens_json, traces_json, options_json, note, shared_with_json,
                   conflicts_json, cook_minutes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (new_id("oi"), order_id, session["id"], line["participant_id"], people[line["participant_id"]]["name"], line["menu_item_id"],
                 line["name"], line["emoji"], line["category_code"], line["unit_price"], line["qty"], line["unit_price"] * line["qty"],
                 line["kcal"], line["protein"], line["fat"], line["carbs"], line["allergens_json"], line["traces_json"], jdump(options),
                 line["note"], jdump(shared), jdump(self._conflicts(line, people)), line["cook_minutes"], "queued", stamp, stamp),
            )
        conn.executemany("DELETE FROM cart_items WHERE id=?", [(line["id"],) for line in lines])
        owners = {line["participant_id"] for line in lines}
        conn.executemany("UPDATE participants SET ready=0 WHERE id=?", [(pid,) for pid in owners])
        conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (stamp, session["id"]))
        return {"id": order_id, "number": number, "batch": batch, "subtotal": subtotal, "eta_predicted": predicted}

    def submit(self, ctx: GuestCtx, scope: str, confirm_allergens: bool, kitchen_note: str, idem_key: Optional[str]) -> dict[str, Any]:
        self.sessions.require_open(ctx.session)
        note = clean_text(kitchen_note, settings.max_note_length)
        with self.db.tx() as conn:
            if idem_key:
                stored = conn.execute("SELECT response_json FROM idempotency_keys WHERE key=? AND scope=?", (idem_key, f"order:{ctx.pid}")).fetchone()
                if stored:
                    return jload(stored["response_json"], {})
            sql = "SELECT * FROM cart_items WHERE session_id=?" + (" AND participant_id=?" if scope == "mine" else "") + " ORDER BY created_at, rowid"
            lines = conn.execute(sql, (ctx.sid, ctx.pid) if scope == "mine" else (ctx.sid,)).fetchall()
            if not lines:
                raise ApiError(409, "cart_empty", "Корзина пуста — добавьте блюда из меню")
            index = self.menu.index()
            missing = [line["name"] for line in lines if not index.get(line["menu_item_id"], {}).get("available")]
            if missing:
                raise ApiError(409, "items_unavailable", "Некоторые блюда закончились: " + ", ".join(missing) + ". Уберите их из корзины", {"items": missing})
            people = {p["id"]: p for p in conn.execute("SELECT * FROM participants WHERE session_id=?", (ctx.sid,)).fetchall()}
            dangers = []
            for line in lines:
                for conflict in self._conflicts(line, people):
                    if conflict["danger"]:
                        dangers.append({"item": line["name"], "participant": conflict["name"],
                                        "allergens": [ALLERGEN_BY_CODE[c].short for c in conflict["danger"]]})
            if dangers and not confirm_allergens:
                raise ApiError(409, "allergen_confirmation_required", "В заказе есть блюда с аллергенами из профиля гостей", {"conflicts": dangers})
            order = self._create(conn, ctx.session, lines, ctx.pid, ctx.participant["name"], scope, note)
            response = {"order_id": order["id"], "number": order["number"], "batch": order["batch"]}
            if idem_key:
                conn.execute("INSERT INTO idempotency_keys(key, scope, response_json, created_at) VALUES (?,?,?,?)",
                             (idem_key, f"order:{ctx.pid}", jdump(response), iso(now_utc())))
            audit(conn, "guest", ctx.participant["name"], "order_submitted", "order", order["id"], ctx.sid,
                  {"number": order["number"], "lines": len(lines), "subtotal": order["subtotal"], "scope": scope, "allergy_confirmed": bool(dangers)})
        self._announce_new(ctx.session, order, len(lines), bool(dangers), ctx.participant["name"])
        return response

    def _announce_new(self, session: dict[str, Any], order: dict[str, Any], lines: int, allergy: bool, who: str) -> None:
        label = session["title"] or "Группа"
        self.sessions.notify(session["id"], "order", f"{who} отправил(а) заказ №{order['number']:03d} на кухню", staff=False)
        self.bus.publish(self.staff, "kitchen", {"reason": "new", "order_id": order["id"],
                                                 "text": f"Новый заказ №{order['number']:03d} · {label}" + (" · ⚠ аллергия" if allergy else "")})
        self.bus.publish(self.staff, "floor", {"session_id": session["id"], "reason": "order"})
        self.hub.emit("order.created", {"order_id": order["id"], "number": order["number"], "session": session["code"], "lines": lines})

    def auto_submit_office(self, session_id: str) -> Optional[dict[str, Any]]:
        with self.db.tx() as conn:
            session = conn.execute("SELECT * FROM sessions WHERE id=? AND status='open'", (session_id,)).fetchone()
            if not session:
                return None
            lines = conn.execute("SELECT * FROM cart_items WHERE session_id=? ORDER BY created_at, rowid", (session_id,)).fetchall()
            order = None
            if lines:
                order = self._create(conn, session, lines, None, "Автоотправка по дедлайну", "table", "Офисный заказ: дедлайн группы")
            stamp = iso(now_utc())
            conn.execute("UPDATE sessions SET status='locked', auto_submitted_at=?, updated_at=? WHERE id=?", (stamp, stamp, session_id))
            audit(conn, "system", "scheduler", "office_cutoff", "session", session_id, session_id, {"order": order["id"] if order else None})
        if order:
            self._announce_new(session, order, len(lines), False, "Дедлайн:")
        self.sessions.notify(session_id, "locked", "Дедлайн наступил — приём заказов закрыт" + (", заказ отправлен на кухню" if order else ""))
        return order

    def _order(self, conn: sqlite3.Connection, order_id: str) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM orders WHERE id=? AND restaurant_id=?", (order_id, self.menu.restaurant_id)).fetchone()
        if not row:
            raise ApiError(404, "order_not_found", "Заказ не найден")
        return row

    def _after_change(self, order: dict[str, Any], text: str, reason: str = "order") -> None:
        self.sessions.notify(order["session_id"], reason, text, staff=False)
        self.bus.publish(self.staff, "kitchen", {"reason": reason, "order_id": order["id"]})
        self.bus.publish(self.staff, "floor", {"session_id": order["session_id"], "reason": reason})
        self.hub.emit(f"order.{reason}", {"order_id": order["id"], "number": order["number"]})

    def set_status(self, order_id: str, target: str, actor: StaffCtx, eta_minutes: Optional[int] = None, reason: str = "") -> dict[str, Any]:
        if target not in ORDER_STATUS:
            raise ApiError(422, "status_invalid", "Неизвестный статус")
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            order = self._order(conn, order_id)
            current = order["status"]
            if current == target:
                return order
            if not can_transition(ORDER_TRANSITIONS, current, target):
                raise ApiError(409, "transition_invalid", f"Нельзя перевести заказ из «{ORDER_STATUS[current]['short']}» в «{ORDER_STATUS[target]['short']}»")
            updates: dict[str, Any] = {"status": target}
            if target == "accepted":
                items = conn.execute("SELECT cook_minutes FROM order_items WHERE order_id=? AND status<>'cancelled'", (order_id,)).fetchall()
                auto = compute_eta_minutes([i["cook_minutes"] for i in items], self.orders_ahead(conn) - 1)
                minutes = int(clamp(eta_minutes or auto, settings.eta_min_minutes, settings.eta_max_minutes))
                updates |= {"accepted_at": stamp, "eta_minutes": minutes, "eta_at": iso(now_utc() + timedelta(minutes=minutes))}
            elif target == "cooking":
                updates["cooking_at"] = stamp
                conn.execute("UPDATE order_items SET status='cooking', updated_at=? WHERE order_id=? AND status='queued'", (stamp, order_id))
            elif target == "ready":
                updates["ready_at"] = stamp
                if not order["accepted_at"]:
                    updates["accepted_at"] = stamp
                conn.execute("UPDATE order_items SET status='ready', updated_at=? WHERE order_id=? AND status IN ('queued','cooking')", (stamp, order_id))
            elif target == "served":
                updates["served_at"] = stamp
                conn.execute("UPDATE order_items SET status='served', updated_at=? WHERE order_id=? AND status<>'cancelled'", (stamp, order_id))
            elif target == "cancelled":
                updates |= {"cancelled_at": stamp, "cancel_reason": clean_text(reason, 120) or "Отменён рестораном"}
                conn.execute("UPDATE order_items SET status='cancelled', cancel_reason=?, updated_at=? WHERE order_id=? AND status<>'cancelled'",
                             (updates["cancel_reason"], stamp, order_id))
            conn.execute(f"UPDATE orders SET {', '.join(f'{k}=?' for k in updates)} WHERE id=?", (*updates.values(), order_id))
            audit(conn, "staff", actor.actor, "order_status", "order", order_id, order["session_id"], {"from": current, "to": target, **({"eta": updates.get("eta_minutes")} if target == "accepted" else {})})
            fresh = self._order(conn, order_id)
        texts = {
            "accepted": f"Кухня приняла заказ №{order['number']:03d} — будет готов примерно через {fresh['eta_minutes']} мин",
            "cooking": f"Заказ №{order['number']:03d} готовится",
            "ready": f"Заказ №{order['number']:03d} готов — несём к вам",
            "served": f"Заказ №{order['number']:03d} подан. Приятного аппетита!",
            "cancelled": f"Заказ №{order['number']:03d} отменён: {fresh['cancel_reason']}",
        }
        self._after_change(fresh, texts.get(target, ""), "status")
        return fresh

    def adjust_eta(self, order_id: str, delta: int, actor: StaffCtx) -> dict[str, Any]:
        with self.db.tx() as conn:
            order = self._order(conn, order_id)
            if order["status"] not in ("accepted", "cooking") or not order["eta_at"]:
                raise ApiError(409, "eta_locked", "Время можно менять только у принятого заказа")
            new_eta = parse_dt(order["eta_at"]) + timedelta(minutes=int(delta))
            floor_eta = now_utc() + timedelta(minutes=1)
            new_eta = max(new_eta, floor_eta)
            minutes = max(1, int((new_eta - parse_dt(order["accepted_at"])).total_seconds() // 60))
            conn.execute("UPDATE orders SET eta_at=?, eta_minutes=? WHERE id=?", (iso(new_eta), minutes, order_id))
            audit(conn, "staff", actor.actor, "eta_adjusted", "order", order_id, order["session_id"], {"delta": delta})
            fresh = self._order(conn, order_id)
        sign = "+" if delta > 0 else "−"
        self._after_change(fresh, f"Время по заказу №{order['number']:03d} изменено: {sign}{abs(delta)} мин", "eta")
        return fresh

    def set_item_status(self, item_id: str, target: str, actor: StaffCtx, reason: str = "") -> dict[str, Any]:
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            item = conn.execute("SELECT * FROM order_items WHERE id=?", (item_id,)).fetchone()
            if not item:
                raise ApiError(404, "item_not_found", "Позиция не найдена")
            order = self._order(conn, item["order_id"])
            if order["status"] in ("served", "cancelled"):
                raise ApiError(409, "order_closed", "Заказ уже закрыт")
            if item["status"] != target and not can_transition(ITEM_TRANSITIONS, item["status"], target):
                raise ApiError(409, "transition_invalid", "Недопустимый переход статуса позиции")
            cancel_reason = clean_text(reason, 120) or "Закончилось на кухне" if target == "cancelled" else ""
            conn.execute("UPDATE order_items SET status=?, cancel_reason=?, updated_at=? WHERE id=?", (target, cancel_reason, stamp, item_id))
            rows = conn.execute("SELECT status FROM order_items WHERE order_id=?", (order["id"],)).fetchall()
            statuses = [r["status"] for r in rows]
            live = [s for s in statuses if s != "cancelled"]
            order_update: dict[str, Any] = {}
            if not live:
                order_update = {"status": "cancelled", "cancelled_at": stamp, "cancel_reason": "Все позиции отменены"}
            elif all(s in ("ready", "served") for s in live) and order["status"] in ("submitted", "accepted", "cooking"):
                order_update = {"status": "ready", "ready_at": stamp, "accepted_at": order["accepted_at"] or stamp}
            elif target == "cooking" and order["status"] in ("accepted", "submitted"):
                order_update = {"status": "cooking", "cooking_at": stamp, "accepted_at": order["accepted_at"] or stamp}
            if order_update:
                conn.execute(f"UPDATE orders SET {', '.join(f'{k}=?' for k in order_update)} WHERE id=?", (*order_update.values(), order["id"]))
            conn.execute("UPDATE orders SET subtotal=(SELECT coalesce(sum(line_total),0) FROM order_items WHERE order_id=? AND status<>'cancelled') WHERE id=?",
                         (order["id"], order["id"]))
            audit(conn, "staff", actor.actor, "item_status", "order_item", item_id, order["session_id"], {"to": target, "reason": cancel_reason})
            fresh = self._order(conn, order["id"])
        if target == "cancelled":
            text = f"Кухня убрала «{item['name']}» ({item['participant_name']}): {cancel_reason}. Сумма в счёте пересчитана"
        elif fresh["status"] == "ready" and order["status"] != "ready":
            text = f"Заказ №{order['number']:03d} готов — несём к вам"
        else:
            text = f"«{item['name']}» — {'готово' if target == 'ready' else 'готовится'}"
        self._after_change(fresh, text, "item")
        return fresh

    def tickets(self) -> dict[str, Any]:
        rows = self.db.all(
            """SELECT o.*, s.code, s.kind, s.title, s.deadline_at, s.table_id, t.label AS table_label, t.zone AS table_zone
               FROM orders o JOIN sessions s ON s.id=o.session_id LEFT JOIN dining_tables t ON t.id=s.table_id
               WHERE o.restaurant_id=? AND o.status IN ('submitted','accepted','cooking','ready') ORDER BY o.created_at""",
            (self.menu.restaurant_id,),
        )
        order_ids = [r["id"] for r in rows]
        items = self.db.all(
            f"SELECT * FROM order_items WHERE order_id IN ({','.join('?' * len(order_ids))}) ORDER BY participant_name, created_at, rowid",
            tuple(order_ids)) if order_ids else []
        session_ids = list({r["session_id"] for r in rows})
        people = self.db.all(
            f"SELECT id, session_id, name, allergens_json FROM participants WHERE session_id IN ({','.join('?' * len(session_ids))})",
            tuple(session_ids)) if session_ids else []
        index = self.menu.index()
        now = now_utc()
        tickets = []
        for order in rows:
            o_items = [i for i in items if i["order_id"] == order["id"]]
            name_by_id = {p["id"]: p["name"] for p in people if p["session_id"] == order["session_id"]}
            allergies = [{"name": p["name"], "allergens": jload(p["allergens_json"], [])} for p in people
                         if p["session_id"] == order["session_id"] and jload(p["allergens_json"], [])]
            eta_at = parse_dt(order["eta_at"])
            deadline = parse_dt(order["deadline_at"])
            tickets.append({
                "id": order["id"], "number": order["number"], "batch": order["batch"], "status": order["status"],
                "label": ORDER_STATUS[order["status"]]["short"], "session_code": order["code"], "kind": order["kind"],
                "table": order["table_label"] or order["title"] or "Офис", "zone": order["table_zone"] or ("Самовывоз / доставка" if order["kind"] == "office" else ""),
                "created_at": order["created_at"], "accepted_at": order["accepted_at"], "ready_at": order["ready_at"],
                "eta_at": order["eta_at"], "eta_minutes": order["eta_minutes"], "eta_predicted": order["eta_predicted"],
                "overdue": bool(eta_at and now > eta_at and order["status"] in ("accepted", "cooking")),
                "deadline_at": order["deadline_at"], "rush": bool(deadline and deadline - now < timedelta(minutes=30)),
                "kitchen_note": order["kitchen_note"], "submitted_by_name": order["submitted_by_name"], "allergies": allergies,
                "has_conflict": any(jload(i["conflicts_json"], []) for i in o_items),
                "items": [{
                    "id": i["id"], "name": i["name"], "emoji": i["emoji"], "qty": i["qty"], "status": i["status"], "note": i["note"],
                    "options": jload(i["options_json"], []), "participant_name": i["participant_name"], "cancel_reason": i["cancel_reason"],
                    "shared_names": [name_by_id.get(p, "гость") for p in jload(i["shared_with_json"], [])],
                    "conflicts": jload(i["conflicts_json"], []), "allergens": jload(i["allergens_json"], []),
                    "cook_minutes": i["cook_minutes"], "category_code": i["category_code"],
                    "kcal": i["kcal"], "image_url": (index.get(i["menu_item_id"]) or {}).get("image_url"),
                } for i in o_items],
            })
        tickets.sort(key=lambda t: ({"submitted": 0, "accepted": 1, "cooking": 1, "ready": 2}[t["status"]], not t["rush"], t["created_at"]))
        counts = Counter(t["status"] for t in tickets)
        served_today = self.db.scalar(
            "SELECT count(*) FROM orders WHERE restaurant_id=? AND status='served' AND served_at>=?",
            (self.menu.restaurant_id, iso(local_midnight_utc())), 0)
        return {"server_time": iso(now), "tickets": tickets, "counts": dict(counts), "served_today": served_today}
