"""Public endpoints: health, config, menu, search, hall overview and QR images."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from settings import settings
from foodbuster.api.deps import access_info, base_url, sse_response
from foodbuster.container import MENU, SESSIONS, TUNNEL
from foodbuster.core.errors import ApiError
from foodbuster.core.utils import iso, local_midnight_utc, now_utc
from foodbuster.db.database import DB
from foodbuster.domain.qr import qr_svg
from foodbuster.domain.reference import AVATARS, localized_reference

router = APIRouter()


@router.get("/api/health", tags=["system"])
def health() -> dict[str, Any]:
    return {"ok": True, "app": settings.app_name, "version": settings.app_version, "time": iso(now_utc()),
            "dishes": len(MENU.items()), "tunnel": TUNNEL.snapshot()["status"]}


@router.get("/api/config", tags=["public"])
def config(request: Request, locale: str = Query(default="ru", max_length=5)) -> dict[str, Any]:
    restaurant = MENU.restaurant()
    locale = locale if locale in settings.supported_locales else "ru"
    return {
        "app": settings.app_name, "tagline": settings.app_tagline, "version": settings.app_version, "locale": locale,
        "supported_locales": list(settings.supported_locales),
        "restaurant": {"name": restaurant["name"], "city": restaurant["city"], "service_percent": restaurant["service_percent"]},
        "currency": {"code": settings.currency, "symbol": settings.currency_symbol},
        **localized_reference(locale),
        "tip_presets": list(settings.tip_presets), "avatars": list(AVATARS),
        "limits": {"max_participants": settings.max_participants, "max_qty": settings.max_qty_per_line, "max_note": settings.max_note_length,
                   "max_image_mb": settings.max_image_bytes // 1024 // 1024, "max_tables": settings.max_tables},
        "demo": {"enabled": settings.demo_mode},
        "access": access_info(request),
        "features": {"realtime": "sse", "split_bill": True, "shared_items": True, "office_cutoff": True, "modifiers": True,
                     "recommendations": True, "nutrition_search": True, "tips": True, "session_recovery": True, "webhooks": bool(settings.webhook_urls)},
    }


@router.get("/api/menu", tags=["public"])
def public_menu(request: Request) -> Response:
    etag = f'W/"menu-{MENU.revision}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(MENU.public_menu(), headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.get("/api/menu/search", tags=["public"])
def menu_search(q: str = Query(default="", max_length=120)) -> dict[str, Any]:
    return MENU.search(q)


@router.get("/api/public/overview", tags=["public"])
def public_overview(request: Request) -> dict[str, Any]:
    restaurant = MENU.restaurant()
    rid = MENU.restaurant_id
    tables = DB.all("SELECT * FROM dining_tables WHERE restaurant_id=? AND is_active=1 AND is_archived=0 ORDER BY sort, id", (rid,))
    sessions = {s["table_id"]: s for s in DB.all("SELECT * FROM sessions WHERE restaurant_id=? AND status IN ('open','locked') AND table_id IS NOT NULL", (rid,))}
    people: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in DB.all("SELECT p.session_id, p.avatar, p.color FROM participants p JOIN sessions s ON s.id=p.session_id "
                    "WHERE s.restaurant_id=? AND s.status IN ('open','locked') ORDER BY p.joined_at, p.rowid", (rid,)):
        people[p["session_id"]].append(p)
    result = []
    for table in tables:
        session = sessions.get(table["id"])
        guests = people.get(session["id"], []) if session else []
        entry = {"id": table["id"], "label": table["label"], "zone": table["zone"], "seats": table["seats"], "x": table["map_x"], "y": table["map_y"],
                 "guests": len(guests), "mode": SESSIONS.mode_of(session, len(guests)) if session else None,
                 "avatars": [{"avatar": p["avatar"], "color": p["color"]} for p in guests[:6]]}
        if settings.demo_mode:
            entry |= {"join_path": f"/t/{table['qr_token']}", "qr_url": f"/api/tables/{table['qr_token']}/qr.svg"}
        result.append(entry)
    today = iso(local_midnight_utc())
    return {
        "restaurant": {"name": restaurant["name"], "city": restaurant["city"]}, "tables": result, "access": access_info(request),
        "dishes": len(MENU.items()), "demo": settings.demo_mode,
        "today": {"orders": DB.scalar("SELECT count(*) FROM orders WHERE restaurant_id=? AND created_at>=?", (rid, today), 0),
                  "guests_now": sum(len(v) for v in people.values())},
    }


@router.get("/api/public/events", tags=["realtime"])
async def public_events(request: Request) -> StreamingResponse:
    return sse_response(request, ["public"], {"channel": "public"})


def svg_response(svg: str) -> Response:
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})


@router.get("/api/tables/{token}/qr.svg", tags=["qr"])
def table_qr(token: str, request: Request) -> Response:
    table = DB.one("SELECT * FROM dining_tables WHERE qr_token=?", (token,))
    if not table:
        raise ApiError(404, "qr_unknown", "QR-код не найден")
    return svg_response(qr_svg(f"{base_url(request)}/t/{token}"))


@router.get("/api/sessions/{code}/qr.svg", tags=["qr"])
def session_qr(code: str, request: Request) -> Response:
    session = SESSIONS.session_by_code(code)
    if session["table_id"]:
        table = DB.one("SELECT qr_token FROM dining_tables WHERE id=?", (session["table_id"],))
        return svg_response(qr_svg(f"{base_url(request)}/t/{table['qr_token']}"))
    return svg_response(qr_svg(f"{base_url(request)}/g/{session['code']}"))


@router.get("/api/qr.svg", tags=["qr"])
def text_qr(request: Request, text: str = Query(min_length=1, max_length=400)) -> Response:
    allowed = (base_url(request), "https://pay.kaspi.kz/pay/demo")
    if not text.startswith(allowed):
        raise ApiError(422, "qr_text", "QR можно сделать только для ссылок этого сервиса")
    return svg_response(qr_svg(text, logo=not text.startswith("https://pay.kaspi.kz")))
