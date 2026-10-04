"""Foodbuster configuration. Any value can be overridden with FOODBUSTER_* environment variables or a .env file."""

from __future__ import annotations

import os
import secrets
import shutil
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"


def _raw(name: str) -> str | None:
    for prefix in ("FOODBUSTER_", "TABLEOS_"):
        value = os.getenv(prefix + name)
        if value is not None and value.strip() != "":
            return value.strip()
    return None


def _env_str(name: str, default: str) -> str:
    value = _raw(name)
    return value if value is not None else default


def _env_int(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        value = int(_raw(name) or default)
    except ValueError:
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _env_decimal(name: str, default: str) -> Decimal:
    try:
        return Decimal(_raw(name) or default)
    except ArithmeticError:
        return Decimal(default)


def _env_bool(name: str, default: bool) -> bool:
    raw = _raw(name)
    return default if raw is None else raw.lower() in {"1", "true", "yes", "on", "да"}


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = _raw(name)
    return list(default) if raw is None else [part.strip() for part in raw.split(",") if part.strip()]


def _data_dir() -> Path:
    explicit = _raw("DATA_DIR")
    if explicit:
        return Path(explicit)
    target, legacy = BASE_DIR / ".foodbuster", BASE_DIR / ".tableos"
    if legacy.exists() and not target.exists():
        try:
            legacy.rename(target)
        except OSError:
            shutil.copytree(legacy, target, dirs_exist_ok=True)
    return target


DATA_DIR = _data_dir()


def _persistent_secret() -> str:
    explicit = _raw("SECRET_KEY")
    if explicit:
        return explicit
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret_file = DATA_DIR / "secret.key"
    if secret_file.exists():
        stored = secret_file.read_text(encoding="utf-8").strip()
        if len(stored) >= 32:
            return stored
    generated = secrets.token_urlsafe(48)
    secret_file.write_text(generated, encoding="utf-8")
    return generated


@dataclass(frozen=True)
class StaffAccount:
    username: str
    password: str
    role: str
    display_name: str


# Initial staff accounts. They are hashed into the database on the first start;
# after that passwords are changed in the admin panel (Настройки → Сотрудники).
DEFAULT_STAFF = (
    StaffAccount(_env_str("ADMIN_LOGIN", "fb_admin_27"), _env_str("ADMIN_PASSWORD", "Hj4dSaY4mRp"), "admin", "Администратор"),
    StaffAccount(_env_str("KITCHEN_LOGIN", "fb_kitchen_41"), _env_str("KITCHEN_PASSWORD", "D6dbgWnCvYQ"), "kitchen", "Кухня"),
    StaffAccount(_env_str("WAITER_LOGIN", "fb_waiter_63"), _env_str("WAITER_PASSWORD", "8BEwyJxMTag"), "waiter", "Официант"),
)


@dataclass(frozen=True)
class TunnelConfig:
    mode: str
    auto_download_cloudflared: bool
    cloudflared_path: str
    cloudflare_token: str
    startup_timeout_seconds: int
    ssh_hosts: tuple[str, ...]
    subdomain: str


@dataclass(frozen=True)
class Settings:
    app_name: str = "Foodbuster"
    app_tagline: str = "Общий стол без хаоса"
    app_version: str = "3.0.0"
    environment: str = "demo"

    host: str = "0.0.0.0"
    port: int = 8097
    public_url: str = ""
    log_level: str = "info"
    cors_origins: tuple[str, ...] = ("*",)

    data_dir: Path = DATA_DIR
    database_path: Path = DATA_DIR / "foodbuster.sqlite3"
    media_dir: Path = DATA_DIR / "media"
    web_dir: Path = WEB_DIR

    secret_key: str = ""
    staff_accounts: tuple[StaffAccount, ...] = DEFAULT_STAFF
    staff_token_ttl_hours: int = 12
    password_min_length: int = 8
    tunnel: TunnelConfig = field(default_factory=lambda: TunnelConfig("auto", True, "", "", 35, ("nokey@localhost.run",), "foodbuster"))

    restaurant_slug: str = "dastarkhan-almaty"
    restaurant_name: str = "Dastarkhan"
    restaurant_city: str = "Алматы"
    currency: str = "KZT"
    currency_symbol: str = "₸"
    locale: str = "ru"
    supported_locales: tuple[str, ...] = ("ru", "kk", "en")
    utc_offset_hours: int = 5
    timezone_name: str = "Asia/Almaty"

    service_fee_percent: Decimal = Decimal("10")
    office_service_fee_percent: Decimal = Decimal("0")
    tip_presets: tuple[int, ...] = (0, 5, 10, 15)
    max_tip_percent: int = 50

    max_tables: int = 100
    max_participants: int = 30
    max_cart_lines_per_participant: int = 60
    max_qty_per_line: int = 30
    max_name_length: int = 24
    max_note_length: int = 200
    max_image_bytes: int = 3 * 1024 * 1024

    session_idle_close_minutes: int = 240
    paid_session_autoclose_minutes: int = 30
    pending_payment_expiry_minutes: int = 15
    office_default_cutoff_minutes: int = 45
    eta_min_minutes: int = 5
    eta_max_minutes: int = 90
    eta_queue_penalty_minutes: int = 2
    eta_queue_penalty_cap: int = 20

    demo_mode: bool = True
    demo_history_days: int = 14
    demo_seed: int = 20261004

    rate_limit_per_minute: int = 400
    join_rate_limit_per_minute: int = 30
    login_rate_limit_per_minute: int = 10

    webhook_urls: tuple[str, ...] = ()
    webhook_timeout_seconds: float = 4.0
    payment_providers: tuple[str, ...] = ("kaspi", "card", "cash")

    sse_heartbeat_seconds: int = 15
    presence_offline_seconds: int = 45
    scheduler_interval_seconds: int = 10


def load_settings() -> Settings:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    legacy_db = DATA_DIR / "tableos.sqlite3"
    database = DATA_DIR / "foodbuster.sqlite3"
    if legacy_db.exists() and not database.exists():
        for suffix in ("", "-wal", "-shm"):
            source = Path(str(legacy_db) + suffix)
            if source.exists():
                source.rename(Path(str(database) + suffix))
    return Settings(
        environment=_env_str("ENV", "demo"),
        host=_env_str("HOST", "0.0.0.0"),
        port=_env_int("PORT", 8097, 1, 65535),
        public_url=_env_str("PUBLIC_URL", "").rstrip("/"),
        log_level=_env_str("LOG_LEVEL", "info").lower(),
        cors_origins=tuple(_env_list("CORS", ["*"])),
        database_path=Path(_env_str("DB", str(database))),
        media_dir=Path(_env_str("MEDIA_DIR", str(DATA_DIR / "media"))),
        secret_key=_persistent_secret(),
        staff_token_ttl_hours=_env_int("STAFF_TOKEN_HOURS", 12, 1, 168),
        tunnel=TunnelConfig(
            mode=_env_str("TUNNEL", "auto").lower(),
            auto_download_cloudflared=_env_bool("TUNNEL_DOWNLOAD", True),
            cloudflared_path=_env_str("CLOUDFLARED", ""),
            cloudflare_token=_env_str("CLOUDFLARE_TUNNEL_TOKEN", ""),
            startup_timeout_seconds=_env_int("TUNNEL_TIMEOUT", 35, 5, 180),
            ssh_hosts=tuple(_env_list("SSH_TUNNEL_HOSTS", ["nokey@localhost.run"])),
            subdomain=_env_str("SUBDOMAIN", "foodbuster"),
        ),
        restaurant_slug=_env_str("RESTAURANT_SLUG", "dastarkhan-almaty"),
        restaurant_name=_env_str("RESTAURANT_NAME", "Dastarkhan"),
        restaurant_city=_env_str("RESTAURANT_CITY", "Алматы"),
        locale=_env_str("LOCALE", "ru"),
        utc_offset_hours=_env_int("UTC_OFFSET", 5, -12, 14),
        timezone_name=_env_str("TIMEZONE", "Asia/Almaty"),
        service_fee_percent=_env_decimal("SERVICE_PERCENT", "10"),
        office_service_fee_percent=_env_decimal("OFFICE_SERVICE_PERCENT", "0"),
        max_tables=_env_int("MAX_TABLES", 100, 1, 500),
        max_participants=_env_int("MAX_PARTICIPANTS", 30, 2, 200),
        demo_mode=_env_bool("DEMO", True),
        demo_history_days=_env_int("DEMO_HISTORY_DAYS", 14, 0, 60),
        rate_limit_per_minute=_env_int("RATE_LIMIT", 400, 30, 100000),
        webhook_urls=tuple(_env_list("WEBHOOKS", [])),
    )


settings = load_settings()
