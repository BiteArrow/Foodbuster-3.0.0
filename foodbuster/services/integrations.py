from __future__ import annotations

import contextlib
import hashlib
import hmac
import queue
import threading
import urllib.request
from typing import Any

from settings import settings
from foodbuster.core.logging import log
from foodbuster.core.utils import iso, jdump, new_id, now_utc


class IntegrationHub:
    """Outbound webhooks for POS / KDS / printers / push gateways."""

    def __init__(self, urls: tuple[str, ...], secret: str) -> None:
        self.urls = urls
        self.secret = secret.encode("utf-8")
        self._queue: "queue.Queue[dict]" = queue.Queue(maxsize=1000)
        self.delivered = 0
        self.failed = 0
        if urls:
            threading.Thread(target=self._worker, name="foodbuster-webhooks", daemon=True).start()

    def emit(self, event_type: str, payload: dict[str, Any]) -> None:
        if not self.urls:
            return
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait({"type": event_type, "payload": payload, "ts": iso(now_utc()), "id": new_id("evt")})

    def _worker(self) -> None:
        while True:
            event = self._queue.get()
            body = jdump(event).encode("utf-8")
            signature = hmac.new(self.secret, body, hashlib.sha256).hexdigest()
            for url in self.urls:
                request = urllib.request.Request(url, data=body, method="POST", headers={
                    "Content-Type": "application/json", "X-Foodbuster-Signature": signature, "X-Foodbuster-Event": event["type"]})
                try:
                    with urllib.request.urlopen(request, timeout=settings.webhook_timeout_seconds):
                        self.delivered += 1
                except Exception as exc:
                    self.failed += 1
                    log.warning("Webhook %s failed: %s", url, exc)
