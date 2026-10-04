"""Money is always an integer number of tiyn (1 ₸ = 100 tiyn). Floats are rejected on purpose."""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

_AMOUNT = re.compile(r"^\s*(-?)(\d{1,9})(?:[.,](\d{1,2}))?\s*$")


def tiyn(tenge: int | Decimal | str) -> int:
    """Converts a tenge amount given as int, Decimal or text ("1234,50") to tiyn."""
    if isinstance(tenge, bool) or isinstance(tenge, float):
        raise TypeError("money must not be a float — pass int tiyn, Decimal or a string")
    if isinstance(tenge, int):
        return tenge * 100
    if isinstance(tenge, Decimal):
        return int((tenge * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    match = _AMOUNT.match(str(tenge))
    if not match:
        raise ValueError(f"not an amount: {tenge!r}")
    sign, whole, frac = match.groups()
    value = int(whole) * 100 + int((frac or "0").ljust(2, "0"))
    return -value if sign else value


def to_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"not a number: {value!r}") from exc


def round_half_up(value: Decimal) -> int:
    return int(to_decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def percent_of(amount: int, percent: Decimal | int | str) -> int:
    return round_half_up(Decimal(int(amount)) * to_decimal(percent) / Decimal(100))


def scale(amount: int, factor: Decimal | str, step: int = 1000) -> int:
    """amount × factor, rounded to `step` tiyn (1000 tiyn = 10 ₸)."""
    raw = Decimal(int(amount)) * to_decimal(factor) / Decimal(step)
    return round_half_up(raw) * step


def fmt_money(amount_tiyn: int) -> str:
    sign = "−" if amount_tiyn < 0 else ""
    whole, frac = divmod(abs(int(amount_tiyn)), 100)
    grouped = f"{whole:,}".replace(",", " ")
    return f"{sign}{grouped},{frac:02d} ₸" if frac else f"{sign}{grouped} ₸"


def split_evenly(total: int, parts: int) -> list[int]:
    if parts <= 0:
        return []
    base, rem = divmod(int(total), parts)
    return [base + (1 if i < rem else 0) for i in range(parts)]


def allocate_proportional(total: int, weights: list[int]) -> list[int]:
    count = len(weights)
    if count == 0:
        return []
    clean = [max(0, int(w)) for w in weights]
    weight_sum = sum(clean)
    if total == 0:
        return [0] * count
    if weight_sum == 0:
        return split_evenly(total, count)
    shares, remainders = [], []
    for index, weight in enumerate(clean):
        quotient, remainder = divmod(int(total) * weight, weight_sum)
        shares.append(quotient)
        remainders.append((remainder, index))
    leftover = int(total) - sum(shares)
    for _, index in sorted(remainders, key=lambda pair: (-pair[0], pair[1]))[:leftover]:
        shares[index] += 1
    return shares
