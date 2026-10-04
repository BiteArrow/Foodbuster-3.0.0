"""Split bill: every holder of a line pays an equal share (to the tiyn), service is spread in proportion to the dishes."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from foodbuster.core.money import allocate_proportional, percent_of, split_evenly


def compute_bill(participants: list[dict], items: list[dict], orders: dict[str, dict], payments: list[dict]) -> dict[str, Any]:
    order_index = {p["id"]: i for i, p in enumerate(participants)}
    subtotal: dict[str, int] = {pid: 0 for pid in order_index}
    service: dict[str, int] = {pid: 0 for pid in order_index}
    lines: dict[str, list[dict]] = {pid: [] for pid in order_index}
    per_order: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for item in items:
        owner = item["participant_id"]
        sharers = sorted({p for p in (item.get("shared_with") or []) if p != owner and p in order_index}, key=order_index.get)
        holders = ([owner] if owner in order_index else []) + sharers
        if not holders:
            continue
        for pid, amount in zip(holders, split_evenly(item["line_total"], len(holders))):
            subtotal[pid] += amount
            per_order[item["order_id"]][pid] += amount
            lines[pid].append({
                "item_id": item["id"], "order_id": item["order_id"], "name": item["name"], "emoji": item.get("emoji", ""),
                "qty": item["qty"], "amount": amount, "line_total": item["line_total"], "shared_count": len(holders),
                "owner_id": owner, "status": item.get("status", "queued"),
            })
    for order_id, by_pid in per_order.items():
        pids = list(by_pid.keys())
        weights = [by_pid[p] for p in pids]
        fee = percent_of(sum(weights), orders.get(order_id, {}).get("service_percent") or 0)
        for pid, amount in zip(pids, allocate_proportional(fee, weights)):
            service[pid] += amount
    paid: dict[str, int] = defaultdict(int)
    pending: dict[str, int] = defaultdict(int)
    for payment in payments:
        sign = -1 if payment.get("kind") == "refund" else 1
        for pid, amount in (payment.get("allocations") or {}).items():
            if payment["status"] == "paid":
                paid[pid] += sign * amount
            elif payment["status"] in ("pending", "awaiting_cash") and sign > 0:
                pending[pid] += amount
    rows = []
    for p in participants:
        pid = p["id"]
        total = subtotal[pid] + service[pid]
        paid_amount = paid[pid]
        pending_amount = pending[pid]
        due = max(0, total - paid_amount - pending_amount)
        overpaid = max(0, paid_amount - total)
        if total == 0 and paid_amount == 0:
            state = "empty"
        elif paid_amount >= total:
            state = "paid"
        elif due == 0 and pending_amount > 0:
            state = "pending"
        elif paid_amount > 0:
            state = "partial"
        else:
            state = "unpaid"
        rows.append({
            "participant_id": pid, "subtotal": subtotal[pid], "service": service[pid], "total": total,
            "paid": paid_amount, "pending": pending_amount, "due": due, "overpaid": overpaid, "status": state,
            "lines": lines[pid],
        })
    grand = sum(r["total"] for r in rows)
    return {
        "items_total": sum(subtotal.values()),
        "service_total": sum(service.values()),
        "grand_total": grand,
        "paid_total": sum(max(0, r["paid"]) for r in rows),
        "pending_total": sum(r["pending"] for r in rows),
        "due_total": sum(r["due"] for r in rows),
        "overpaid_total": sum(r["overpaid"] for r in rows),
        "participants": rows,
    }
