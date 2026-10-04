"""Guest endpoints: joining by QR, the shared cart, orders, payments and the live event stream."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse

from settings import settings
from foodbuster.api.deps import base_url, guest_ctx, guest_state, sse_response
from foodbuster.api.schemas import (CallIn, CartAddIn, CartUpdateIn, DeadlineIn, JoinIn, MeIn, OfficeIn, OfficeJoinIn, PaymentIn, PresenceIn,
                                    RecoverIn, SubmitIn)
from foodbuster.container import ANALYTICS, BUS, CART, ORDERS, PAYMENTS, PRESENCE, SESSIONS
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import iso, jload, now_utc
from foodbuster.db.database import DB
from foodbuster.services.context import GuestCtx

router = APIRouter()


@router.get("/api/t/{token}", tags=["guest"])
def table_preview(token: str) -> dict[str, Any]:
    return SESSIONS.table_preview(token)


@router.post("/api/t/{token}/join", tags=["guest"])
def table_join(token: str, payload: JoinIn) -> dict[str, Any]:
    return SESSIONS.join_table(token, payload.name, payload.avatar, payload.intent, payload.allergens, payload.diets, payload.share_allergies)


@router.post("/api/office", tags=["guest"])
def office_create(payload: OfficeIn) -> dict[str, Any]:
    return SESSIONS.create_office(payload.title, payload.name, payload.avatar, payload.cutoff_minutes, payload.pickup_note, payload.allergens, payload.diets)


@router.get("/api/g/{code}", tags=["guest"])
def office_preview(code: str) -> dict[str, Any]:
    return SESSIONS.office_preview(code)


@router.post("/api/g/{code}/join", tags=["guest"])
def office_join(code: str, payload: OfficeJoinIn) -> dict[str, Any]:
    return SESSIONS.join_office(code, payload.name, payload.avatar, payload.allergens, payload.diets)


@router.post("/api/s/{code}/recover", tags=["guest"])
def recover(code: str, payload: RecoverIn) -> dict[str, Any]:
    return SESSIONS.recover(code, payload.name, payload.pin)


@router.get("/api/s/{code}/state", tags=["guest"])
def session_state(request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    return SESSIONS.state(ctx.sid, ctx.pid, base_url(request))


@router.patch("/api/s/{code}/me", tags=["guest"])
def update_me(payload: MeIn, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    SESSIONS.update_me(ctx, payload.model_dump(exclude_unset=True))
    return guest_state(ctx, request)


@router.post("/api/s/{code}/leave", tags=["guest"])
def leave(ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    SESSIONS.leave(ctx)
    return {"ok": True}


@router.post("/api/s/{code}/presence", tags=["guest"])
def presence(payload: PresenceIn, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    return {"ok": True, "viewing": SESSIONS.set_viewing(ctx, payload.kind, payload.ref)}


@router.post("/api/s/{code}/cart", tags=["cart"])
def cart_add(payload: CartAddIn, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    line_id = CART.add(ctx, payload.menu_item_id, payload.qty, payload.options, payload.note, payload.shared_with)
    return guest_state(ctx, request, line_id=line_id)


@router.patch("/api/s/{code}/cart/{line_id}", tags=["cart"])
def cart_update(line_id: str, payload: CartUpdateIn, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    CART.update(ctx, line_id, payload.qty, payload.note, payload.shared_with)
    return guest_state(ctx, request)


@router.delete("/api/s/{code}/cart/{line_id}", tags=["cart"])
def cart_remove(line_id: str, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    CART.remove(ctx, line_id)
    return guest_state(ctx, request)


@router.post("/api/s/{code}/orders", tags=["orders"])
def submit_order(payload: SubmitIn, request: Request, ctx: GuestCtx = Depends(guest_ctx),
                 idempotency_key: Optional[str] = Header(default=None, max_length=80)) -> dict[str, Any]:
    result = ORDERS.submit(ctx, payload.scope, payload.confirm_allergens, payload.kitchen_note, idempotency_key)
    return guest_state(ctx, request, order=result)


@router.post("/api/s/{code}/orders/{order_id}/repeat", tags=["orders"])
def repeat_order(order_id: str, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    return guest_state(ctx, request, added=CART.repeat(ctx, order_id))


@router.post("/api/s/{code}/deadline", tags=["guest"])
def set_deadline(payload: DeadlineIn, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    SESSIONS.set_deadline(ctx, payload.minutes)
    return guest_state(ctx, request)


@router.post("/api/s/{code}/calls", tags=["guest"])
def call_waiter(payload: CallIn, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    SESSIONS.call_waiter(ctx, payload.reason)
    return guest_state(ctx, request)


@router.post("/api/s/{code}/payments", tags=["payments"])
def create_payment(payload: PaymentIn, request: Request, ctx: GuestCtx = Depends(guest_ctx),
                   idempotency_key: Optional[str] = Header(default=None, max_length=80)) -> dict[str, Any]:
    result = PAYMENTS.create(ctx, payload.beneficiaries, payload.method, payload.tip_percent, payload.tip_amount, idempotency_key)
    return guest_state(ctx, request, payment=result)


@router.post("/api/s/{code}/payments/{payment_id}/confirm", tags=["payments"])
def confirm_payment(payment_id: str, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    return guest_state(ctx, request, payment=PAYMENTS.confirm(ctx, payment_id))


@router.post("/api/s/{code}/payments/{payment_id}/cancel", tags=["payments"])
def cancel_payment(payment_id: str, request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    PAYMENTS.cancel(ctx, payment_id)
    return guest_state(ctx, request)


@router.get("/api/s/{code}/recommendations", tags=["guest"])
def recommendations(request: Request, ctx: GuestCtx = Depends(guest_ctx)) -> dict[str, Any]:
    return {"items": ANALYTICS.recommendations(SESSIONS.state(ctx.sid, ctx.pid, base_url(request)))}


@router.get("/api/s/{code}/events", tags=["realtime"])
async def session_events(code: str, request: Request, token: str = Query(min_length=10, max_length=200)) -> StreamingResponse:
    ctx = await asyncio.to_thread(SESSIONS.context, code, token)

    def opened() -> None:
        PRESENCE.connect(ctx.sid, ctx.pid)
        BUS.publish(f"session:{ctx.sid}", "presence", {"participant_id": ctx.pid, "online": True, "viewing": None})

    def closed() -> None:
        PRESENCE.disconnect(ctx.sid, ctx.pid)
        BUS.publish(f"session:{ctx.sid}", "presence", {"participant_id": ctx.pid, "online": PRESENCE.is_online(ctx.sid, ctx.pid), "viewing": None})

    return sse_response(request, [f"session:{ctx.sid}", "menu"], {"session": ctx.session["code"], "participant": ctx.pid}, opened, closed)


@router.post("/api/payments/webhook/{provider}", tags=["payments"])
async def payment_webhook(provider: str, request: Request, x_signature: Optional[str] = Header(default=None)) -> dict[str, Any]:
    body = await request.body()
    expected = hmac.new(settings.secret_key.encode(), body, hashlib.sha256).hexdigest()
    if not x_signature or not hmac.compare_digest(x_signature, expected):
        raise ApiError(401, "signature", "Неверная подпись провайдера")
    payload = jload(body.decode("utf-8", "replace"), {})
    await asyncio.to_thread(_apply_webhook, provider, payload)
    return {"ok": True}


def _apply_webhook(provider: str, payload: dict[str, Any]) -> None:
    row = DB.one("SELECT * FROM payments WHERE provider_ref=? AND provider LIKE ?", (str(payload.get("provider_ref", "")), f"%{provider}%"))
    if not row:
        raise ApiError(404, "payment_not_found", "Платёж не найден")
    if payload.get("status") == "paid" and row["status"] == "pending":
        with DB.tx() as conn:
            conn.execute("UPDATE payments SET status='paid', paid_at=?, updated_at=?, confirmed_by=? WHERE id=?", (iso(now_utc()), iso(now_utc()), provider, row["id"]))
        SESSIONS.notify(row["session_id"], "payment", "Оплата подтверждена банком ✓")
