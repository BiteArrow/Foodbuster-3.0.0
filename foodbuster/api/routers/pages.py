"""HTML shell, static files (web/), media and SPA routes."""

from __future__ import annotations

import re

from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse, Response

from settings import settings
from foodbuster.core.errors import ApiError

router = APIRouter()
STATIC_TYPES = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2"}
FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#15231D"/>'
           '<circle cx="32" cy="32" r="16" fill="none" stroke="#FF6B3D" stroke-width="5"/><path d="M26 20v24M38 20v24" stroke="#FFD166" '
           'stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="32" r="4" fill="#fff"/></svg>')


def page() -> Response:
    index = settings.web_dir / "index.html"
    if not index.exists():
        return HTMLResponse("<h1>Foodbuster</h1><p>web/index.html не найден</p>", status_code=500)
    return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-cache"})


@router.get("/static/{path:path}", include_in_schema=False)
def static(path: str) -> Response:
    target = (settings.web_dir / path).resolve()
    if settings.web_dir.resolve() not in target.parents or not target.is_file() or target.suffix not in STATIC_TYPES:
        raise ApiError(404, "static_not_found", "Файл не найден")
    return FileResponse(target, media_type=STATIC_TYPES[target.suffix], headers={"Cache-Control": "no-cache"})


@router.get("/favicon.svg", include_in_schema=False)
@router.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(FAVICON, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/manifest.webmanifest", include_in_schema=False)
def manifest() -> Response:
    body = ('{"name":"Foodbuster","short_name":"Foodbuster","start_url":"/","display":"standalone","background_color":"#F4F1EA",'
            '"theme_color":"#15231D","icons":[{"src":"/favicon.svg","sizes":"any","type":"image/svg+xml"}]}')
    return Response(body, media_type="application/manifest+json")


@router.get("/media/{name}", include_in_schema=False)
def media(name: str) -> Response:
    if not re.fullmatch(r"dish-\d+-[0-9a-f]{10}\.(png|jpg|webp)", name):
        raise ApiError(404, "media_not_found", "Файл не найден")
    path = settings.media_dir / name
    if not path.exists():
        raise ApiError(404, "media_not_found", "Файл не найден")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=604800, immutable"})


@router.get("/", include_in_schema=False)
@router.get("/t/{token}", include_in_schema=False)
@router.get("/g/{code}", include_in_schema=False)
@router.get("/staff", include_in_schema=False)
@router.get("/staff/{view}", include_in_schema=False)
def spa_pages() -> Response:
    return page()


@router.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str) -> Response:
    if full_path.startswith("api/") or "." in full_path.rsplit("/", 1)[-1]:
        raise ApiError(404, "not_found", "Не найдено")
    return page()
