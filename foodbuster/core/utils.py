from __future__ import annotations

import json
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from settings import settings

UTC = timezone.utc
LOCAL_TZ = timezone(timedelta(hours=settings.utc_offset_hours))
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def now_utc() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_dt(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def to_local(dt: datetime) -> datetime:
    return dt.astimezone(LOCAL_TZ)


def local_midnight_utc(days_back: int = 0) -> datetime:
    return (to_local(now_utc()).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days_back)).astimezone(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def random_code(length: int = 8) -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))
    return f"{raw[:4]}-{raw[4:]}" if length == 8 else raw


def jdump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def jload(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def normalize_text(value: str) -> str:
    value = (value or "").lower().replace("ё", "е")
    value = re.sub(r"[«»\"'`“”„!?;:()\[\]{}|/\\]+", " ", value)
    return " ".join(value.split())


def clean_text(value: Optional[str], max_length: int) -> str:
    return " ".join((value or "").replace("\x00", "").split())[:max_length]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
