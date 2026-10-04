"""SQLite access. FastAPI runs every sync (def) endpoint in a worker thread, so these calls never block the event loop;
async endpoints reach the database only through asyncio.to_thread. Each thread keeps its own connection."""

from __future__ import annotations

import contextlib
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

from settings import settings
from foodbuster.core.logging import log
from foodbuster.core.utils import iso, jdump, now_utc

SCHEMA_VERSION = 3
SCHEMA_SQL = (Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8")


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> dict[str, Any]:
    return {column[0]: row[index] for index, column in enumerate(cursor.description)}


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._local = threading.local()
        self._write_lock = threading.RLock()

    def conn(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=15, isolation_level=None, check_same_thread=False)
            connection.row_factory = _dict_row
            for pragma in ("foreign_keys = ON", "journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 15000"):
                connection.execute(f"PRAGMA {pragma}")
            self._local.connection = connection
            self._local.depth = 0
        return connection

    @contextlib.contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock:
            connection = self.conn()
            depth = getattr(self._local, "depth", 0)
            if depth:
                self._local.depth = depth + 1
                try:
                    yield connection
                finally:
                    self._local.depth = depth
                return
            connection.execute("BEGIN IMMEDIATE")
            self._local.depth = 1
            try:
                yield connection
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            finally:
                self._local.depth = 0

    def one(self, sql: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        return self.conn().execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        return self.conn().execute(sql, params).fetchall()

    def scalar(self, sql: str, params: tuple = (), default: Any = None) -> Any:
        row = self.conn().execute(sql, params).fetchone()
        if not row:
            return default
        value = next(iter(row.values()))
        return default if value is None else value

    def initialize(self) -> None:
        from foodbuster.db.migrations import migrate

        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            probe = sqlite3.connect(self.path)
            try:
                version = probe.execute("PRAGMA user_version").fetchone()[0]
                tables = probe.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
            except sqlite3.DatabaseError:
                version, tables = -1, 1
            finally:
                probe.close()
            if tables and version != SCHEMA_VERSION:
                backup = self.path.with_name(f"{self.path.stem}.v{version}.{int(time.time())}.bak")
                self.path.replace(backup)
                for suffix in ("-wal", "-shm"):
                    stale = Path(str(self.path) + suffix)
                    if stale.exists():
                        stale.unlink()
                log.warning("Database schema v%s replaced with v%s, backup: %s", version, SCHEMA_VERSION, backup.name)
        connection = self.conn()
        connection.executescript(SCHEMA_SQL)
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        migrate(connection)


DB = Database(settings.database_path)


def audit(conn: sqlite3.Connection, actor_type: str, actor: str, action: str, entity: str, entity_id: Any = "",
          session_id: Optional[str] = None, payload: Optional[dict] = None) -> None:
    conn.execute(
        "INSERT INTO audit_log(actor_type, actor, action, entity, entity_id, session_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (actor_type, actor, action, entity, str(entity_id or ""), session_id, jdump(payload or {}), iso(now_utc())),
    )
