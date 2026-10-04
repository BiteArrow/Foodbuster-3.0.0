"""Application factory, lifespan (bootstrap, scheduler, public tunnel) and the command-line entry point."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import inspect
import socket
import sys
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from settings import settings
from foodbuster.api.deps import lan_ip
from foodbuster.api.middleware import EdgeMiddleware
from foodbuster.api.routers import admin, guest, pages, public, staff
from foodbuster.container import BUS, MAINTENANCE, RUNTIME, TUNNEL, bootstrap
from foodbuster.core.errors import ApiError, describe_validation
from foodbuster.core.logging import log
from foodbuster.services.tunnel import safe_print


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    BUS.attach(asyncio.get_running_loop())
    await asyncio.to_thread(bootstrap)
    if RUNTIME["tunnel_mode"] != "off" and (not RUNTIME["public_url"] or settings.tunnel.cloudflare_token):
        TUNNEL.mode = RUNTIME["tunnel_mode"]
        TUNNEL.public_url = RUNTIME["public_url"]
        TUNNEL.start(RUNTIME["port"])
    scheduler = asyncio.create_task(scheduler_loop())
    try:
        yield
    finally:
        scheduler.cancel()
        TUNNEL.stop()


async def scheduler_loop() -> None:
    while True:
        await asyncio.sleep(settings.scheduler_interval_seconds)
        try:
            await asyncio.to_thread(MAINTENANCE.run_once)
        except Exception:
            log.exception("Maintenance run failed")


def create_app() -> FastAPI:
    app = FastAPI(title=f"{settings.app_name} API", version=settings.app_version, lifespan=lifespan,
                  description="Единый цифровой слой между гостем, компанией, официантом, кухней и администрацией ресторана.")
    app.add_middleware(GZipMiddleware, minimum_size=1200)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["*"])
    app.add_middleware(EdgeMiddleware)

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        message, details = describe_validation(exc.errors())
        return JSONResponse(status_code=422, content={"error": {"code": "validation", "message": message, "details": details}})

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        text = {404: "Не найдено", 405: "Метод не поддерживается"}.get(exc.status_code, str(exc.detail))
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": f"http_{exc.status_code}", "message": text}})

    @app.exception_handler(Exception)
    async def unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error: %s", exc)
        return JSONResponse(status_code=500, content={"error": {"code": "internal",
                                                                "message": "Внутренняя ошибка сервера. Мы записали её в журнал — попробуйте ещё раз"}})

    for module in (public, guest, staff, admin, pages):
        app.include_router(module.router)
    return app


app = create_app()


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("0.0.0.0" if host in ("0.0.0.0", "") else host, port))
            return True
        except OSError:
            return False


def run() -> None:
    parser = argparse.ArgumentParser(description="Foodbuster — общий заказ в ресторане и офисе по одному QR, без приложения")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--tunnel", choices=["auto", "cloudflared", "serveo", "ssh", "named", "off"], default=None, help="публичный туннель для QR")
    parser.add_argument("--no-tunnel", action="store_true", help="не поднимать публичный туннель")
    parser.add_argument("--public-url", default=None, help="готовый публичный адрес, например https://foodbuster.kz")
    parser.add_argument("--reset", action="store_true", help="удалить базу и заново создать демо-данные")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.reconfigure(errors="replace")
    if args.reset:
        for suffix in ("", "-wal", "-shm"):
            with contextlib.suppress(FileNotFoundError):
                Path(str(settings.database_path) + suffix).unlink()
        safe_print("  База удалена — демо-данные будут созданы заново")
    port = args.port
    while not port_is_free(args.host, port) and port < args.port + 20:
        port += 1
    if port != args.port:
        safe_print(f"  Порт {args.port} занят — запускаю на {port}")
    RUNTIME["port"] = port
    RUNTIME["public_url"] = (args.public_url or settings.public_url or "").rstrip("/")
    RUNTIME["tunnel_mode"] = "off" if args.no_tunnel else (args.tunnel or settings.tunnel.mode)
    line = "─" * 64
    safe_print(f"\n{line}\n  {settings.app_name} {settings.app_version} · {settings.restaurant_name}, {settings.restaurant_city}\n{line}")
    safe_print(f"  На этом компьютере:  http://127.0.0.1:{port}")
    safe_print(f"  В локальной сети:    http://{lan_ip()}:{port}")
    if RUNTIME["public_url"]:
        safe_print(f"  Публичный адрес:     {RUNTIME['public_url']}")
    elif RUNTIME["tunnel_mode"] != "off":
        safe_print("  Публичный адрес:     поднимаю туннель, ссылка появится ниже через 5–20 секунд…")
    safe_print("  Персонал:            /staff — логины и пароли в settings.py")
    safe_print(f"  API-документация:    http://127.0.0.1:{port}/docs\n{line}\n")
    options: dict[str, Any] = {"host": args.host, "port": port, "log_level": "warning", "access_log": False, "proxy_headers": True,
                               "forwarded_allow_ips": "*", "timeout_keep_alive": 30}
    if "timeout_graceful_shutdown" in inspect.signature(uvicorn.Config.__init__).parameters:
        options["timeout_graceful_shutdown"] = 2
    uvicorn.run(app, **options)
