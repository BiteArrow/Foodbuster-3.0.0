"""Staff accounts: login + password (scrypt), signed bearer tokens that die when the password changes."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Optional

from settings import settings
from foodbuster.core.errors import ApiError
from foodbuster.core.security import hash_password, read_signed, sign_payload, verify_password
from foodbuster.core.utils import clean_text, iso, now_utc
from foodbuster.db.database import Database, audit
from foodbuster.services.context import StaffCtx

ROLE_TITLES = {"admin": "Администратор", "kitchen": "Кухня", "waiter": "Официант"}
_DUMMY_HASH = hash_password(secrets.token_urlsafe(12))


class StaffService:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._cache: dict[int, tuple[float, dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def _user(self, user_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            hit = self._cache.get(user_id)
            if hit and time.monotonic() - hit[0] < 15:
                return hit[1]
        row = self.db.one("SELECT * FROM staff_users WHERE id=?", (user_id,))
        with self._lock:
            self._cache[user_id] = (time.monotonic(), row)
        return row

    def _forget(self, user_id: int) -> None:
        with self._lock:
            self._cache.pop(user_id, None)

    def login(self, username: str, password: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM staff_users WHERE username=? AND is_active=1", (clean_text(username, 40),))
        if not row:
            verify_password(password, _DUMMY_HASH)
            raise ApiError(401, "login_invalid", "Неверный логин или пароль")
        if not verify_password(password, row["password_hash"]):
            raise ApiError(401, "login_invalid", "Неверный логин или пароль")
        with self.db.tx() as conn:
            conn.execute("UPDATE staff_users SET last_login_at=? WHERE id=?", (iso(now_utc()), row["id"]))
            audit(conn, "staff", row["username"], "login", "staff", row["id"])
        ttl = settings.staff_token_ttl_hours * 3600
        token = sign_payload({"u": row["id"], "r": row["role"], "v": row["token_version"], "exp": int(time.time()) + ttl, "n": secrets.token_hex(4)})
        return {"token": token, "role": row["role"], "username": row["username"], "display_name": row["display_name"], "expires_in": ttl}

    def verify(self, token: Optional[str]) -> Optional[StaffCtx]:
        payload = read_signed(token)
        if not payload or not isinstance(payload.get("u"), int):
            return None
        row = self._user(payload["u"])
        if not row or not row["is_active"] or row["token_version"] != payload.get("v") or row["role"] != payload.get("r"):
            return None
        return StaffCtx(row["role"], row["username"], row["id"])

    def accounts(self) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT id, username, role, display_name, is_active, last_login_at, updated_at FROM staff_users ORDER BY id")
        return [{**r, "is_active": bool(r["is_active"]), "role_title": ROLE_TITLES.get(r["role"], r["role"])} for r in rows]

    def set_password(self, user_id: int, new_password: str, actor: StaffCtx, current: Optional[str] = None) -> None:
        if len(new_password) < settings.password_min_length or new_password.isdigit() or new_password.isalpha():
            raise ApiError(422, "password_weak", f"Пароль — от {settings.password_min_length} символов, буквы и цифры")
        row = self.db.one("SELECT * FROM staff_users WHERE id=?", (user_id,))
        if not row:
            raise ApiError(404, "staff_not_found", "Сотрудник не найден")
        if current is not None and not verify_password(current, row["password_hash"]):
            raise ApiError(403, "password_wrong", "Текущий пароль указан неверно")
        with self.db.tx() as conn:
            conn.execute("UPDATE staff_users SET password_hash=?, token_version=token_version+1, updated_at=? WHERE id=?",
                         (hash_password(new_password), iso(now_utc()), user_id))
            audit(conn, "staff", actor.actor, "password_changed", "staff", user_id, payload={"username": row["username"]})
        self._forget(user_id)
