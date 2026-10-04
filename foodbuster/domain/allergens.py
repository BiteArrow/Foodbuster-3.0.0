from __future__ import annotations

from typing import Any, Iterable

from foodbuster.domain.reference import sort_allergens


def effective_allergens(contains: Iterable[str], traces: Iterable[str], choices: Iterable[dict]) -> tuple[list[str], list[str]]:
    contains_set = set(contains)
    traces_set = set(traces)
    for choice in choices:
        contains_set |= set(choice.get("add_allergens") or [])
        contains_set -= set(choice.get("remove_allergens") or [])
        traces_set |= set(choice.get("add_traces") or [])
    traces_set -= contains_set
    return sort_allergens(contains_set), sort_allergens(traces_set)


def allergen_conflicts(contains: Iterable[str], traces: Iterable[str], profile: Iterable[str]) -> dict[str, Any]:
    profile_set = set(profile)
    danger = sort_allergens(set(contains) & profile_set)
    caution = sort_allergens((set(traces) & profile_set) - set(danger))
    if not profile_set:
        level = "none"
    elif danger:
        level = "danger"
    elif caution:
        level = "caution"
    else:
        level = "safe"
    return {"level": level, "danger": danger, "caution": caution}


def diet_allows(item_diets: Iterable[str], required: Iterable[str]) -> bool:
    diets = set(item_diets)
    for need in required:
        if need == "vegan" and "vegan" not in diets:
            return False
        if need == "vegetarian" and not diets & {"vegetarian", "vegan"}:
            return False
        if need == "halal" and not diets & {"halal", "vegetarian", "vegan"}:
            return False
        if need == "spicy" and "spicy" not in diets:
            return False
    return True
