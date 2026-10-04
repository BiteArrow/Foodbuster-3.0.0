from __future__ import annotations

import contextlib
from datetime import timedelta

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import iso, now_utc
from foodbuster.db.database import Database
from foodbuster.services.context import StaffCtx
from foodbuster.services.floor import FloorService
from foodbuster.services.orders import OrderService
from foodbuster.services.payments import PaymentService
from foodbuster.services.sessions import SessionService


class Maintenance:
    def __init__(self, db: Database, orders: OrderService, payments: PaymentService, floor: FloorService, sessions: SessionService) -> None:
        self.db = db
        self.orders = orders
        self.payments = payments
        self.floor = floor
        self.sessions = sessions
        self.runs = 0

    def run_once(self) -> dict[str, int]:
        self.runs += 1
        now = now_utc()
        stats = {"office_cutoffs": 0, "expired_payments": 0, "closed": 0}
        for row in self.db.all("SELECT id FROM sessions WHERE kind='office' AND status='open' AND cutoff_at IS NOT NULL AND cutoff_at<=?", (iso(now),)):
            self.orders.auto_submit_office(row["id"])
            stats["office_cutoffs"] += 1
        stats["expired_payments"] = self.payments.expire_pending()
        system = StaffCtx("system")
        idle_before = iso(now - timedelta(minutes=settings.session_idle_close_minutes))
        paid_before = iso(now - timedelta(minutes=settings.paid_session_autoclose_minutes))
        activity_sql = """SELECT s.*, max(s.updated_at,
                   coalesce((SELECT max(coalesce(o.served_at, o.ready_at, o.created_at)) FROM orders o WHERE o.session_id=s.id), ''),
                   coalesce((SELECT max(p.updated_at) FROM payments p WHERE p.session_id=s.id), '')) AS last_activity
                   FROM sessions s WHERE s.status IN ('open','locked')"""
        for session in self.db.all(activity_sql):
            if session["last_activity"] >= paid_before:
                continue
            active = self.db.scalar("SELECT count(*) FROM orders WHERE session_id=? AND status IN ('submitted','accepted','cooking','ready')", (session["id"],), 0)
            if active:
                continue
            bill = self.payments._bill(self.db.conn(), session["id"])
            settled = bill["grand_total"] > 0 and bill["due_total"] == 0 and bill["pending_total"] == 0
            empty_idle = bill["grand_total"] == 0 and session["last_activity"] < idle_before
            if settled or empty_idle:
                with contextlib.suppress(ApiError):
                    self.floor.close_session(session["code"], True, system)
                    stats["closed"] += 1
        with self.db.tx() as conn:
            conn.execute("DELETE FROM idempotency_keys WHERE created_at<?", (iso(now - timedelta(days=1)),))
        return stats
