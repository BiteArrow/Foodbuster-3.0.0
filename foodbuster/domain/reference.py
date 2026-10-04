"""Reference data (allergens, diets, statuses, …) lives in data/*.json, not in code."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from foodbuster.core.errors import ApiError
from foodbuster.core.i18n import t

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load_json(name: str) -> Any:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Allergen:
    code: str
    name: str
    short: str
    icon: str
    synonyms: tuple[str, ...]


_REF = load_json("reference.json")
ALLERGENS: tuple[Allergen, ...] = tuple(
    Allergen(a["code"], a["name"], a["short"], a["icon"], tuple(a["synonyms"])) for a in _REF["allergens"])
ALLERGEN_BY_CODE = {a.code: a for a in ALLERGENS}
ALLERGEN_ORDER = {a.code: i for i, a in enumerate(ALLERGENS)}
ALLERGEN_ALIASES: dict[str, str] = _REF["allergen_name_aliases"]
DIETS: dict[str, dict[str, str]] = {d["code"]: {"name": d["name"], "icon": d["icon"]} for d in _REF["diets"]}
ORDER_STATUS: dict[str, dict[str, Any]] = _REF["order_statuses"]
ORDER_TRANSITIONS = {k: frozenset(v) for k, v in _REF["order_transitions"].items()}
ITEM_TRANSITIONS = {k: frozenset(v) for k, v in _REF["item_transitions"].items()}
WAITER_CALL_REASONS: dict[str, str] = _REF["call_reasons"]
PAYMENT_METHODS: dict[str, dict[str, str]] = _REF["payment_methods"]
AVATARS: tuple[str, ...] = tuple(_REF["avatars"])
PARTICIPANT_COLORS: tuple[str, ...] = tuple(_REF["participant_colors"])
DEMO_NAMES: tuple[str, ...] = tuple(_REF["demo_names"])
MAIN_CATEGORIES = frozenset(_REF["main_categories"])


def can_transition(machine: dict[str, frozenset[str]], current: str, target: str) -> bool:
    return target in machine.get(current, frozenset())


def sort_allergens(codes: Iterable[str]) -> list[str]:
    return sorted({c for c in codes if c in ALLERGEN_BY_CODE}, key=lambda c: ALLERGEN_ORDER[c])


def validate_allergen_codes(codes: Iterable[str]) -> list[str]:
    codes = list(codes)
    unknown = [c for c in codes if c not in ALLERGEN_BY_CODE]
    if unknown:
        raise ApiError(422, "unknown_allergen", "Неизвестный аллерген: " + ", ".join(unknown))
    return sort_allergens(codes)


def validate_diet_codes(codes: Iterable[str], allow_spicy: bool = True) -> list[str]:
    result = []
    for code in codes:
        if code not in DIETS or (code == "spicy" and not allow_spicy):
            raise ApiError(422, "unknown_diet", f"Неизвестный тип питания: {code}")
        if code not in result:
            result.append(code)
    return result


def localized_reference(locale: str) -> dict[str, Any]:
    return {
        "allergens": [{"code": a.code, "name": t(a.name, locale), "short": t(a.short, locale), "icon": a.icon} for a in ALLERGENS],
        "diets": [{"code": k, "name": t(v["name"], locale), "icon": v["icon"]} for k, v in DIETS.items()],
        "order_statuses": {k: {**v, "label": t(v["label"], locale), "short": t(v["short"], locale)} for k, v in ORDER_STATUS.items()},
        "call_reasons": {k: t(v, locale) for k, v in WAITER_CALL_REASONS.items()},
        "payment_methods": {k: t(v["title"], locale) for k, v in PAYMENT_METHODS.items()},
    }
