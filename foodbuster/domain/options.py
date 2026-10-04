"""Modifiers: building option groups from data templates, removable ingredients and live КБЖУ recalculation."""

from __future__ import annotations

from typing import Any, Optional

from foodbuster.core.errors import ApiError
from foodbuster.core.money import scale, tiyn
from foodbuster.core.utils import normalize_text
from foodbuster.domain.reference import load_json

TEMPLATES: dict[str, Any] = {k: v for k, v in load_json("option_templates.json").items() if not k.startswith("_")}
REMOVABLE: dict[str, Any] = load_json("removable_ingredients.json")
NUTRIENTS = ("kcal", "protein", "fat", "carbs", "weight_g")
NO_REMOVALS = {"desserts", "drinks", "coffee"}
MAX_REMOVAL_SHARE = 0.35


def _num(key: str, value: float) -> float | int:
    return int(round(value)) if key in ("kcal", "weight_g") else round(value, 1)


def build_choice(raw: dict[str, Any], dish: dict[str, Any]) -> dict[str, Any]:
    if "price_factor" in raw:
        price = scale(dish["price"], str(raw["price_factor"]))
    else:
        price = tiyn(int(raw.get("price", 0)))
    values = {k: float(raw.get(k, 0)) for k in NUTRIENTS}
    for key, factor in (raw.get("scale") or {}).items():
        values[key] += float(dish.get(key) or 0) * factor
    return {"id": raw["id"], "name": raw["name"], "price": price, **{k: _num(k, v) for k, v in values.items()},
            "add_allergens": list(raw.get("add_allergens", [])), "remove_allergens": list(raw.get("remove_allergens", [])),
            "add_traces": list(raw.get("add_traces", []))}


def build_template(key: str, dish: dict[str, Any]) -> dict[str, Any]:
    template = TEMPLATES.get(key)
    if not template:
        raise ValueError(f"unknown option template {key}")
    return {k: v for k, v in template.items() if k != "choices"} | {"choices": [build_choice(c, dish) for c in template["choices"]]}


def _ingredient_hit(stems: list[str], ingredients: list[str]) -> Optional[str]:
    for ingredient in ingredients:
        text = normalize_text(ingredient)
        words = text.split()
        for stem in stems:
            stem = normalize_text(stem)
            if (" " in stem and stem in text) or any(w.startswith(stem) for w in words):
                return ingredient
    return None


def removal_group(dish: dict[str, Any]) -> Optional[dict[str, Any]]:
    if dish.get("category") in NO_REMOVALS:
        return None
    name = normalize_text(dish["name"])
    choices = []
    group = REMOVABLE["group"]
    for item in REMOVABLE["items"]:
        if any(normalize_text(s) in name for s in item["match"]):
            continue
        ingredients = dish.get("ingredients") or []
        hit = _ingredient_hit(item["match"], ingredients)
        if not hit or hit == ingredients[0]:
            continue
        kcal = abs(item.get("kcal", 0))
        factor = min(1.0, MAX_REMOVAL_SHARE * float(dish.get("kcal") or 0) / kcal) if kcal else 1.0
        raw = {"id": item["id"], "name": item["name"], **{k: item.get(k, 0) * factor for k in NUTRIENTS}}
        choices.append(build_choice(raw, dish))
        if len(choices) >= group["max"]:
            break
    if not choices:
        return None
    return {"id": group["id"], "name": group["name"], "type": "multi", "required": False, "max": len(choices), "choices": choices}


def dish_options(keys: list[str], dish: dict[str, Any]) -> list[dict[str, Any]]:
    groups = [build_template(key, dish) for key in keys if key != "removals"]
    removals = removal_group(dish)
    if removals and not any(g["id"] == removals["id"] for g in groups):
        groups.append(removals)
    return groups


def resolve_choices(item: dict[str, Any], selected: dict[str, list[str]]) -> list[dict[str, Any]]:
    groups = {g["id"]: g for g in item.get("options") or []}
    for group_id in selected:
        if group_id not in groups:
            raise ApiError(422, "unknown_option", "Такой опции у блюда нет — обновите меню")
    chosen: list[dict[str, Any]] = []
    for group in item.get("options") or []:
        ids = list(dict.fromkeys(selected.get(group["id"]) or []))
        by_id = {c["id"]: c for c in group["choices"]}
        if any(cid not in by_id for cid in ids):
            raise ApiError(422, "unknown_choice", f"Неизвестный вариант в «{group['name']}»")
        if group["type"] == "single":
            if len(ids) > 1:
                raise ApiError(422, "single_choice", f"В «{group['name']}» можно выбрать только один вариант")
            if not ids and group.get("required"):
                ids = [group["choices"][0]["id"]]
        elif len(ids) > int(group.get("max") or len(group["choices"])):
            raise ApiError(422, "too_many_choices", f"В «{group['name']}» можно выбрать не больше {group.get('max')}")
        for cid in ids:
            chosen.append({"group_id": group["id"], "group": group["name"], **by_id[cid]})
    return chosen


def default_choices(options: list[dict]) -> list[dict]:
    return [{"group_id": g["id"], "group": g["name"], **g["choices"][0]} for g in options if g.get("required") and g.get("choices")]


def totals(item: dict[str, Any], chosen: list[dict[str, Any]]) -> dict[str, Any]:
    """Price and nutrition of one portion after modifiers; removed ingredients subtract on the fly."""
    result: dict[str, Any] = {"price": item["price"] + sum(c.get("price", 0) for c in chosen)}
    for key in NUTRIENTS:
        value = float(item.get(key) or 0) + sum(float(c.get(key) or 0) for c in chosen)
        result[key] = _num(key, max(0.0, value))
    return result
