"""Positions of tables on the 2D hall map, in percent of the hall width/height."""

from __future__ import annotations

import math
from typing import Iterable

MAP_SPOTS = tuple((x, y) for y in (24, 50, 76) for x in (14, 32, 50, 68, 86))


def free_map_spot(taken: Iterable[tuple[float, float]]) -> tuple[float, float]:
    taken = list(taken)

    def gap(spot: tuple[float, float]) -> float:
        return min((max(abs(spot[0] - tx) / 12, abs(spot[1] - ty) / 14) for tx, ty in taken), default=9)

    spot = next((s for s in MAP_SPOTS if gap(s) > 1), None)
    return spot or max(((x, y) for y in range(12, 90, 6) for x in range(8, 94, 4)), key=gap)


def grid_layout(count: int) -> list[tuple[float, float]]:
    """Even rows for `count` tables, leaving room for the entrance at the bottom."""
    if count <= 0:
        return []
    cols = max(1, math.ceil(math.sqrt(count * 1.6)))
    rows = math.ceil(count / cols)
    xs = [round(8 + (84 * (c + 0.5) / cols), 1) for c in range(cols)]
    ys = [round(12 + (72 * (r + 0.5) / rows), 1) for r in range(rows)]
    return [(xs[i % cols], ys[i // cols]) for i in range(count)]
