"""First-run data: the demo restaurant, staff accounts, two weeks of order history and a live company at table 4."""

from __future__ import annotations

import random
import secrets
from collections import defaultdict
from datetime import timedelta
from typing import Any, Iterable

from settings import settings
from foodbuster.core.logging import log
from foodbuster.core.money import percent_of, tiyn
from foodbuster.core.security import hash_password, token_hash
from foodbuster.core.utils import UTC, iso, jdump, jload, new_id, now_utc, random_code, to_local
from foodbuster.db.database import DB, Database, audit
from foodbuster.domain.allergens import effective_allergens
from foodbuster.domain.billing import compute_bill
from foodbuster.domain.options import default_choices, dish_options
from foodbuster.domain.recommend import compute_eta_minutes
from foodbuster.domain.reference import AVATARS, DEMO_NAMES, MAIN_CATEGORIES, PARTICIPANT_COLORS, PAYMENT_METHODS, load_json, sort_allergens
from foodbuster.services.context import StaffCtx

SEED = load_json("menu_seed.json")


def menu_seed_rows(restaurant_id: int, category_ids: dict[str, int], stamp: str) -> list[tuple]:
    rows = []
    for index, d in enumerate(SEED["dishes"]):
        kcal = int(round(4 * d["protein"] + 9 * d["fat"] + 4 * d["carbs"]))
        price = tiyn(int(d["price"]))
        dish = {**d, "price": price, "kcal": kcal}
        rows.append((
            restaurant_id, category_ids[d["category"]], d["name"], d["description"], jdump(d["ingredients"]),
            price, d["weight_g"], kcal, d["protein"], d["fat"], d["carbs"], jdump(sort_allergens(d["allergens"])),
            jdump(sort_allergens(set(d["traces"]) - set(d["allergens"]))), jdump(d["diets"]), jdump(dish_options(d["options"], dish)),
            d["cook_minutes"], d["emoji"], 1 if "popular" in d["flags"] else 0, 1 if "new" in d["flags"] else 0, index, stamp, stamp,
        ))
    return rows


def seed_staff(db: Database) -> None:
    if db.scalar("SELECT count(*) FROM staff_users", default=0):
        return
    stamp = iso(now_utc())
    with db.tx() as conn:
        for account in settings.staff_accounts:
            conn.execute("INSERT INTO staff_users(username, role, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                         (account.username, account.role, account.display_name, hash_password(account.password), stamp, stamp))
        audit(conn, "system", "seed", "staff_seeded", "staff", "", payload={"accounts": len(settings.staff_accounts)})
    log.info("Created %d staff accounts", len(settings.staff_accounts))


def seed_catalog(db: Database) -> int:
    existing = db.one("SELECT id FROM restaurants WHERE slug=?", (settings.restaurant_slug,))
    if existing:
        return existing["id"]
    stamp = iso(now_utc())
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO restaurants(slug, name, city, currency, service_percent, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (settings.restaurant_slug, settings.restaurant_name, settings.restaurant_city, settings.currency, float(settings.service_fee_percent), stamp, stamp),
        )
        restaurant_id = cur.lastrowid
        category_ids = {}
        for sort, category in enumerate(SEED["categories"]):
            code, name, emoji = category["code"], category["name"], category["emoji"]
            category_ids[code] = conn.execute(
                "INSERT INTO categories(restaurant_id, code, name, emoji, sort) VALUES (?,?,?,?,?)", (restaurant_id, code, name, emoji, sort)
            ).lastrowid
        conn.executemany(
            """INSERT INTO menu_items(restaurant_id, category_id, name, description, ingredients_json, price, weight_g, kcal,
               protein, fat, carbs, allergens_json, traces_json, diets_json, options_json, cook_minutes, emoji, is_popular, is_new,
               sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            menu_seed_rows(restaurant_id, category_ids, stamp),
        )
        for sort, table in enumerate(SEED["tables"]):
            conn.execute(
                "INSERT INTO dining_tables(restaurant_id, label, zone, seats, qr_token, sort, created_at, map_x, map_y) VALUES (?,?,?,?,?,?,?,?,?)",
                (restaurant_id, table["label"], table["zone"], table["seats"], secrets.token_urlsafe(9), sort, stamp, table["x"], table["y"]),
            )
        audit(conn, "system", "seed", "catalog_seeded", "restaurant", restaurant_id, payload={"dishes": len(SEED["dishes"]), "tables": len(SEED["tables"])})
    log.info("Seeded restaurant with %d dishes and %d tables", len(SEED["dishes"]), len(SEED["tables"]))
    return restaurant_id


def _menu_snapshot(db: Database, restaurant_id: int) -> list[dict[str, Any]]:
    rows = db.all(
        "SELECT m.*, c.code AS category_code FROM menu_items m JOIN categories c ON c.id=m.category_id WHERE m.restaurant_id=? AND m.is_archived=0",
        (restaurant_id,),
    )
    for row in rows:
        row["allergens"] = jload(row["allergens_json"], [])
        row["traces"] = jload(row["traces_json"], [])
        row["options"] = jload(row["options_json"], [])
    return rows


def _order_line(rng: random.Random, item: dict, pid: str, pname: str, order_id: str, session_id: str, stamp: str,
                shared: list[str], profile: list[str], status: str) -> tuple:
    choices = default_choices(item["options"])
    unit = item["price"] + sum(c["price"] for c in choices)
    contains, traces = effective_allergens(item["allergens"], item["traces"], choices)
    qty = 1 if shared or rng.random() < 0.88 else 2
    conflicts = [{"participant_id": pid, "name": pname, "danger": sorted(set(contains) & set(profile))}] if set(contains) & set(profile) else []
    options_view = [{"group": c["group"], "choice": c["name"]} for c in choices]
    return (
        new_id("oi"), order_id, session_id, pid, pname, item["id"], item["name"], item["emoji"], item["category_code"],
        unit, qty, unit * qty, item["kcal"] + sum(c["kcal"] for c in choices), item["protein"], item["fat"], item["carbs"],
        jdump(contains), jdump(traces), jdump(options_view), "", jdump(shared), jdump(conflicts), item["cook_minutes"], status, stamp, stamp,
    )


def seed_demo_history(db: Database, restaurant_id: int) -> None:
    if db.scalar("SELECT count(*) FROM sessions WHERE is_demo=1", default=0):
        return
    rng = random.Random(settings.demo_seed)
    menu = _menu_snapshot(db, restaurant_id)
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for item in menu:
        by_cat[item["category_code"]].append(item)
    tables = db.all("SELECT * FROM dining_tables WHERE restaurant_id=? ORDER BY sort", (restaurant_id,))
    service_percent = db.scalar("SELECT service_percent FROM restaurants WHERE id=?", (restaurant_id,), float(settings.service_fee_percent))

    def pick(categories: Iterable[str]) -> dict:
        pool = [item for cat in categories for item in by_cat.get(cat, [])]
        weights = [4 if item["is_popular"] else 1 for item in pool]
        return rng.choices(pool, weights=weights, k=1)[0]

    today_local = to_local(now_utc()).replace(hour=0, minute=0, second=0, microsecond=0)
    sessions, participants, orders, order_items, payments, allocations = [], [], [], [], [], []
    for day_offset in range(settings.demo_history_days, 0, -1):
        day = today_local - timedelta(days=day_offset)
        count = rng.randint(14, 22) + (6 if day.weekday() >= 4 else 0)
        number = 0
        starts = []
        for _ in range(count):
            slot = rng.choices(("morning", "lunch", "dinner"), weights=(12, 50, 38))[0]
            hour = {"morning": rng.randint(9, 10), "lunch": rng.randint(12, 14), "dinner": rng.randint(18, 21)}[slot]
            starts.append((day.replace(hour=hour, minute=rng.randint(0, 59)), slot))
        starts.sort(key=lambda pair: pair[0])
        for start_local, slot in starts:
            start = start_local.astimezone(UTC)
            is_office = slot == "lunch" and rng.random() < 0.14
            table = None if is_office else rng.choice(tables)
            session_id = new_id("ses")
            size = rng.choices((1, 2, 3, 4, 5, 6, 8), weights=(24, 30, 19, 13, 7, 5, 2))[0]
            if is_office:
                size = max(size, rng.randint(4, 9))
            names = rng.sample(DEMO_NAMES, k=min(size, len(DEMO_NAMES)))
            people = []
            session_people = []
            for idx, name in enumerate(names):
                pid = new_id("par")
                profile = rng.choice((["milk"], ["nuts"], ["gluten"], ["peanuts"], ["fish"])) if rng.random() < 0.13 else []
                people.append((pid, name, profile))
                session_people.append((
                    pid, session_id, name, name.lower(), AVATARS[idx % len(AVATARS)], PARTICIPANT_COLORS[idx % len(PARTICIPANT_COLORS)],
                    "host" if idx == 0 else "guest", token_hash(secrets.token_urlsafe(16)), f"{rng.randint(0, 9999):04d}",
                    jdump(profile), "[]", iso(start), iso(start),
                ))
            pct = 0.0 if is_office else service_percent
            batches = 2 if size > 1 and rng.random() < 0.24 else 1
            session_items: list[dict] = []
            session_orders: dict[str, dict] = {}
            cursor_time = start + timedelta(minutes=rng.randint(5, 14))
            for batch in range(1, batches + 1):
                number += 1
                order_id = new_id("ord")
                lines = []
                for pid, name, profile in people:
                    if batch == 1:
                        if slot == "morning":
                            plan = [("breakfast",), ("coffee", "drinks")]
                        else:
                            plan = [tuple(MAIN_CATEGORIES)] if rng.random() < 0.88 else [("salads", "soups")]
                            if rng.random() < 0.62:
                                plan.append(("drinks", "coffee"))
                            if rng.random() < 0.34:
                                plan.append(("salads", "soups"))
                    else:
                        plan = [("desserts",)] if rng.random() < 0.6 else [("coffee", "drinks")]
                    for cats in plan:
                        item = pick(cats)
                        if profile and set(item["allergens"]) & set(profile) and rng.random() < 0.85:
                            continue
                        lines.append(_order_line(rng, item, pid, name, order_id, session_id, iso(cursor_time), [], profile, "served"))
                if size >= 3 and batch == 1 and rng.random() < 0.3:
                    sharers = [p[0] for p in rng.sample(people[1:], k=min(len(people) - 1, rng.randint(1, 3)))]
                    owner = people[0]
                    lines.append(_order_line(rng, pick(("desserts", "pasta", "national")), owner[0], owner[1], order_id, session_id,
                                             iso(cursor_time), sharers, owner[2], "served"))
                if not lines:
                    continue
                cook = [line[22] for line in lines]
                eta = compute_eta_minutes(cook, rng.randint(0, 4))
                accepted = cursor_time + timedelta(minutes=rng.randint(1, 3))
                ready = accepted + timedelta(minutes=max(4, eta + rng.randint(-4, 5)))
                served = ready + timedelta(minutes=rng.randint(1, 4))
                subtotal = sum(line[11] for line in lines)
                orders.append((
                    order_id, session_id, restaurant_id, number, batch, "table", "served", people[0][0], people[0][1], subtotal, pct, "",
                    eta, eta, iso(accepted + timedelta(minutes=eta)), iso(cursor_time), iso(accepted), iso(accepted), iso(ready), iso(served), 1,
                ))
                session_orders[order_id] = {"service_percent": pct}
                for line in lines:
                    order_items.append(line)
                    session_items.append({"id": line[0], "order_id": order_id, "participant_id": line[3], "name": line[6], "qty": line[10],
                                          "line_total": line[11], "shared_with": jload(line[20], [])})
                cursor_time = served + timedelta(minutes=rng.randint(10, 25))
            if not session_items:
                continue
            participants.extend(session_people)
            bill = compute_bill([{"id": p[0]} for p in people], session_items, session_orders, [])
            pay_time = cursor_time
            one_payer = size > 1 and rng.random() < 0.22
            groups = [[row for row in bill["participants"] if row["total"] > 0]] if one_payer else [[row] for row in bill["participants"] if row["total"] > 0]
            for group in groups:
                method = rng.choices(("kaspi", "card", "cash"), weights=(62, 25, 13))[0]
                amount = sum(row["total"] for row in group)
                tip_pct = rng.choices((0, 5, 10, 15), weights=(55, 20, 20, 5))[0] if method != "cash" else 0
                payment_id = new_id("pay")
                payments.append((payment_id, session_id, group[0]["participant_id"], "payment", method, PAYMENT_METHODS[method]["provider"],
                                 f"demo_{secrets.token_hex(5)}", amount, percent_of(amount, tip_pct), "paid", iso(pay_time), iso(pay_time), iso(pay_time), 1))
                for row in group:
                    allocations.append((payment_id, row["participant_id"], row["total"]))
                pay_time += timedelta(seconds=rng.randint(20, 90))
            sessions.append((
                session_id, random_code(), restaurant_id, table["id"] if table else None, "office" if is_office else "table",
                "Офисный обед" if is_office else "", "group" if size > 1 else "solo", "closed", pct, None,
                iso(start + timedelta(minutes=30)) if is_office else None, 1, iso(start), iso(pay_time), iso(pay_time), "paid",
            ))
    with db.tx() as conn:
        conn.executemany(
            """INSERT INTO sessions(id, code, restaurant_id, table_id, kind, title, intent, status, service_percent, deadline_at, cutoff_at,
               is_demo, created_at, updated_at, closed_at, close_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", sessions)
        conn.executemany(
            """INSERT INTO participants(id, session_id, name, name_key, avatar, color, role, token_hash, recovery_pin, allergens_json,
               diets_json, joined_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", participants)
        conn.executemany(
            """INSERT INTO orders(id, session_id, restaurant_id, number, batch, scope, status, submitted_by, submitted_by_name, subtotal,
               service_percent, kitchen_note, eta_predicted, eta_minutes, eta_at, created_at, accepted_at, cooking_at, ready_at, served_at, is_demo)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", orders)
        conn.executemany(
            """INSERT INTO order_items(id, order_id, session_id, participant_id, participant_name, menu_item_id, name, emoji, category_code,
               unit_price, qty, line_total, kcal, protein, fat, carbs, allergens_json, traces_json, options_json, note, shared_with_json,
               conflicts_json, cook_minutes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", order_items)
        conn.executemany(
            """INSERT INTO payments(id, session_id, payer_id, kind, method, provider, provider_ref, amount, tip, status, created_at,
               updated_at, paid_at, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", payments)
        conn.executemany("INSERT INTO payment_allocations(payment_id, participant_id, amount) VALUES (?,?,?)", allocations)
    log.info("Demo history: %d sessions, %d orders, %d dishes served", len(sessions), len(orders), len(order_items))


def seed_live_demo(sessions: Any, cart: Any, orders: Any, menu: Any) -> None:
    if not settings.demo_mode:
        return
    tables = DB.all("SELECT * FROM dining_tables WHERE restaurant_id=? AND is_active=1 ORDER BY sort, id", (menu.restaurant_id,))
    if len(tables) < 4 or sessions.open_session_for_table(tables[3]["id"]):
        return
    if DB.scalar("SELECT count(*) FROM sessions WHERE is_demo=1 AND status IN ('open','locked')", default=0):
        return
    by_name = {item["name"]: item["id"] for item in menu.items()}
    token = tables[3]["qr_token"]
    joined = [
        sessions.join_table(token, "Айгерим", "🦊", "group", ["milk"], [], is_demo=True),
        sessions.join_table(token, "Тимур", "🐻", "group", [], [], is_demo=True),
        sessions.join_table(token, "Данияр", "🐼", "group", ["nuts"], ["halal"], is_demo=True),
    ]
    code = joined[0]["code"]
    ctx = [sessions.context(code, j["participant_token"]) for j in joined]
    ids = [j["participant_id"] for j in joined]
    cart.add(ctx[2], by_name["Лагман гуйру"], 1, {"spice": ["hot"]}, "Без кинзы, пожалуйста", [])
    cart.add(ctx[1], by_name["Шурпа из баранины"], 1, {}, "", [])
    orders.submit(ctx[2], "table", True, "", None)
    pending = DB.one("SELECT id FROM orders WHERE session_id=? ORDER BY batch DESC", (ctx[0].sid,))
    orders.set_status(pending["id"], "accepted", StaffCtx("kitchen"))
    orders.set_status(pending["id"], "cooking", StaffCtx("kitchen"))
    cart.add(ctx[0], by_name["Бешбармак"], 1, {"size": ["big"]}, "", ids[1:])
    cart.add(ctx[1], by_name["Шашлык из баранины"], 1, {"spice": ["medium"]}, "", [])
    cart.add(ctx[1], by_name["Айран"], 2, {}, "", [])
    cart.add(ctx[0], by_name["Чай по-казахски"], 1, {}, "", ids[1:])
    cart.add(ctx[2], by_name["Лимонад тархун"], 1, {"volume": ["l"], "sweet": ["less"]}, "", [])
    with DB.tx() as conn:
        conn.execute("UPDATE participants SET ready=1 WHERE id=?", (ids[1],))
    log.info("Live demo company seated at %s (code %s)", tables[3]["label"], code)
