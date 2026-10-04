"""Request dependencies shared by routers: guest and staff auth, public address, SSE streaming."""

from __future__ import annotations

import asyncio
import contextlib
import socket
from typing import Any, AsyncIterator, Callable, Optional

from fastapi import Header, Request
from fastapi.responses import StreamingResponse

from settings import settings
from foodbuster.container import BUS, RUNTIME, SESSIONS, STAFF, TUNNEL
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import iso, jdump, now_utc
from foodbuster.services.context import GuestCtx, StaffCtx


def is_private_host(host: str) -> bool:
    if host in ("localhost", "0.0.0.0", "::1") or host.endswith(".local"):
        return True
    parts = host.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        a, b = int(parts[0]), int(parts[1])
        return a in (10, 127) or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31) or (a == 169 and b == 254) or (a == 100 and 64 <= b <= 127)
    return False


def lan_ip() -> str:
    with contextlib.suppress(OSError):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("10.255.255.255", 1))
            address = probe.getsockname()[0]
        finally:
            probe.close()
        if address and not address.startswith("127."):
            return address
    with contextlib.suppress(OSError):
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            if not info[4][0].startswith("127."):
                return info[4][0]
    return "127.0.0.1"


def access_info(request: Optional[Request] = None) -> dict[str, Any]:
    tunnel = TUNNEL.snapshot()
    if RUNTIME["public_url"]:
        return {"base": RUNTIME["public_url"].rstrip("/"), "mode": "configured", "public": True, "tunnel": tunnel}
    if tunnel["status"] == "online" and tunnel["url"]:
        return {"base": tunnel["url"], "mode": tunnel["provider"], "public": True, "verified": tunnel["verified"], "tunnel": tunnel}
    if request is not None:
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        hostname = host.split(":")[0].strip("[]")
        scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
        if hostname and hostname not in ("127.0.0.1", "localhost", "0.0.0.0", "::1"):
            private = is_private_host(hostname)
            return {"base": f"{scheme}://{host}", "mode": "lan" if private else "direct", "public": not private, "tunnel": tunnel}
    return {"base": f"http://{lan_ip()}:{RUNTIME['port']}", "mode": "lan", "public": False, "tunnel": tunnel}


def base_url(request: Optional[Request]) -> str:
    return access_info(request)["base"]


def guest_ctx(code: str, x_participant_token: Optional[str] = Header(default=None)) -> GuestCtx:
    return SESSIONS.context(code, x_participant_token)


def bearer(authorization: Optional[str]) -> Optional[str]:
    return authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else None


def staff_ctx(*roles: str) -> Callable[..., StaffCtx]:
    def dependency(authorization: Optional[str] = Header(default=None)) -> StaffCtx:
        ctx = STAFF.verify(bearer(authorization))
        if not ctx:
            raise ApiError(401, "staff_auth", "Войдите как сотрудник — сессия истекла или не начата")
        if ctx.role != "admin" and ctx.role not in roles:
            raise ApiError(403, "forbidden", "Недостаточно прав: этот раздел для другой роли")
        return ctx

    return dependency


KITCHEN = staff_ctx("kitchen")
KITCHEN_OR_WAITER = staff_ctx("kitchen", "waiter")
WAITER = staff_ctx("waiter")
ADMIN_ONLY = staff_ctx()
ANY_STAFF = staff_ctx("kitchen", "waiter")


def client_ip(scope: dict[str, Any]) -> str:
    peer = (scope.get("client") or ("unknown", 0))[0]
    if peer in ("127.0.0.1", "::1") or str(peer).startswith("::ffff:127."):
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        forwarded = headers.get("cf-connecting-ip") or headers.get("x-forwarded-for", "").split(",")[0].strip() or headers.get("x-real-ip")
        if forwarded:
            return forwarded
    return str(peer)


def sse_response(request: Request, channels: list[str], hello: dict[str, Any],
                 on_open: Optional[Callable[[], None]] = None, on_close: Optional[Callable[[], None]] = None) -> StreamingResponse:
    async def stream() -> AsyncIterator[bytes]:
        listener = BUS.subscribe(channels)
        if on_open:
            on_open()
        try:
            yield ("retry: 3000\ndata: " + jdump({"type": "hello", "data": hello, "ts": iso(now_utc())}) + "\n\n").encode()
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(listener.get(), timeout=settings.sse_heartbeat_seconds)
                    yield f"id: {event['id']}\ndata: {jdump(event)}\n\n".encode()
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
        finally:
            BUS.unsubscribe(channels, listener)
            if on_close:
                on_close()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


def guest_state(ctx: GuestCtx, request: Request, **extra: Any) -> dict[str, Any]:
    return {"ok": True, **extra, "state": SESSIONS.state(ctx.sid, ctx.pid, base_url(request))}
