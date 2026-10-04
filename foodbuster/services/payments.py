"""Split payments: each guest pays their share (or for friends), tips, cash through the waiter, refunds of overpayments."""

from __future__ import annotations

import secrets
import sqlite3
from collections import defaultdict
from datetime import timedelta
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.money import fmt_money, percent_of
from foodbuster.core.utils import clamp, iso, jdump, jload, new_id, now_utc
from foodbuster.db.database import Database, audit
from foodbuster.domain.billing import compute_bill
from foodbuster.domain.reference import PAYMENT_METHODS
from foodbuster.services.context import GuestCtx, StaffCtx
from foodbuster.services.integrations import IntegrationHub
from foodbuster.services.realtime import EventBus
from foodbuster.services.sessions import SessionService


class PaymentService:
    def __init__(self, db: Database, bus: EventBus, sessions: SessionService, hub: IntegrationHub) -> None:
        self.db = db
        self.bus = bus
        self.sessions = sessions
        self.hub = hub

    def _bill(self, conn: sqlite3.Connection, session_id: str) -> dict[str, Any]:
        participants = conn.execute("SELECT id FROM participants WHERE session_id=? ORDER BY joined_at, rowid", (session_id,)).fetchall()
        items = conn.execute("SELECT * FROM order_items WHERE session_id=? AND status<>'cancelled'", (session_id,)).fetchall()
        orders = {o["id"]: o for o in conn.execute("SELECT id, service_percent FROM orders WHERE session_id=?", (session_id,)).fetchall()}
        payments = conn.execute("SELECT * FROM payments WHERE session_id=?", (session_id,)).fetchall()
        allocs: dict[str, dict[str, int]] = defaultdict(dict)
        for row in conn.execute("SELECT a.* FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.session_id=?", (session_id,)).fetchall():
            allocs[row["payment_id"]][row["participant_id"]] = row["amount"]
        lines = [{"id": i["id"], "order_id": i["order_id"], "participant_id": i["participant_id"], "name": i["name"], "qty": i["qty"],
                  "line_total": i["line_total"], "shared_with": jload(i["shared_with_json"], []), "status": i["status"]} for i in items]
        return compute_bill(list(participants), lines, orders, [{**p, "allocations": allocs.get(p["id"], {})} for p in payments])

    def create(self, ctx: GuestCtx, beneficiaries: list[str], method: str, tip_percent: Optional[int], tip_amount: Optional[int],
               idem_key: Optional[str]) -> dict[str, Any]:
        if method not in PAYMENT_METHODS:
            raise ApiError(422, "method_invalid", "Выберите способ оплаты")
        if ctx.session["status"] == "closed":
            raise ApiError(409, "session_closed", "Стол уже закрыт")
        targets = list(dict.fromkeys(beneficiaries or [ctx.pid]))
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            if idem_key:
                stored = conn.execute("SELECT response_json FROM idempotency_keys WHERE key=? AND scope=?", (idem_key, f"pay:{ctx.pid}")).fetchone()
                if stored:
                    return jload(stored["response_json"], {})
            bill = self._bill(conn, ctx.sid)
            rows = {r["participant_id"]: r for r in bill["participants"]}
            unknown = [t for t in targets if t not in rows]
            if unknown:
                raise ApiError(422, "unknown_participant", "Нельзя оплатить за человека не из этой группы")
            dues = {t: rows[t]["due"] for t in targets if rows[t]["due"] > 0}
            amount = sum(dues.values())
            if amount <= 0:
                raise ApiError(409, "nothing_to_pay", "Оплачивать нечего: всё уже оплачено или ещё не отправлено на кухню")
            if tip_amount is not None:
                tip = max(0, int(tip_amount))
            else:
                tip = percent_of(amount, int(clamp(tip_percent or 0, 0, settings.max_tip_percent)))
            if tip > percent_of(amount, settings.max_tip_percent):
                raise ApiError(422, "tip_too_high", f"Чаевые не больше {settings.max_tip_percent}% от суммы")
            payment_id = new_id("pay")
            status = "awaiting_cash" if method == "cash" else "pending"
            ref = f"{PAYMENT_METHODS[method]['provider']}-{secrets.token_hex(5)}"
            conn.execute(
                """INSERT INTO payments(id, session_id, payer_id, kind, method, provider, provider_ref, amount, tip, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (payment_id, ctx.sid, ctx.pid, "payment", method, PAYMENT_METHODS[method]["provider"], ref, amount, tip, status, stamp, stamp),
            )
            conn.executemany("INSERT INTO payment_allocations(payment_id, participant_id, amount) VALUES (?,?,?)",
                             [(payment_id, pid, value) for pid, value in dues.items()])
            response = {"payment_id": payment_id, "status": status, "amount": amount, "tip": tip, "method": method,
                        "checkout": self._checkout(method, ref, amount + tip)}
            if idem_key:
                conn.execute("INSERT INTO idempotency_keys(key, scope, response_json, created_at) VALUES (?,?,?,?)",
                             (idem_key, f"pay:{ctx.pid}", jdump(response), stamp))
            audit(conn, "guest", ctx.participant["name"], "payment_created", "payment", payment_id, ctx.sid,
                  {"amount": amount, "tip": tip, "method": method, "for": list(dues)})
        names = len(dues)
        text = f"{ctx.participant['name']} оплачивает " + ("свою часть" if list(dues) == [ctx.pid] else f"за {names} чел.")
        self.sessions.notify(ctx.sid, "payment", text, ctx.participant)
        if method == "cash":
            self.bus.publish(self.sessions.staff_channel(), "call", {"session_id": ctx.sid, "text": f"Наличные {fmt_money(amount + tip)} — {ctx.participant['name']}"})
        return response

    @staticmethod
    def _checkout(method: str, ref: str, total: int) -> dict[str, Any]:
        if method == "kaspi":
            return {"type": "qr", "title": "Kaspi QR · демо", "payload": f"https://pay.kaspi.kz/pay/demo?ref={ref}&amount={total // 100}",
                    "hint": "Демо-режим: деньги не списываются. Боевой Kaspi Pay подключается через PaymentProvider"}
        if method == "card":
            return {"type": "card", "title": "Оплата картой · демо", "hint": "Демо-режим: данные карты не запрашиваются и не хранятся"}
        return {"type": "cash", "title": "Наличными", "hint": "Официант получил уведомление и подойдёт к столу"}

    def _own_payment(self, conn: sqlite3.Connection, ctx: GuestCtx, payment_id: str) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM payments WHERE id=? AND session_id=?", (payment_id, ctx.sid)).fetchone()
        if not row:
            raise ApiError(404, "payment_not_found", "Платёж не найден")
        if row["payer_id"] != ctx.pid:
            raise ApiError(403, "not_your_payment", "Подтвердить платёж может только тот, кто платит")
        return row

    def confirm(self, ctx: GuestCtx, payment_id: str) -> dict[str, Any]:
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            row = self._own_payment(conn, ctx, payment_id)
            if row["status"] == "paid":
                return {"payment_id": payment_id, "status": "paid"}
            if row["status"] != "pending":
                raise ApiError(409, "payment_state", "Этот платёж нельзя подтвердить в приложении")
            conn.execute("UPDATE payments SET status='paid', paid_at=?, updated_at=?, confirmed_by='provider' WHERE id=?", (stamp, stamp, payment_id))
            audit(conn, "guest", ctx.participant["name"], "payment_paid", "payment", payment_id, ctx.sid, {"amount": row["amount"], "tip": row["tip"]})
        self.sessions.notify(ctx.sid, "payment", f"{ctx.participant['name']} оплатил(а) {fmt_money(row['amount'] + row['tip'])} ✓")
        self.hub.emit("payment.paid", {"payment_id": payment_id, "amount": row["amount"], "tip": row["tip"]})
        return {"payment_id": payment_id, "status": "paid"}

    def cancel(self, ctx: GuestCtx, payment_id: str) -> None:
        with self.db.tx() as conn:
            row = self._own_payment(conn, ctx, payment_id)
            if row["status"] not in ("pending", "awaiting_cash"):
                raise ApiError(409, "payment_state", "Этот платёж уже завершён")
            conn.execute("UPDATE payments SET status='cancelled', updated_at=? WHERE id=?", (iso(now_utc()), payment_id))
            audit(conn, "guest", ctx.participant["name"], "payment_cancelled", "payment", payment_id, ctx.sid)
        self.sessions.notify(ctx.sid, "payment", f"{ctx.participant['name']} отменил(а) оплату")

    def confirm_cash(self, payment_id: str, actor: StaffCtx) -> None:
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            row = conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
            if not row:
                raise ApiError(404, "payment_not_found", "Платёж не найден")
            if row["status"] != "awaiting_cash":
                raise ApiError(409, "payment_state", "Платёж уже обработан")
            conn.execute("UPDATE payments SET status='paid', paid_at=?, updated_at=?, confirmed_by=? WHERE id=?", (stamp, stamp, actor.actor, payment_id))
            conn.execute("UPDATE waiter_calls SET status='resolved', resolved_at=? WHERE session_id=? AND reason='cash' AND status='open'", (stamp, row["session_id"]))
            audit(conn, "staff", actor.actor, "cash_confirmed", "payment", payment_id, row["session_id"], {"amount": row["amount"]})
        self.sessions.notify(row["session_id"], "payment", f"Официант принял наличные {fmt_money(row['amount'] + row['tip'])} ✓")

    def refund_overpaid(self, session_code: str, participant_id: str, actor: StaffCtx) -> int:
        session = self.sessions.session_by_code(session_code)
        stamp = iso(now_utc())
        with self.db.tx() as conn:
            bill = self._bill(conn, session["id"])
            row = next((r for r in bill["participants"] if r["participant_id"] == participant_id), None)
            if not row or row["overpaid"] <= 0:
                raise ApiError(409, "nothing_to_refund", "У гостя нет переплаты")
            payment_id = new_id("ref")
            conn.execute(
                """INSERT INTO payments(id, session_id, payer_id, kind, method, provider, provider_ref, amount, tip, status, created_at, updated_at,
                   paid_at, confirmed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (payment_id, session["id"], participant_id, "refund", "refund", "demo-refund", f"refund-{secrets.token_hex(5)}", row["overpaid"], 0,
                 "paid", stamp, stamp, stamp, actor.actor))
            conn.execute("INSERT INTO payment_allocations(payment_id, participant_id, amount) VALUES (?,?,?)", (payment_id, participant_id, row["overpaid"]))
            audit(conn, "staff", actor.actor, "refund", "payment", payment_id, session["id"], {"amount": row["overpaid"]})
        self.sessions.notify(session["id"], "payment", f"Возврат {fmt_money(row['overpaid'])} оформлен")
        return row["overpaid"]

    def expire_pending(self) -> int:
        cutoff = iso(now_utc() - timedelta(minutes=settings.pending_payment_expiry_minutes))
        rows = self.db.all("SELECT id, session_id FROM payments WHERE status='pending' AND created_at<?", (cutoff,))
        if rows:
            with self.db.tx() as conn:
                conn.executemany("UPDATE payments SET status='failed', updated_at=? WHERE id=?", [(iso(now_utc()), r["id"]) for r in rows])
            for sid in {r["session_id"] for r in rows}:
                self.sessions.notify(sid, "payment", "Неподтверждённая оплата истекла — попробуйте ещё раз")
        return len(rows)
