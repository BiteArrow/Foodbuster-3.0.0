"""Edge concerns: per-IP rate limits and security headers (strict CSP: scripts only from our own origin)."""

from __future__ import annotations

from typing import Any, Callable

from settings import settings
from foodbuster.api.deps import client_ip
from foodbuster.container import LIMITER
from foodbuster.core.utils import jdump


CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; "
       "base-uri 'self'; form-action 'self'")


class EdgeMiddleware:
    def __init__(self, inner: Any) -> None:
        self.inner = inner

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.inner(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        if path.startswith("/api/") and not path.endswith("/events") and not path.endswith(".svg"):
            ip = client_ip(scope)
            if method == "POST" and path == "/api/staff/login":
                bucket, limit = f"login:{ip}", settings.login_rate_limit_per_minute
            elif method == "POST" and (path.endswith("/join") or path.endswith("/recover") or path == "/api/office"):
                bucket, limit = f"join:{ip}", settings.join_rate_limit_per_minute
            else:
                bucket, limit = f"api:{ip}", settings.rate_limit_per_minute
            if not LIMITER.allow(bucket, limit):
                body = jdump({"error": {"code": "rate_limited", "message": "Слишком много запросов. Подождите минуту и попробуйте снова"}}).encode()
                await send({"type": "http.response.start", "status": 429, "headers": [(b"content-type", b"application/json"), (b"retry-after", b"30")]})
                await send({"type": "http.response.body", "body": body})
                return
        docs = path.startswith("/docs") or path.startswith("/redoc") or path == "/openapi.json"

        async def send_with_headers(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers += [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"strict-origin-when-cross-origin"),
                            (b"x-frame-options", b"SAMEORIGIN"), (b"permissions-policy", b"camera=(), microphone=(), geolocation=()")]
                if not docs:
                    headers.append((b"content-security-policy", CSP.encode()))
                message["headers"] = headers
            await send(message)

        await self.inner(scope, receive, send_with_headers)
