"""Waiter floor: live state of every table, calls, cash and closing tables."""

from __future__ import annotations

from collections import Counter
from typing import Any

from foodbuster.core.errors import ApiError
from foodbuster.core.utils import iso, now_utc
from foodbuster.db.database import Database, audit
from foodbuster.domain.reference import ORDER_STATUS, WAITER_CALL_REASONS
from foodbuster.services.context import StaffCtx
from foodbuster.services.menu import MenuService
from foodbuster.services.payments import PaymentService
from foodbuster.services.realtime import EventBus
from foodbuster.services.sessions import SessionService


class FloorService:
    def __init__(self, db: Database, bus: EventBus, sessions: SessionService, payments: PaymentService, menu: MenuService) -> None:
        self.db = db
        self.bus = bus
        self.sessions = sessions
        self.payments = payments
        self.menu = menu

    def _session_summary(self, session: dict[str, Any]) -> dict[str, Any]:
        people = self.sessions.active_participants(session["id"])
        orders = self.db.all("SELECT * FROM orders WHERE session_id=? ORDER BY batch", (session["id"],))
        cart = self.db.one("SELECT coalesce(sum(qty),0) AS n, coalesce(sum(qty*unit_price),0) AS total FROM cart_items WHERE session_id=?", (session["id"],))
        calls = self.db.all("SELECT * FROM waiter_calls WHERE session_id=? AND status='open' ORDER BY created_at", (session["id"],))
        bill = self.payments._bill(self.db.conn(), session["id"])
        pending_cash = self.db.all("SELECT * FROM payments WHERE session_id=? AND status='awaiting_cash'", (session["id"],))
        statuses = Counter(o["status"] for o in orders)
        active = statuses["submitted"] + statuses["accepted"] + statuses["cooking"]
        if statuses["ready"]:
            state = "ready"
        elif active:
            state = "waiting"
        elif bill["grand_total"] and bill["due_total"] == 0 and not bill["pending_total"]:
            state = "paid"
        elif bill["grand_total"]:
            state = "eating"
        else:
            state = "ordering"
        names = {p["id"]: p["name"] for p in people}
        return {
            "code": session["code"], "kind": session["kind"], "title": session["title"], "status": session["status"], "state": state,
            "opened_at": session["created_at"], "deadline_at": session["deadline_at"], "cutoff_at": session["cutoff_at"],
            "participants": [{"id": p["id"], "name": p["name"], "avatar": p["avatar"], "color": p["color"]} for p in people],
            "cart_count": cart["n"], "cart_total": cart["total"],
            "orders": [{"id": o["id"], "number": o["number"], "status": o["status"], "label": ORDER_STATUS[o["status"]]["short"],
                        "eta_at": o["eta_at"], "ready_at": o["ready_at"]} for o in orders],
            "bill": {"grand_total": bill["grand_total"], "paid_total": bill["paid_total"], "due_total": bill["due_total"],
                     "pending_total": bill["pending_total"], "overpaid_total": bill["overpaid_total"],
                     "rows": [{"participant_id": r["participant_id"], "name": names.get(r["participant_id"], ""), "total": r["total"],
                               "due": r["due"], "paid": r["paid"], "overpaid": r["overpaid"], "status": r["status"]} for r in bill["participants"]]},
            "calls": [{"id": c["id"], "reason": c["reason"], "label": WAITER_CALL_REASONS.get(c["reason"], c["reason"]),
                       "name": c["participant_name"], "created_at": c["created_at"]} for c in calls],
            "cash": [{"id": p["id"], "amount": p["amount"], "tip": p["tip"], "payer": names.get(p["payer_id"], ""), "created_at": p["created_at"]}
                     for p in pending_cash],
        }

    def floor(self, base_url: str) -> dict[str, Any]:
        tables = self.db.all("SELECT * FROM dining_tables WHERE restaurant_id=? AND is_active=1 AND is_archived=0 ORDER BY sort, id", (self.menu.restaurant_id,))
        sessions = self.db.all("SELECT * FROM sessions WHERE restaurant_id=? AND status IN ('open','locked') ORDER BY created_at", (self.menu.restaurant_id,))
        by_table = {s["table_id"]: s for s in sessions if s["table_id"]}
        result_tables = []
        for table in tables:
            session = by_table.get(table["id"])
            result_tables.append({
                "id": table["id"], "label": table["label"], "zone": table["zone"], "seats": table["seats"],
                "x": table["map_x"], "y": table["map_y"], "join_url": f"{base_url}/t/{table['qr_token']}",
                "session": self._session_summary(session) if session else None,
            })
        office = [self._session_summary(s) | {"join_url": f"{base_url}/g/{s['code']}"} for s in sessions if s["kind"] == "office"]
        ready = self.db.all(
            """SELECT o.id, o.number, o.ready_at, s.title, s.kind, t.label FROM orders o JOIN sessions s ON s.id=o.session_id
               LEFT JOIN dining_tables t ON t.id=s.table_id WHERE o.restaurant_id=? AND o.status='ready' ORDER BY o.ready_at""",
            (self.menu.restaurant_id,))
        return {
            "server_time": iso(now_utc()), "tables": result_tables, "office": office,
            "ready": [{"id": r["id"], "number": r["number"], "ready_at": r["ready_at"], "table": r["label"] or r["title"]} for r in ready],
            "feed": [e for e in list(self.bus.recent)[:25] if e["type"] in ("call", "kitchen", "floor") and e["data"].get("text")],
        }

    def resolve_call(self, call_id: str, actor: StaffCtx) -> None:
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM waiter_calls WHERE id=?", (call_id,)).fetchone()
            if not row:
                raise ApiError(404, "call_not_found", "Вызов не найден")
            conn.execute("UPDATE waiter_calls SET status='resolved', resolved_at=? WHERE id=?", (iso(now_utc()), call_id))
            audit(conn, "staff", actor.actor, "call_resolved", "waiter_call", call_id, row["session_id"])
        self.sessions.notify(row["session_id"], "call", "Официант уже идёт к вам")

    def close_session(self, code: str, force: bool, actor: StaffCtx) -> None:
        session = self.sessions.session_by_code(code)
        if session["status"] == "closed":
            raise ApiError(409, "already_closed", "Стол уже закрыт")
        with self.db.tx() as conn:
            bill = self.payments._bill(conn, session["id"])
            active = conn.execute("SELECT count(*) AS n FROM orders WHERE session_id=? AND status IN ('submitted','accepted','cooking','ready')",
                                  (session["id"],)).fetchone()["n"]
            if (bill["due_total"] or bill["pending_total"] or active) and not force:
                raise ApiError(409, "close_blocked", "У стола есть неоплаченные или неподанные позиции",
                               {"due": bill["due_total"], "pending": bill["pending_total"], "active_orders": active})
            stamp = iso(now_utc())
            conn.execute("UPDATE sessions SET status='closed', closed_at=?, close_reason=?, updated_at=? WHERE id=?",
                         (stamp, "forced" if force and (bill["due_total"] or active) else "staff", stamp, session["id"]))
            conn.execute("UPDATE payments SET status='cancelled', updated_at=? WHERE session_id=? AND status IN ('pending','awaiting_cash')", (stamp, session["id"]))
            conn.execute("UPDATE waiter_calls SET status='resolved', resolved_at=? WHERE session_id=? AND status='open'", (stamp, session["id"]))
            conn.execute("DELETE FROM cart_items WHERE session_id=?", (session["id"],))
            audit(conn, "staff", actor.actor, "session_closed", "session", session["id"], session["id"], {"force": force, "due": bill["due_total"]})
        self.sessions.notify(session["id"], "closed", "Стол закрыт. Спасибо, что были у нас!")
        self.sessions.presence.forget(session["id"])
