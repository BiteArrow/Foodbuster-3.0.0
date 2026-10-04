"""Server-sent events bus and live presence (who is online and what they are looking at)."""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from collections import defaultdict, deque
from typing import Any, Iterable, Optional

from settings import settings
from foodbuster.core.utils import iso, now_utc


class EventBus:
    def __init__(self) -> None:
        self._channels: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._lock = threading.Lock()
        self._sequence = 0
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.recent: deque[dict[str, Any]] = deque(maxlen=80)

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def subscribe(self, channels: Iterable[str]) -> asyncio.Queue:
        queue_: asyncio.Queue = asyncio.Queue(maxsize=256)
        with self._lock:
            for channel in channels:
                self._channels[channel].add(queue_)
        return queue_

    def unsubscribe(self, channels: Iterable[str], queue_: asyncio.Queue) -> None:
        with self._lock:
            for channel in channels:
                listeners = self._channels.get(channel)
                if listeners is not None:
                    listeners.discard(queue_)
                    if not listeners:
                        self._channels.pop(channel, None)

    def listener_count(self, channel: str) -> int:
        with self._lock:
            return len(self._channels.get(channel, ()))

    def publish(self, channel: str, event_type: str, data: Optional[dict] = None) -> dict[str, Any]:
        with self._lock:
            self._sequence += 1
            event = {"id": self._sequence, "type": event_type, "channel": channel, "data": data or {}, "ts": iso(now_utc())}
            queues = list(self._channels.get(channel, ()))
        if channel.startswith("staff:"):
            self.recent.appendleft(event)
        loop = self.loop
        if not queues or loop is None or loop.is_closed():
            return event

        def deliver() -> None:
            for target in queues:
                try:
                    target.put_nowait(event)
                except asyncio.QueueFull:
                    with contextlib.suppress(asyncio.QueueEmpty):
                        target.get_nowait()
                    with contextlib.suppress(asyncio.QueueFull):
                        target.put_nowait(event)

        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            deliver()
        else:
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(deliver)
        return event


class PresenceHub:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
        self._lock = threading.Lock()

    def _entry(self, session_id: str, participant_id: str) -> dict[str, Any]:
        return self._data[session_id].setdefault(participant_id, {"connections": 0, "seen": 0.0, "viewing": None})

    def connect(self, session_id: str, participant_id: str) -> None:
        with self._lock:
            entry = self._entry(session_id, participant_id)
            entry["connections"] += 1
            entry["seen"] = time.time()

    def disconnect(self, session_id: str, participant_id: str) -> None:
        with self._lock:
            entry = self._entry(session_id, participant_id)
            entry["connections"] = max(0, entry["connections"] - 1)
            entry["seen"] = time.time()
            if entry["connections"] == 0:
                entry["viewing"] = None

    def touch(self, session_id: str, participant_id: str, viewing: Optional[dict] = None, update_viewing: bool = False) -> None:
        with self._lock:
            entry = self._entry(session_id, participant_id)
            entry["seen"] = time.time()
            if update_viewing:
                entry["viewing"] = viewing

    def is_online(self, session_id: str, participant_id: str) -> bool:
        with self._lock:
            entry = self._data.get(session_id, {}).get(participant_id)
            return bool(entry and (entry["connections"] > 0 or time.time() - entry["seen"] < settings.presence_offline_seconds))

    def snapshot(self, session_id: str) -> dict[str, dict[str, Any]]:
        now = time.time()
        with self._lock:
            result = {}
            for pid, entry in self._data.get(session_id, {}).items():
                online = entry["connections"] > 0 or now - entry["seen"] < settings.presence_offline_seconds
                result[pid] = {"online": online, "viewing": entry["viewing"] if online else None}
            return result

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def forget(self, session_id: str) -> None:
        with self._lock:
            self._data.pop(session_id, None)
