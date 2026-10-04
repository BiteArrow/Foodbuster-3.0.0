from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

from settings import Settings, settings
from foodbuster.core.utils import clamp
from foodbuster.domain.allergens import diet_allows
from foodbuster.domain.reference import MAIN_CATEGORIES


def compute_eta_minutes(cook_minutes: list[int], orders_ahead: int, cfg: Settings = settings) -> int:
    base = max(cook_minutes) if cook_minutes else cfg.eta_min_minutes
    volume = max(0, len(cook_minutes) - 4) // 4
    queue_penalty = min(cfg.eta_queue_penalty_cap, max(0, orders_ahead) * cfg.eta_queue_penalty_minutes)
    return int(clamp(base + volume + queue_penalty, cfg.eta_min_minutes, cfg.eta_max_minutes))


def recommend_items(menu: list[dict], cart_ids: list[int], pair_counts: dict[int, Counter], item_counts: Counter,
                    profile: Iterable[str], diets: Iterable[str], hour: int, limit: int = 6) -> list[dict[str, Any]]:
    by_id = {m["id"]: m for m in menu}
    in_cart = [i for i in cart_ids if i in by_id]
    cart_cats = {by_id[i]["category_code"] for i in in_cart}
    profile_set = set(profile)
    diet_list = list(diets)
    peak = max(item_counts.values()) if item_counts else 1
    scored = []
    for item in menu:
        if not item["available"] or item["id"] in in_cart:
            continue
        if profile_set & set(item["allergens"]):
            continue
        if diet_list and not diet_allows(item["diets"], diet_list):
            continue
        cat = item["category_code"]
        best_pair, best_from = 0.0, None
        for source in in_cart:
            base_count = item_counts.get(source, 0)
            if base_count:
                prob = pair_counts.get(source, Counter()).get(item["id"], 0) / base_count
                if prob > best_pair:
                    best_pair, best_from = prob, source
        score = best_pair * 2.2 + (item_counts.get(item["id"], 0) / peak) * 0.35 + (0.12 if item.get("popular") else 0)
        reason = None
        if best_from is not None and best_pair >= 0.06:
            reason = f"Часто берут вместе с «{by_id[best_from]['name']}»"
        if in_cart:
            if not cart_cats & {"drinks", "coffee"} and cat in {"drinks", "coffee"}:
                score += 0.45
                reason = reason or "Не хватает напитка"
            if cart_cats & MAIN_CATEGORIES and "desserts" not in cart_cats and cat == "desserts":
                score += 0.3
                reason = reason or "На десерт"
            if cart_cats & MAIN_CATEGORIES and not cart_cats & {"salads", "soups"} and cat in {"salads", "soups"}:
                score += 0.18
                reason = reason or "Лёгкое начало к основному"
            if cat in cart_cats and cat not in {"drinks", "coffee"}:
                score -= 0.25
        else:
            slot = {"breakfast", "coffee"} if 6 <= hour < 11 else ({"national", "soups", "bowls"} if 11 <= hour < 17 else {"grill", "hot", "national"})
            if cat in slot:
                score += 0.3
                reason = reason or "Популярно в это время"
        scored.append((score, item["id"], reason or ("Хит у гостей" if item.get("popular") else "Стоит попробовать")))
    scored.sort(key=lambda s: (-s[0], s[1]))
    result, per_cat = [], Counter()
    for score, item_id, reason in scored:
        cat = by_id[item_id]["category_code"]
        if per_cat[cat] >= 2:
            continue
        per_cat[cat] += 1
        result.append({"id": item_id, "reason": reason, "score": round(score, 3)})
        if len(result) >= limit:
            break
    return result
