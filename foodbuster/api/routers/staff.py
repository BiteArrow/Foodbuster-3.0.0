"""Staff endpoints: login, kitchen display and the waiter floor."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from foodbuster.api.deps import ANY_STAFF, KITCHEN, KITCHEN_OR_WAITER, WAITER, base_url, sse_response
from foodbuster.api.schemas import AcceptIn, CloseIn, EtaIn, ItemStatusIn, LoginIn, PasswordIn, RefundIn, StatusIn
from foodbuster.container import FLOOR, MENU, ORDERS, PAYMENTS, SESSIONS, STAFF
from foodbuster.core.errors import ApiError
from foodbuster.services.context import StaffCtx

router = APIRouter()


@router.post("/api/staff/login", tags=["staff"])
def staff_login(payload: LoginIn) -> dict[str, Any]:
    return STAFF.login(payload.username, payload.password)


@router.get("/api/staff/me", tags=["staff"])
def staff_me(ctx: StaffCtx = Depends(ANY_STAFF)) -> dict[str, Any]:
    return {"role": ctx.role, "username": ctx.username, "restaurant": MENU.restaurant()["name"]}


@router.post("/api/staff/me/password", tags=["staff"])
def staff_password(payload: PasswordIn, ctx: StaffCtx = Depends(ANY_STAFF)) -> dict[str, Any]:
    STAFF.set_password(ctx.user_id, payload.new_password, ctx, current=payload.current_password or "")
    return {"ok": True}


@router.get("/api/staff/events", tags=["realtime"])
async def staff_events(request: Request, token: str = Query(min_length=10, max_length=600)) -> StreamingResponse:
    ctx = await asyncio.to_thread(STAFF.verify, token)
    if not ctx:
        raise ApiError(401, "staff_auth", "Войдите как сотрудник")
    return sse_response(request, [f"staff:{MENU.restaurant_id}", "menu", "public"], {"role": ctx.role})


@router.get("/api/kitchen/tickets", tags=["kitchen"])
def kitchen_tickets(_: StaffCtx = Depends(KITCHEN_OR_WAITER)) -> dict[str, Any]:
    return ORDERS.tickets()


@router.post("/api/kitchen/orders/{order_id}/accept", tags=["kitchen"])
def kitchen_accept(order_id: str, payload: AcceptIn, ctx: StaffCtx = Depends(KITCHEN)) -> dict[str, Any]:
    order = ORDERS.set_status(order_id, "accepted", ctx, payload.eta_minutes)
    return {"ok": True, "eta_minutes": order["eta_minutes"], "eta_at": order["eta_at"]}


@router.post("/api/kitchen/orders/{order_id}/status", tags=["kitchen"])
def kitchen_status(order_id: str, payload: StatusIn, ctx: StaffCtx = Depends(KITCHEN_OR_WAITER)) -> dict[str, Any]:
    if ctx.role == "waiter" and payload.status not in ("served",):
        raise ApiError(403, "forbidden", "Официант может только отметить подачу")
    order = ORDERS.set_status(order_id, payload.status, ctx, reason=payload.reason)
    return {"ok": True, "status": order["status"]}


@router.post("/api/kitchen/orders/{order_id}/eta", tags=["kitchen"])
def kitchen_eta(order_id: str, payload: EtaIn, ctx: StaffCtx = Depends(KITCHEN)) -> dict[str, Any]:
    order = ORDERS.adjust_eta(order_id, payload.delta, ctx)
    return {"ok": True, "eta_at": order["eta_at"], "eta_minutes": order["eta_minutes"]}


@router.post("/api/kitchen/items/{item_id}/status", tags=["kitchen"])
def kitchen_item(item_id: str, payload: ItemStatusIn, ctx: StaffCtx = Depends(KITCHEN)) -> dict[str, Any]:
    order = ORDERS.set_item_status(item_id, payload.status, ctx, payload.reason)
    return {"ok": True, "order_status": order["status"]}


@router.get("/api/waiter/floor", tags=["waiter"])
def waiter_floor(request: Request, _: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    return FLOOR.floor(base_url(request))


@router.get("/api/waiter/sessions/{code}", tags=["waiter"])
def waiter_session(code: str, request: Request, _: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    session = SESSIONS.session_by_code(code)
    return SESSIONS.state(session["id"], None, base_url(request))


@router.post("/api/waiter/calls/{call_id}/resolve", tags=["waiter"])
def waiter_resolve(call_id: str, ctx: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    FLOOR.resolve_call(call_id, ctx)
    return {"ok": True}


@router.post("/api/waiter/orders/{order_id}/served", tags=["waiter"])
def waiter_served(order_id: str, ctx: StaffCtx = Depends(KITCHEN_OR_WAITER)) -> dict[str, Any]:
    ORDERS.set_status(order_id, "served", ctx)
    return {"ok": True}


@router.post("/api/waiter/payments/{payment_id}/confirm-cash", tags=["waiter"])
def waiter_cash(payment_id: str, ctx: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    PAYMENTS.confirm_cash(payment_id, ctx)
    return {"ok": True}


@router.post("/api/waiter/sessions/{code}/close", tags=["waiter"])
def waiter_close(code: str, payload: CloseIn, ctx: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    FLOOR.close_session(code, payload.force, ctx)
    return {"ok": True}


@router.post("/api/waiter/sessions/{code}/refund", tags=["waiter"])
def waiter_refund(code: str, payload: RefundIn, ctx: StaffCtx = Depends(WAITER)) -> dict[str, Any]:
    return {"ok": True, "amount": PAYMENTS.refund_overpaid(code, payload.participant_id, ctx)}
