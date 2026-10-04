"""Admin endpoints: menu, categories, tables & QR, analytics, staff accounts, settings."""

from __future__ import annotations

import platform
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from settings import settings
from foodbuster.api.deps import ADMIN_ONLY, KITCHEN, access_info, base_url
from foodbuster.api.schemas import (AvailabilityIn, BulkTablesIn, CategoryIn, ImageIn, LayoutIn, MenuItemIn, PasswordIn, ReorderIn, ResetIn,
                                    RestaurantIn, TableIn)
from foodbuster.container import ADMIN, ANALYTICS, BUS, HUB, MAINTENANCE, MENU, RUNTIME, STAFF, reset_demo
from foodbuster.services.context import StaffCtx

router = APIRouter()


@router.get("/api/admin/menu", tags=["admin"])
def admin_menu(_: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"items": MENU.items(include_archived=True), "categories": MENU.categories(include_inactive=True)}


@router.post("/api/admin/menu", tags=["admin"])
def admin_create_dish(payload: MenuItemIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.save_item(payload.model_dump(), ctx)}


@router.put("/api/admin/menu/{item_id}", tags=["admin"])
def admin_update_dish(item_id: int, payload: MenuItemIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.save_item(payload.model_dump(), ctx, item_id)}


@router.patch("/api/admin/menu/{item_id}/availability", tags=["admin"])
def admin_availability(item_id: int, payload: AvailabilityIn, ctx: StaffCtx = Depends(KITCHEN)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.set_availability(item_id, payload.available, ctx)}


@router.post("/api/admin/menu/{item_id}/restore", tags=["admin"])
def admin_restore(item_id: int, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.restore_item(item_id, ctx)}


@router.delete("/api/admin/menu/{item_id}", tags=["admin"])
def admin_delete(item_id: int, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, **ADMIN.delete_item(item_id, ctx)}


@router.put("/api/admin/menu/{item_id}/image", tags=["admin"])
def admin_image(item_id: int, payload: ImageIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.set_image(item_id, payload.data_url, ctx)}


@router.delete("/api/admin/menu/{item_id}/image", tags=["admin"])
def admin_image_remove(item_id: int, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.remove_image(item_id, ctx)}


@router.get("/api/admin/categories", tags=["admin"])
def admin_categories(_: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"items": MENU.categories(include_inactive=True)}


@router.post("/api/admin/categories", tags=["admin"])
def admin_category_create(payload: CategoryIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.save_category(payload.model_dump(), ctx)}


@router.post("/api/admin/categories/reorder", tags=["admin"])
def admin_category_reorder(payload: ReorderIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.reorder_categories(payload.ids, ctx)
    return {"ok": True, "items": MENU.categories(include_inactive=True)}


@router.put("/api/admin/categories/{category_id}", tags=["admin"])
def admin_category_update(category_id: int, payload: CategoryIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"ok": True, "item": ADMIN.save_category(payload.model_dump(), ctx, category_id)}


@router.delete("/api/admin/categories/{category_id}", tags=["admin"])
def admin_category_delete(category_id: int, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.delete_category(category_id, ctx)
    return {"ok": True}


@router.get("/api/admin/tables", tags=["admin"])
def admin_tables(request: Request, _: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"items": ADMIN.tables(base_url(request)), "access": access_info(request)}


@router.post("/api/admin/tables", tags=["admin"])
def admin_table_create(payload: TableIn, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.save_table(payload.model_dump(), ctx)
    return {"ok": True, "items": ADMIN.tables(base_url(request))}


@router.post("/api/admin/tables/layout", tags=["admin"])
def admin_table_layout(payload: LayoutIn, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.save_layout([item.model_dump() for item in payload.items], ctx)
    return {"ok": True, "items": ADMIN.tables(base_url(request))}


@router.put("/api/admin/tables/{table_id}", tags=["admin"])
def admin_table_update(table_id: int, payload: TableIn, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.save_table(payload.model_dump(), ctx, table_id)
    return {"ok": True, "items": ADMIN.tables(base_url(request))}


@router.post("/api/admin/tables/{table_id}/rotate", tags=["admin"])
def admin_table_rotate(table_id: int, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.rotate_qr(table_id, ctx)
    return {"ok": True, "items": ADMIN.tables(base_url(request))}


@router.get("/api/admin/analytics", tags=["admin"])
def admin_analytics(days: int = Query(default=7, ge=1, le=90), _: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return ANALYTICS.report(days)


@router.get("/api/admin/restaurant", tags=["admin"])
def admin_restaurant(_: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return ADMIN.restaurant()


@router.put("/api/admin/restaurant", tags=["admin"])
def admin_restaurant_update(payload: RestaurantIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return ADMIN.update_restaurant(payload.model_dump(), ctx)


@router.get("/api/admin/audit", tags=["admin"])
def admin_audit(limit: int = Query(default=60, ge=1, le=500), offset: int = Query(default=0, ge=0), _: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return ADMIN.audit_log(limit, offset)


@router.get("/api/admin/system", tags=["admin"])
def admin_system(request: Request, _: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    size = sum(p.stat().st_size for p in (settings.database_path, Path(f"{settings.database_path}-wal")) if p.exists())
    return {"version": settings.app_version, "python": platform.python_version(), "uptime_s": int(time.time() - RUNTIME["started"]),
            "access": access_info(request), "db_bytes": size, "maintenance_runs": MAINTENANCE.runs,
            "webhooks": {"configured": len(settings.webhook_urls), "delivered": HUB.delivered, "failed": HUB.failed},
            "listeners": {"staff": BUS.listener_count(f"staff:{MENU.restaurant_id}"), "public": BUS.listener_count("public")}}


@router.post("/api/admin/demo/reset", tags=["admin"])
def admin_reset(payload: ResetIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    reset_demo(payload.full, ctx)
    return {"ok": True}


@router.post("/api/admin/tables/bulk", tags=["admin"])
def admin_tables_bulk(payload: BulkTablesIn, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    created = ADMIN.bulk_create_tables(payload.count, payload.seats, payload.zone, payload.prefix, ctx)
    return {"ok": True, "created": created, "items": ADMIN.tables(base_url(request))}


@router.post("/api/admin/tables/auto-layout", tags=["admin"])
def admin_tables_auto(request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    ADMIN.auto_layout(ctx)
    return {"ok": True, "items": ADMIN.tables(base_url(request))}


@router.delete("/api/admin/tables/{table_id}", tags=["admin"])
def admin_table_delete(table_id: int, request: Request, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    mode = ADMIN.delete_table(table_id, ctx)
    return {"ok": True, "mode": mode, "items": ADMIN.tables(base_url(request))}


@router.get("/api/admin/staff", tags=["admin"])
def admin_staff(_: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    return {"items": STAFF.accounts(), "min_length": settings.password_min_length}


@router.post("/api/admin/staff/{user_id}/password", tags=["admin"])
def admin_staff_password(user_id: int, payload: PasswordIn, ctx: StaffCtx = Depends(ADMIN_ONLY)) -> dict[str, Any]:
    STAFF.set_password(user_id, payload.new_password, ctx)
    return {"ok": True}
