"""Table and office sessions: joining by QR, company mode, presence, deadlines, waiter calls and the live state."""

from __future__ import annotations

import hmac
import re
import secrets
import sqlite3
import time
from collections import defaultdict
from datetime import timedelta
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.security import new_token, token_hash
from foodbuster.core.utils import clamp, clean_text, iso, jdump, jload, new_id, normalize_text, now_utc, parse_dt, random_code, to_local
from foodbuster.db.database import Database, audit
from foodbuster.domain.allergens import allergen_conflicts
from foodbuster.domain.billing import compute_bill
from foodbuster.domain.reference import (AVATARS, ORDER_STATUS, PARTICIPANT_COLORS, PAYMENT_METHODS, WAITER_CALL_REASONS,
                                         validate_allergen_codes, validate_diet_codes)
from foodbuster.services.context import GuestCtx
from foodbuster.services.menu import MenuService
from foodbuster.services.realtime import EventBus, PresenceHub


def validate_person_name(value: str) -> str:
    name = clean_text(value, settings.max_name_length)
    if not name:
        raise ApiError(422, "name_required", "Введите имя — так компания поймёт, чьё это блюдо")
    if re.search(r"[<>{}\\]", name):
        raise ApiError(422, "name_invalid", "В имени нельзя использовать символы < > { } \\")
    return name


class SessionService:
    def __init__(self, db: Database, bus: EventBus, presence: PresenceHub, menu: MenuService) -> None:
        self.db = db
        self.bus = bus
        self.presence = presence
        self.menu = menu
        self._recovery_failures: dict[str, list[float]] = defaultdict(list)
        self._seen_writes: dict[str, float] = {}

    def staff_channel(self) -> str:
        return f"staff:{self.menu.restaurant_id}"

    def notify(self, session_id: str, reason: str, text: str = "", actor: Optional[dict] = None, staff: bool = True, extra: Optional[dict] = None) -> None:
        data = {"reason": reason, "text": text, "actor_id": actor["id"] if actor else None, **(extra or {})}
        self.bus.publish(f"session:{session_id}", "state", data)
        if staff:
            self.bus.publish(self.staff_channel(), "floor", {"session_id": session_id, "reason": reason, "text": text})
        if reason in {"joined", "closed", "left", "created"}:
            self.bus.publish("public", "tables", {"session_id": session_id})

    def table_by_token(self, token: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM dining_tables WHERE qr_token=? AND restaurant_id=?", (token, self.menu.restaurant_id))
        if not row or row["is_archived"]:
            raise ApiError(404, "qr_unknown", "QR-код не найден или устарел. Попросите официанта новый")
        if not row["is_active"]:
            raise ApiError(409, "table_inactive", "Этот стол сейчас не обслуживается — подойдите к официанту")
        return row

    def open_session_for_table(self, table_id: int) -> Optional[dict[str, Any]]:
        return self.db.one("SELECT * FROM sessions WHERE table_id=? AND status IN ('open','locked')", (table_id,))

    def session_by_code(self, code: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM sessions WHERE code=? AND restaurant_id=?", ((code or "").upper(), self.menu.restaurant_id))
        if not row:
            raise ApiError(404, "session_not_found", "Группа не найдена. Проверьте ссылку")
        return row

    def active_participants(self, session_id: str) -> list[dict[str, Any]]:
        return self.db.all("SELECT * FROM participants WHERE session_id=? ORDER BY joined_at, rowid", (session_id,))

    def mode_of(self, session: dict[str, Any], count: int) -> str:
        return "company" if count >= 2 or session["intent"] == "group" or session["kind"] == "office" else "solo"

    def table_preview(self, token: str) -> dict[str, Any]:
        table = self.table_by_token(token)
        session = self.open_session_for_table(table["id"])
        people = self.active_participants(session["id"]) if session else []
        return {
            "restaurant": {"name": self.menu.restaurant()["name"]},
            "table": {"label": table["label"], "zone": table["zone"], "seats": table["seats"]},
            "session": None if not session else {
                "code": session["code"], "intent": session["intent"], "mode": self.mode_of(session, len(people)),
                "count": len(people), "status": session["status"],
                "participants": [{"name": p["name"], "avatar": p["avatar"], "color": p["color"], "host": p["role"] == "host"} for p in people],
            },
            "avatars": list(AVATARS),
        }

    def _create_session(self, conn: sqlite3.Connection, kind: str, table_id: Optional[int], intent: str, title: str,
                        cutoff_at: Optional[str] = None, pickup_note: str = "", is_demo: bool = False) -> dict[str, Any]:
        stamp = iso(now_utc())
        pct = float(settings.office_service_fee_percent) if kind == "office" else self.menu.restaurant()["service_percent"]
        for _ in range(12):
            session_id, code = new_id("ses"), random_code()
            try:
                conn.execute(
                    """INSERT INTO sessions(id, code, restaurant_id, table_id, kind, title, intent, status, service_percent, cutoff_at,
                       pickup_note, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (session_id, code, self.menu.restaurant_id, table_id, kind, title, intent, "open", pct, cutoff_at, pickup_note,
                     1 if is_demo else 0, stamp, stamp),
                )
                return conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            except sqlite3.IntegrityError as exc:
                if "code" not in str(exc):
                    raise
        raise ApiError(500, "code_exhausted", "Не удалось создать сессию, попробуйте ещё раз")

    def _add_participant(self, conn: sqlite3.Connection, session: dict[str, Any], name: str, avatar: Optional[str],
                         allergens: list[str], diets: list[str], share_allergies: bool = True) -> tuple[dict[str, Any], str]:
        count = conn.execute("SELECT count(*) AS n FROM participants WHERE session_id=?", (session["id"],)).fetchone()["n"]
        if count >= settings.max_participants:
            raise ApiError(409, "table_full", f"За столом уже {count} человек — это максимум для одной группы")
        name_key = normalize_text(name)
        if conn.execute("SELECT 1 FROM participants WHERE session_id=? AND name_key=?", (session["id"], name_key)).fetchone():
            raise ApiError(409, "name_taken", f"Имя «{name}» уже есть в этой группе. Добавьте первую букву фамилии")
        raw_token = new_token()
        stamp = iso(now_utc())
        pid = new_id("par")
        used_colors = {r["color"] for r in conn.execute("SELECT color FROM participants WHERE session_id=?", (session["id"],)).fetchall()}
        color = next((c for c in PARTICIPANT_COLORS if c not in used_colors), PARTICIPANT_COLORS[count % len(PARTICIPANT_COLORS)])
        conn.execute(
            """INSERT INTO participants(id, session_id, name, name_key, avatar, color, role, token_hash, recovery_pin, allergens_json,
               diets_json, share_allergies, joined_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, session["id"], name, name_key, avatar if avatar in AVATARS else AVATARS[count % len(AVATARS)], color,
             "host" if count == 0 else "guest", token_hash(raw_token), f"{secrets.randbelow(10000):04d}", jdump(allergens), jdump(diets),
             1 if share_allergies else 0, stamp, stamp),
        )
        conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (stamp, session["id"]))
        return conn.execute("SELECT * FROM participants WHERE id=?", (pid,)).fetchone(), raw_token

    def join_table(self, token: str, name: str, avatar: Optional[str], intent: str, allergens: list[str], diets: list[str],
                   share_allergies: bool = True, is_demo: bool = False) -> dict[str, Any]:
        name = validate_person_name(name)
        allergens = validate_allergen_codes(allergens)
        diets = validate_diet_codes(diets, allow_spicy=False)
        table = self.table_by_token(token)
        with self.db.tx() as conn:
            session = conn.execute("SELECT * FROM sessions WHERE table_id=? AND status IN ('open','locked')", (table["id"],)).fetchone()
            created = session is None
            if created:
                session = self._create_session(conn, "table", table["id"], "group" if intent == "group" else "solo", table["label"], is_demo=is_demo)
            elif intent == "group" and session["intent"] != "group":
                conn.execute("UPDATE sessions SET intent='group' WHERE id=?", (session["id"],))
            participant, raw = self._add_participant(conn, session, name, avatar, allergens, diets, share_allergies)
            audit(conn, "guest", participant["name"], "joined", "session", session["id"], session["id"], {"table": table["label"], "created": created})
            count = conn.execute("SELECT count(*) AS n FROM participants WHERE session_id=?", (session["id"],)).fetchone()["n"]
        text = f"{name} сел(а) за стол" + (" — включён режим компании" if count == 2 and session["intent"] != "group" else "")
        self.notify(session["id"], "joined", text, participant)
        return {"participant_token": raw, "participant_id": participant["id"], "code": session["code"], "created": created}

    def create_office(self, title: str, name: str, avatar: Optional[str], cutoff_minutes: int, pickup_note: str,
                      allergens: list[str], diets: list[str]) -> dict[str, Any]:
        name = validate_person_name(name)
        title = clean_text(title, 60) or "Офисный обед"
        cutoff = now_utc() + timedelta(minutes=int(clamp(cutoff_minutes, 5, 600)))
        with self.db.tx() as conn:
            session = self._create_session(conn, "office", None, "group", title, iso(cutoff), clean_text(pickup_note, 120))
            participant, raw = self._add_participant(conn, session, name, avatar, validate_allergen_codes(allergens), validate_diet_codes(diets, False))
            audit(conn, "guest", name, "office_created", "session", session["id"], session["id"], {"cutoff_at": iso(cutoff)})
        self.notify(session["id"], "created", f"{name} собирает «{title}»", participant)
        return {"participant_token": raw, "participant_id": participant["id"], "code": session["code"], "created": True}

    def office_preview(self, code: str) -> dict[str, Any]:
        session = self.session_by_code(code)
        if session["kind"] != "office":
            raise ApiError(404, "not_office", "Это не офисная группа. Отсканируйте QR на столе")
        people = self.active_participants(session["id"])
        return {
            "restaurant": {"name": self.menu.restaurant()["name"]},
            "session": {"code": session["code"], "title": session["title"], "status": session["status"], "cutoff_at": session["cutoff_at"],
                        "pickup_note": session["pickup_note"], "count": len(people), "mode": "company",
                        "participants": [{"name": p["name"], "avatar": p["avatar"], "color": p["color"], "host": p["role"] == "host"} for p in people]},
            "avatars": list(AVATARS),
        }

    def join_office(self, code: str, name: str, avatar: Optional[str], allergens: list[str], diets: list[str]) -> dict[str, Any]:
        name = validate_person_name(name)
        session = self.session_by_code(code)
        if session["kind"] != "office":
            raise ApiError(404, "not_office", "Это не офисная группа")
        if session["status"] != "open":
            raise ApiError(409, "office_closed", "Приём заказов в этой группе уже закрыт")
        with self.db.tx() as conn:
            participant, raw = self._add_participant(conn, session, name, avatar, validate_allergen_codes(allergens), validate_diet_codes(diets, False))
            audit(conn, "guest", name, "joined", "session", session["id"], session["id"])
        self.notify(session["id"], "joined", f"{name} присоединился(ась) к обеду", participant)
        return {"participant_token": raw, "participant_id": participant["id"], "code": session["code"], "created": False}

    def recover(self, code: str, name: str, pin: str) -> dict[str, Any]:
        session = self.session_by_code(code)
        if session["status"] == "closed":
            raise ApiError(409, "session_closed", "Эта группа уже закрыта")
        key = f"{session['id']}:{normalize_text(name)}"
        now = time.time()
        attempts = [t for t in self._recovery_failures[key] if now - t < 600]
        self._recovery_failures[key] = attempts
        if len(attempts) >= 5:
            raise ApiError(429, "recovery_locked", "Слишком много попыток. Попросите официанта помочь или подождите 10 минут")
        row = self.db.one("SELECT * FROM participants WHERE session_id=? AND name_key=?", (session["id"], normalize_text(name)))
        if not row or not hmac.compare_digest(row["recovery_pin"], (pin or "").strip()):
            attempts.append(now)
            raise ApiError(403, "recovery_failed", "Имя или код восстановления не совпадают")
        raw = new_token()
        with self.db.tx() as conn:
            conn.execute("UPDATE participants SET token_hash=?, last_seen_at=? WHERE id=?", (token_hash(raw), iso(now_utc()), row["id"]))
            audit(conn, "guest", row["name"], "recovered", "participant", row["id"], session["id"])
        self._recovery_failures.pop(key, None)
        return {"participant_token": raw, "participant_id": row["id"], "code": session["code"], "created": False}

    def context(self, code: str, raw_token: Optional[str]) -> GuestCtx:
        if not raw_token:
            raise ApiError(401, "no_token", "Сначала присоединитесь к столу")
        participant = self.db.one("SELECT * FROM participants WHERE token_hash=?", (token_hash(raw_token),))
        if not participant:
            raise ApiError(401, "bad_token", "Доступ устарел — отсканируйте QR-код ещё раз")
        session = self.db.one("SELECT * FROM sessions WHERE id=?", (participant["session_id"],))
        if session["code"] != (code or "").upper():
            raise ApiError(403, "wrong_session", "Это устройство подключено к другой группе")
        last = self._seen_writes.get(participant["id"], 0)
        if time.time() - last > 30:
            self._seen_writes[participant["id"]] = time.time()
            with self.db.tx() as conn:
                conn.execute("UPDATE participants SET last_seen_at=? WHERE id=?", (iso(now_utc()), participant["id"]))
        self.presence.touch(session["id"], participant["id"])
        return GuestCtx(participant, session)

    @staticmethod
    def require_open(session: dict[str, Any]) -> None:
        if session["status"] == "closed":
            raise ApiError(409, "session_closed", "Стол уже закрыт. Отсканируйте QR, чтобы начать новый заказ")
        if session["status"] == "locked":
            raise ApiError(409, "session_locked", "Приём заказов закрыт: дедлайн группы прошёл")

    def update_me(self, ctx: GuestCtx, changes: dict[str, Any]) -> None:
        sets, params, text = [], [], ""
        if "name" in changes and changes["name"] is not None:
            name = validate_person_name(changes["name"])
            clash = self.db.one("SELECT 1 FROM participants WHERE session_id=? AND name_key=? AND id<>?", (ctx.sid, normalize_text(name), ctx.pid))
            if clash:
                raise ApiError(409, "name_taken", f"Имя «{name}» уже занято в группе")
            sets += ["name=?", "name_key=?"]
            params += [name, normalize_text(name)]
        if changes.get("avatar") is not None:
            if changes["avatar"] not in AVATARS:
                raise ApiError(422, "avatar_invalid", "Выберите аватар из списка")
            sets.append("avatar=?")
            params.append(changes["avatar"])
        if changes.get("allergens") is not None:
            sets.append("allergens_json=?")
            params.append(jdump(validate_allergen_codes(changes["allergens"])))
        if changes.get("diets") is not None:
            sets.append("diets_json=?")
            params.append(jdump(validate_diet_codes(changes["diets"], False)))
        if changes.get("share_allergies") is not None:
            sets.append("share_allergies=?")
            params.append(1 if changes["share_allergies"] else 0)
        if changes.get("ready") is not None:
            sets.append("ready=?")
            params.append(1 if changes["ready"] else 0)
            text = f"{ctx.participant['name']} " + ("выбрал(а) и готов(а) ✓" if changes["ready"] else "ещё выбирает")
        if not sets:
            return
        with self.db.tx() as conn:
            conn.execute(f"UPDATE participants SET {', '.join(sets)} WHERE id=?", (*params, ctx.pid))
            audit(conn, "guest", ctx.participant["name"], "profile_updated", "participant", ctx.pid, ctx.sid, {k: v for k, v in changes.items() if v is not None})
        self.notify(ctx.sid, "profile", text, ctx.participant, staff=False)

    def leave(self, ctx: GuestCtx) -> None:
        if self.db.scalar("SELECT count(*) FROM order_items WHERE participant_id=?", (ctx.pid,), 0):
            raise ApiError(409, "has_orders", "У вас уже есть отправленные блюда — покинуть стол можно после расчёта")
        if self.db.scalar("SELECT count(*) FROM payments WHERE payer_id=? AND status IN ('pending','awaiting_cash','paid')", (ctx.pid,), 0):
            raise ApiError(409, "has_payments", "У вас есть оплаты в этой группе")
        with self.db.tx() as conn:
            conn.execute("DELETE FROM cart_items WHERE participant_id=?", (ctx.pid,))
            rows = conn.execute("SELECT id, shared_with_json FROM cart_items WHERE session_id=?", (ctx.sid,)).fetchall()
            for row in rows:
                shared = [p for p in jload(row["shared_with_json"], []) if p != ctx.pid]
                conn.execute("UPDATE cart_items SET shared_with_json=? WHERE id=?", (jdump(shared), row["id"]))
            conn.execute("DELETE FROM waiter_calls WHERE participant_id=? AND status='open'", (ctx.pid,))
            conn.execute("DELETE FROM participants WHERE id=?", (ctx.pid,))
            remaining = conn.execute("SELECT id FROM participants WHERE session_id=? ORDER BY joined_at, rowid", (ctx.sid,)).fetchall()
            if remaining:
                if ctx.participant["role"] == "host":
                    conn.execute("UPDATE participants SET role='host' WHERE id=?", (remaining[0]["id"],))
            elif not conn.execute("SELECT 1 FROM orders WHERE session_id=?", (ctx.sid,)).fetchone():
                conn.execute("UPDATE sessions SET status='closed', closed_at=?, close_reason='empty', updated_at=? WHERE id=?",
                             (iso(now_utc()), iso(now_utc()), ctx.sid))
            audit(conn, "guest", ctx.participant["name"], "left", "participant", ctx.pid, ctx.sid)
        self.presence.disconnect(ctx.sid, ctx.pid)
        self.notify(ctx.sid, "left", f"{ctx.participant['name']} вышел(ла) из группы", ctx.participant)

    def set_viewing(self, ctx: GuestCtx, kind: str, ref: Optional[str]) -> Optional[dict[str, Any]]:
        viewing: Optional[dict[str, Any]] = None
        tabs = {"cart": "корзину", "table": "компанию", "bill": "счёт", "orders": "статус заказа", "profile": "свои аллергии", "menu": "меню"}
        if kind == "dish" and ref and str(ref).isdigit():
            item = self.menu.index().get(int(ref))
            if item:
                viewing = {"kind": "dish", "id": item["id"], "label": item["name"], "emoji": item["emoji"]}
        elif kind == "category" and ref:
            category = next((c for c in self.menu.categories() if c["code"] == ref), None)
            if category:
                viewing = {"kind": "category", "id": category["code"], "label": category["name"], "emoji": category["emoji"]}
        elif kind == "tab" and ref in tabs:
            viewing = {"kind": "tab", "id": ref, "label": tabs[ref], "emoji": ""}
        elif kind == "search" and ref:
            viewing = {"kind": "search", "id": None, "label": clean_text(str(ref), 40), "emoji": "🔎"}
        self.presence.touch(ctx.sid, ctx.pid, viewing, update_viewing=True)
        self.bus.publish(f"session:{ctx.sid}", "presence", {"participant_id": ctx.pid, "online": True, "viewing": viewing})
        return viewing

    def set_deadline(self, ctx: GuestCtx, minutes: Optional[int]) -> None:
        self.require_open(ctx.session)
        deadline = None if not minutes else iso(now_utc() + timedelta(minutes=int(clamp(minutes, 5, 240))))
        with self.db.tx() as conn:
            conn.execute("UPDATE sessions SET deadline_at=?, updated_at=? WHERE id=?", (deadline, iso(now_utc()), ctx.sid))
            audit(conn, "guest", ctx.participant["name"], "deadline_set", "session", ctx.sid, ctx.sid, {"deadline_at": deadline})
        local = to_local(parse_dt(deadline)).strftime("%H:%M") if deadline else ""
        text = f"{ctx.participant['name']}: нам нужно уйти к {local}" if deadline else f"{ctx.participant['name']} снял(а) ограничение по времени"
        self.notify(ctx.sid, "deadline", text, ctx.participant)
        self.bus.publish(self.staff_channel(), "kitchen", {"reason": "deadline", "session_id": ctx.sid})

    def call_waiter(self, ctx: GuestCtx, reason: str) -> None:
        if reason not in WAITER_CALL_REASONS:
            raise ApiError(422, "reason_invalid", "Выберите причину вызова")
        if ctx.session["status"] == "closed":
            raise ApiError(409, "session_closed", "Стол уже закрыт")
        existing = self.db.one("SELECT id FROM waiter_calls WHERE session_id=? AND participant_id=? AND reason=? AND status='open'", (ctx.sid, ctx.pid, reason))
        if existing:
            raise ApiError(409, "call_exists", "Официант уже получил ваш вызов — он скоро подойдёт")
        with self.db.tx() as conn:
            conn.execute(
                "INSERT INTO waiter_calls(id, session_id, participant_id, participant_name, reason, created_at) VALUES (?,?,?,?,?,?)",
                (new_id("call"), ctx.sid, ctx.pid, ctx.participant["name"], reason, iso(now_utc())),
            )
            audit(conn, "guest", ctx.participant["name"], "waiter_called", "session", ctx.sid, ctx.sid, {"reason": reason})
        label = ctx.session["title"] or "Группа"
        self.bus.publish(self.staff_channel(), "call", {"session_id": ctx.sid, "text": f"{label}: {WAITER_CALL_REASONS[reason]} — {ctx.participant['name']}"})
        self.notify(ctx.sid, "call", f"{ctx.participant['name']} позвал(а) официанта", ctx.participant, staff=False)

    def state(self, session_id: str, me_id: Optional[str], base_url: str) -> dict[str, Any]:
        session = self.db.one("SELECT * FROM sessions WHERE id=?", (session_id,))
        table = self.db.one("SELECT * FROM dining_tables WHERE id=?", (session["table_id"],)) if session["table_id"] else None
        participants = self.active_participants(session_id)
        cart_rows = self.db.all("SELECT * FROM cart_items WHERE session_id=? ORDER BY created_at, rowid", (session_id,))
        order_rows = self.db.all("SELECT * FROM orders WHERE session_id=? ORDER BY batch", (session_id,))
        item_rows = self.db.all("SELECT * FROM order_items WHERE session_id=? ORDER BY created_at, rowid", (session_id,))
        payment_rows = self.db.all("SELECT * FROM payments WHERE session_id=? ORDER BY created_at, rowid", (session_id,))
        alloc_rows = self.db.all(
            "SELECT a.* FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.session_id=?", (session_id,))
        calls = self.db.all("SELECT * FROM waiter_calls WHERE session_id=? AND status='open' ORDER BY created_at", (session_id,))
        menu_index = self.menu.index()
        presence = self.presence.snapshot(session_id)
        allocations: dict[str, dict[str, int]] = defaultdict(dict)
        for row in alloc_rows:
            allocations[row["payment_id"]][row["participant_id"]] = row["amount"]
        payments = [{**p, "allocations": allocations.get(p["id"], {})} for p in payment_rows]
        live_items = [
            {"id": r["id"], "order_id": r["order_id"], "participant_id": r["participant_id"], "name": r["name"], "emoji": r["emoji"],
             "qty": r["qty"], "line_total": r["line_total"], "shared_with": jload(r["shared_with_json"], []), "status": r["status"]}
            for r in item_rows if r["status"] != "cancelled"
        ]
        orders_by_id = {o["id"]: o for o in order_rows}
        bill = compute_bill([{"id": p["id"]} for p in participants], live_items, orders_by_id, payments)
        bill_rows = {row["participant_id"]: row for row in bill["participants"]}
        names = {p["id"]: p["name"] for p in participants}
        profiles = {p["id"]: jload(p["allergens_json"], []) for p in participants}
        visible_profile = {p["id"]: p["share_allergies"] or p["id"] == me_id for p in participants}
        me = next((p for p in participants if p["id"] == me_id), None)
        cart = []
        for row in cart_rows:
            contains, traces = jload(row["allergens_json"], []), jload(row["traces_json"], [])
            shared = [p for p in jload(row["shared_with_json"], []) if p in names]
            holders = [row["participant_id"], *shared]
            warnings = []
            for holder in holders:
                if holder in profiles and visible_profile.get(holder):
                    conflict = allergen_conflicts(contains, traces, profiles[holder])
                    if conflict["level"] in {"danger", "caution"}:
                        warnings.append({"participant_id": holder, "name": names[holder], **conflict})
            current = menu_index.get(row["menu_item_id"])
            options = jload(row["options_json"], [])
            cart.append({
                "id": row["id"], "participant_id": row["participant_id"], "menu_item_id": row["menu_item_id"], "name": row["name"],
                "emoji": row["emoji"], "category_code": row["category_code"], "qty": row["qty"], "unit_price": row["unit_price"],
                "line_total": row["unit_price"] * row["qty"], "kcal": row["kcal"], "protein": row["protein"], "fat": row["fat"],
                "carbs": row["carbs"], "allergens": contains, "traces": traces,
                "options": [{"group_id": o["group_id"], "id": o["id"], "group": o["group"], "choice": o["name"], "price": o["price"]} for o in options],
                "note": row["note"], "shared_with": shared, "cook_minutes": row["cook_minutes"], "warnings": warnings,
                "price_changed": bool(current and current["price"] != row["base_price"]),
                "price_now": current["price"] if current else None,
                "unavailable": not current or not current["available"],
                "mine": row["participant_id"] == me_id, "created_at": row["created_at"],
            })
        orders = []
        for order in order_rows:
            meta = ORDER_STATUS[order["status"]]
            o_items = [r for r in item_rows if r["order_id"] == order["id"]]
            active = [r for r in o_items if r["status"] != "cancelled"]
            done = sum(1 for r in active if r["status"] in ("ready", "served"))
            progress = meta["progress"]
            if order["status"] in ("accepted", "cooking") and active:
                progress = max(progress, 0.3 + 0.55 * done / len(active))
            orders.append({
                "id": order["id"], "number": order["number"], "batch": order["batch"], "status": order["status"],
                "label": meta["label"], "short": meta["short"], "progress": round(progress, 3), "scope": order["scope"],
                "submitted_by_name": order["submitted_by_name"], "kitchen_note": order["kitchen_note"], "cancel_reason": order["cancel_reason"],
                "created_at": order["created_at"], "accepted_at": order["accepted_at"], "cooking_at": order["cooking_at"],
                "ready_at": order["ready_at"], "served_at": order["served_at"], "cancelled_at": order["cancelled_at"],
                "eta_minutes": order["eta_minutes"], "eta_at": order["eta_at"], "eta_predicted": order["eta_predicted"],
                "subtotal": sum(r["line_total"] for r in active), "items_done": done, "items_total": len(active),
                "items": [{
                    "id": r["id"], "participant_id": r["participant_id"], "participant_name": r["participant_name"], "name": r["name"],
                    "emoji": r["emoji"], "qty": r["qty"], "line_total": r["line_total"], "status": r["status"], "cancel_reason": r["cancel_reason"],
                    "options": jload(r["options_json"], []), "note": r["note"], "shared_with": jload(r["shared_with_json"], []),
                    "menu_item_id": r["menu_item_id"],
                } for r in o_items],
            })
        people = []
        for p in participants:
            mine_cart = [c for c in cart if c["participant_id"] == p["id"]]
            info = presence.get(p["id"], {"online": False, "viewing": None})
            b = bill_rows.get(p["id"], {})
            people.append({
                "id": p["id"], "name": p["name"], "avatar": p["avatar"], "color": p["color"], "role": p["role"],
                "ready": bool(p["ready"]), "online": info["online"] or p["id"] == me_id, "viewing": info["viewing"], "is_me": p["id"] == me_id,
                "allergens": profiles[p["id"]] if visible_profile[p["id"]] else [],
                "diets": jload(p["diets_json"], []) if visible_profile[p["id"]] else [],
                "cart_count": sum(c["qty"] for c in mine_cart), "cart_total": sum(c["line_total"] for c in mine_cart),
                "cart_kcal": sum(c["kcal"] * c["qty"] for c in mine_cart),
                "shared_in_cart": sum(1 for c in cart if p["id"] in c["shared_with"]),
                "bill_total": b.get("total", 0), "bill_due": b.get("due", 0), "bill_paid": b.get("paid", 0), "bill_status": b.get("status", "empty"),
                "joined_at": p["joined_at"],
            })
        nutrition = {"kcal": 0.0, "protein": 0.0, "fat": 0.0, "carbs": 0.0}
        if me:
            for c in cart:
                holders = [c["participant_id"], *c["shared_with"]]
                if me_id in holders:
                    for key in nutrition:
                        nutrition[key] += c[key] * c["qty"] / len(holders)
            for r in item_rows:
                holders = [r["participant_id"], *[x for x in jload(r["shared_with_json"], []) if x in names]]
                if me_id in holders and r["status"] != "cancelled":
                    for key in nutrition:
                        nutrition[key] += r[key] * r["qty"] / len(holders)
        join_path = f"/t/{table['qr_token']}" if table else f"/g/{session['code']}"
        mode = self.mode_of(session, len(participants))
        return {
            "server_time": iso(now_utc()),
            "session": {
                "id": session["id"], "code": session["code"], "kind": session["kind"], "title": session["title"] or (table["label"] if table else ""),
                "status": session["status"], "intent": session["intent"], "mode": mode, "service_percent": session["service_percent"],
                "deadline_at": session["deadline_at"], "cutoff_at": session["cutoff_at"], "pickup_note": session["pickup_note"],
                "created_at": session["created_at"], "closed_at": session["closed_at"], "close_reason": session["close_reason"],
                "auto_submitted_at": session["auto_submitted_at"],
                "table": {"label": table["label"], "zone": table["zone"], "seats": table["seats"]} if table else None,
                "join_url": base_url + join_path, "join_path": join_path,
                "qr_url": f"/api/tables/{table['qr_token']}/qr.svg" if table else f"/api/sessions/{session['code']}/qr.svg",
            },
            "me": None if not me else {
                "id": me["id"], "name": me["name"], "avatar": me["avatar"], "color": me["color"], "role": me["role"],
                "allergens": profiles[me["id"]], "diets": jload(me["diets_json"], []), "share_allergies": bool(me["share_allergies"]),
                "ready": bool(me["ready"]), "recovery_pin": me["recovery_pin"],
                "nutrition": {k: round(v, 1) for k, v in nutrition.items()},
            },
            "participants": people,
            "cart": {
                "items": cart, "count": sum(c["qty"] for c in cart), "total": sum(c["line_total"] for c in cart),
                "my_count": sum(c["qty"] for c in cart if c["mine"]), "my_total": sum(c["line_total"] for c in cart if c["mine"]),
                "warnings": sum(1 for c in cart if any(w["level"] == "danger" for w in c["warnings"])),
                "unavailable": sum(1 for c in cart if c["unavailable"]),
            },
            "orders": orders,
            "bill": {k: v for k, v in bill.items() if k != "participants"} | {"participants": [
                {**row, "name": names.get(row["participant_id"], "")} for row in bill["participants"]]},
            "payments": [{
                "id": p["id"], "payer_id": p["payer_id"], "payer_name": names.get(p["payer_id"], "Официант"), "kind": p["kind"],
                "method": p["method"], "method_title": PAYMENT_METHODS.get(p["method"], {}).get("title", p["method"]), "amount": p["amount"],
                "tip": p["tip"], "status": p["status"], "created_at": p["created_at"], "paid_at": p["paid_at"],
                "beneficiaries": list(p["allocations"].keys()), "provider_ref": p["provider_ref"],
            } for p in payments],
            "calls": [{"id": c["id"], "reason": c["reason"], "label": WAITER_CALL_REASONS.get(c["reason"], c["reason"]),
                       "participant_id": c["participant_id"], "created_at": c["created_at"]} for c in calls],
        }
