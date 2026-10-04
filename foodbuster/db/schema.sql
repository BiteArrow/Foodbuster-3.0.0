-- Foodbuster SQLite schema. Additive changes go to migrations.py so existing databases keep their data.
CREATE TABLE IF NOT EXISTS restaurants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'KZT',
    service_percent REAL NOT NULL DEFAULT 10 CHECK (service_percent >= 0 AND service_percent <= 30),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    emoji TEXT NOT NULL DEFAULT '🍽',
    sort INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (restaurant_id, code)
);
CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '',
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    price INTEGER NOT NULL CHECK (price >= 0),
    weight_g INTEGER NOT NULL DEFAULT 0 CHECK (weight_g >= 0),
    kcal INTEGER NOT NULL DEFAULT 0 CHECK (kcal >= 0),
    protein REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    allergens_json TEXT NOT NULL DEFAULT '[]',
    traces_json TEXT NOT NULL DEFAULT '[]',
    diets_json TEXT NOT NULL DEFAULT '[]',
    options_json TEXT NOT NULL DEFAULT '[]',
    cook_minutes INTEGER NOT NULL DEFAULT 10 CHECK (cook_minutes BETWEEN 1 AND 180),
    emoji TEXT NOT NULL DEFAULT '🍽',
    image_path TEXT,
    is_popular INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0,
    is_available INTEGER NOT NULL DEFAULT 1,
    is_archived INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dining_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 30),
    zone TEXT NOT NULL DEFAULT '',
    seats INTEGER NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 40),
    qr_token TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    map_x REAL,
    map_y REAL,
    is_archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
    table_id INTEGER REFERENCES dining_tables(id),
    kind TEXT NOT NULL CHECK (kind IN ('table', 'office')),
    title TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT 'solo' CHECK (intent IN ('solo', 'group')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'closed')),
    service_percent REAL NOT NULL DEFAULT 0,
    deadline_at TEXT,
    cutoff_at TEXT,
    pickup_note TEXT NOT NULL DEFAULT '',
    auto_submitted_at TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_open_table ON sessions(table_id)
    WHERE table_id IS NOT NULL AND status IN ('open', 'locked');
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🙂',
    color TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('host', 'guest')),
    token_hash TEXT NOT NULL UNIQUE,
    recovery_pin TEXT NOT NULL,
    allergens_json TEXT NOT NULL DEFAULT '[]',
    diets_json TEXT NOT NULL DEFAULT '[]',
    share_allergies INTEGER NOT NULL DEFAULT 1,
    ready INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (session_id, name_key)
);
CREATE TABLE IF NOT EXISTS cart_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    menu_version INTEGER NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    category_code TEXT NOT NULL,
    base_price INTEGER NOT NULL,
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    kcal INTEGER NOT NULL,
    protein REAL NOT NULL,
    fat REAL NOT NULL,
    carbs REAL NOT NULL,
    allergens_json TEXT NOT NULL,
    traces_json TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    options_key TEXT NOT NULL DEFAULT '',
    cook_minutes INTEGER NOT NULL DEFAULT 10,
    qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99),
    note TEXT NOT NULL DEFAULT '',
    shared_with_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    restaurant_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    batch INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'table',
    status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'cooking', 'ready', 'served', 'cancelled')),
    submitted_by TEXT,
    submitted_by_name TEXT NOT NULL DEFAULT '',
    subtotal INTEGER NOT NULL DEFAULT 0,
    service_percent REAL NOT NULL DEFAULT 0,
    kitchen_note TEXT NOT NULL DEFAULT '',
    eta_predicted INTEGER,
    eta_minutes INTEGER,
    eta_at TEXT,
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    cooking_at TEXT,
    ready_at TEXT,
    served_at TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, batch)
);
CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    menu_item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    category_code TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    kcal INTEGER NOT NULL,
    protein REAL NOT NULL,
    fat REAL NOT NULL,
    carbs REAL NOT NULL,
    allergens_json TEXT NOT NULL,
    traces_json TEXT NOT NULL,
    options_json TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    shared_with_json TEXT NOT NULL DEFAULT '[]',
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    cook_minutes INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'cooking', 'ready', 'served', 'cancelled')),
    cancel_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    payer_id TEXT,
    kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
    method TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    tip INTEGER NOT NULL DEFAULT 0 CHECK (tip >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_cash', 'paid', 'cancelled', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    paid_at TEXT,
    confirmed_by TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_allocations (
    payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (payment_id, participant_id)
);
CREATE TABLE IF NOT EXISTS waiter_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    participant_id TEXT,
    participant_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT NOT NULL,
    scope TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, scope)
);
CREATE TABLE IF NOT EXISTS staff_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'kitchen', 'waiter')),
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_menu_category ON menu_items(restaurant_id, category_id, is_archived);
CREATE INDEX IF NOT EXISTS ix_sessions_status ON sessions(restaurant_id, status);
CREATE INDEX IF NOT EXISTS ix_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS ix_cart_session ON cart_items(session_id, participant_id);
CREATE INDEX IF NOT EXISTS ix_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(restaurant_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS ix_order_items_session ON order_items(session_id);
CREATE INDEX IF NOT EXISTS ix_order_items_menu ON order_items(menu_item_id);
CREATE INDEX IF NOT EXISTS ix_payments_session ON payments(session_id, status);
CREATE INDEX IF NOT EXISTS ix_calls_session ON waiter_calls(session_id, status);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(created_at);
