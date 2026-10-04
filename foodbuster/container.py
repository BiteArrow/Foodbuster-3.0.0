"""Wires the services together. Everything that holds state lives here, so routers stay thin."""

from __future__ import annotations

import contextlib
import time
from typing import Any

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.i18n import compile_catalogs
from foodbuster.core.logging import log
from foodbuster.core.security import RateLimiter
from foodbuster.db.database import DB, audit
from foodbuster.db.seed import seed_catalog, seed_demo_history, seed_live_demo, seed_staff
from foodbuster.services.admin import AdminService
from foodbuster.services.analytics import AnalyticsService
from foodbuster.services.cart import CartService
from foodbuster.services.context import StaffCtx
from foodbuster.services.floor import FloorService
from foodbuster.services.integrations import IntegrationHub
from foodbuster.services.maintenance import Maintenance
from foodbuster.services.menu import MenuService
from foodbuster.services.orders import OrderService
from foodbuster.services.payments import PaymentService
from foodbuster.services.realtime import EventBus, PresenceHub
from foodbuster.services.sessions import SessionService
from foodbuster.services.staff import StaffService
from foodbuster.services.tunnel import TunnelManager, safe_print

RUNTIME: dict[str, Any] = {"port": settings.port, "public_url": settings.public_url, "tunnel_mode": settings.tunnel.mode, "started": time.time()}
BUS = EventBus()
PRESENCE = PresenceHub()
LIMITER = RateLimiter()
HUB = IntegrationHub(settings.webhook_urls, settings.secret_key)
MENU = MenuService(DB, BUS)
SESSIONS = SessionService(DB, BUS, PRESENCE, MENU)
CART = CartService(DB, MENU, SESSIONS)
ORDERS = OrderService(DB, BUS, MENU, SESSIONS, HUB)
PAYMENTS = PaymentService(DB, BUS, SESSIONS, HUB)
FLOOR = FloorService(DB, BUS, SESSIONS, PAYMENTS, MENU)
ANALYTICS = AnalyticsService(DB, MENU)
ADMIN = AdminService(DB, BUS, MENU, SESSIONS)
STAFF = StaffService(DB)
MAINTENANCE = Maintenance(DB, ORDERS, PAYMENTS, FLOOR, SESSIONS)


def announce_public_url(url: str) -> None:
    tables = []
    with contextlib.suppress(Exception):
        tables = DB.all("SELECT label, qr_token FROM dining_tables WHERE is_active=1 AND is_archived=0 ORDER BY sort, id LIMIT 12")
    line = "═" * 64
    safe_print(f"\n{line}\n  ПУБЛИЧНЫЙ АДРЕС (открывается с мобильного интернета):\n  {url}\n")
    for table in tables:
        safe_print(f"  {table['label']:<10} {url}/t/{table['qr_token']}")
    safe_print(f"\n  Персонал: {url}/staff\n{line}\n")


TUNNEL = TunnelManager(settings.tunnel, lambda state: BUS.publish("public", "access", {"tunnel": state}), announce_public_url)


def bootstrap() -> None:
    compile_catalogs()
    DB.initialize()
    restaurant_id = seed_catalog(DB)
    seed_staff(DB)
    if settings.demo_mode and settings.demo_history_days:
        seed_demo_history(DB, restaurant_id)
    try:
        seed_live_demo(SESSIONS, CART, ORDERS, MENU)
    except ApiError as exc:
        log.warning("Live demo skipped: %s", exc.message)
    settings.media_dir.mkdir(parents=True, exist_ok=True)


def reset_demo(full: bool, actor: StaffCtx) -> None:
    with DB.tx() as conn:
        conn.execute("DELETE FROM payment_allocations")
        for table in ("payments", "waiter_calls", "order_items", "orders", "cart_items", "participants", "sessions", "idempotency_keys"):
            conn.execute(f"DELETE FROM {table}")
        if full:
            for table in ("menu_items", "categories", "dining_tables", "restaurants"):
                conn.execute(f"DELETE FROM {table}")
        audit(conn, "staff", actor.actor, "demo_reset", "system", "", payload={"full": full})
    MENU._restaurant_id = None
    MENU.drop_cache()
    PRESENCE.clear()
    bootstrap()
    MENU.invalidate("reset")
    BUS.publish("public", "tables", {})
    BUS.publish(f"staff:{MENU.restaurant_id}", "floor", {"reason": "reset"})
