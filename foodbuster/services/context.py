from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class GuestCtx:
    participant: dict[str, Any]
    session: dict[str, Any]

    @property
    def pid(self) -> str:
        return self.participant["id"]

    @property
    def sid(self) -> str:
        return self.session["id"]


@dataclass
class StaffCtx:
    role: str
    username: str = ""
    user_id: Optional[int] = None

    @property
    def actor(self) -> str:
        return self.username or self.role
