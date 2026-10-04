"""Menu search: token parser driven by search_vocabulary.json, SQLite FTS5 trigram index and difflib typo correction."""

from __future__ import annotations

import difflib
import re
import sqlite3
import threading
from dataclasses import dataclass, field
from typing import Any, Optional

from foodbuster.core.money import fmt_money, tiyn
from foodbuster.core.utils import normalize_text
from foodbuster.domain.allergens import diet_allows
from foodbuster.domain.reference import ALLERGEN_ALIASES, ALLERGEN_BY_CODE, ALLERGEN_ORDER, ALLERGENS, DIETS, load_json

VOCAB = load_json("search_vocabulary.json")
RU_ENDINGS = tuple(VOCAB["ru_endings"])
STOPWORDS = set(VOCAB["stopwords"])
UNIT_WORDS = {w for stems in VOCAB["units"].values() for w in stems} | {"калорий", "калории", "минуты", "граммов"}
TOKEN = re.compile(r"\d+|[a-zа-я]+(?:-[a-zа-я]+)*|[<>]=?|[≤≥₸,]")


def stem(word: str) -> str:
    for ending in RU_ENDINGS:
        if word.endswith(ending) and len(word) - len(ending) >= 3:
            return word[: -len(ending)]
    return word


def words(text: str) -> list[str]:
    return re.findall(r"[a-zа-я0-9]+", normalize_text(text))


def _starts(word: str, stems: list[str]) -> bool:
    return any(word == s or (len(s) >= 3 and word.startswith(s)) for s in stems)


_NAME_STEMS = {stem(w): a.code for a in ALLERGENS for w in words(a.name) + words(a.short) if len(w) >= 3} | ALLERGEN_ALIASES


def resolve_allergen(word: str) -> Optional[str]:
    base = stem(normalize_text(word))
    if len(base) < 3:
        return None
    for allergen in ALLERGENS:
        for synonym in allergen.synonyms:
            syn = normalize_text(synonym)
            if syn.startswith(base) or stem(syn) == base or (len(syn) >= 4 and base.startswith(syn)):
                return allergen.code
    return None


def allergen_by_name(word: str) -> Optional[str]:
    base = stem(normalize_text(word))
    if len(base) < 3:
        return None
    for name_stem, code in _NAME_STEMS.items():
        if base.startswith(name_stem) or (name_stem.startswith(base) and len(base) >= 4):
            return code
    return None


@dataclass
class SearchQuery:
    raw: str = ""
    terms: list[str] = field(default_factory=list)
    exclude_allergens: set[str] = field(default_factory=set)
    exclude_terms: list[str] = field(default_factory=list)
    diets: set[str] = field(default_factory=set)
    no_spicy: bool = False
    max_kcal: Optional[int] = None
    min_kcal: Optional[int] = None
    max_price: Optional[int] = None
    min_protein: Optional[float] = None
    max_fat: Optional[float] = None
    max_carbs: Optional[float] = None
    max_cook: Optional[int] = None
    chips: list[dict[str, str]] = field(default_factory=list)

    def chip(self, kind: str, text: str) -> None:
        if not any(c["text"] == text for c in self.chips):
            self.chips.append({"kind": kind, "text": text})

    def is_empty(self) -> bool:
        return not (self.terms or self.exclude_allergens or self.exclude_terms or self.diets or self.no_spicy or self.max_kcal
                    or self.min_kcal or self.max_price or self.min_protein or self.max_fat is not None or self.max_carbs is not None
                    or self.max_cook)


class _Parser:
    def __init__(self, raw: str) -> None:
        text = normalize_text(raw).replace("≤", " <= ").replace("≥", " >= ")
        text = re.sub(r"(\d)[\s ](\d{3})(?!\d)", r"\1\2", text)
        self.tokens = TOKEN.findall(text)
        self.used = [False] * len(self.tokens)
        self.q = SearchQuery(raw=raw or "")

    def tok(self, i: int) -> str:
        return self.tokens[i] if 0 <= i < len(self.tokens) else ""

    def unit(self, word: str) -> Optional[str]:
        return next((name for name, stems in VOCAB["units"].items() if word and _starts(word, stems)), None)

    def nutrient(self, word: str) -> Optional[str]:
        return next((name for name, stems in VOCAB["nutrients"].items() if word and _starts(word, stems)), None)

    def comparator(self, i: int) -> tuple[Optional[str], int]:
        word, nxt = self.tok(i), self.tok(i + 1)
        if [word, nxt] in VOCAB["not_more"]:
            return "le", 2
        if [word, nxt] in VOCAB["not_less"]:
            return "ge", 2
        if word in VOCAB["less"]:
            return "le", 1
        if word in VOCAB["more"]:
            return "ge", 1
        return None, 0

    def mark(self, *indexes: int) -> None:
        for i in indexes:
            if 0 <= i < len(self.used):
                self.used[i] = True

    def numbers(self) -> None:
        for i, token in enumerate(self.tokens):
            if not token.isdigit() or self.used[i]:
                continue
            value = int(token)
            direction, back = None, 0
            for width in (2, 1):
                cmp, size = self.comparator(i - width)
                if cmp and size == width:
                    direction, back = cmp, width
                    break
            unit = self.unit(self.tok(i + 1))
            nutrient = self.nutrient(self.tok(i - back - 1)) or self.nutrient(self.tok(i + 1)) or self.nutrient(self.tok(i + 2))
            span = [i - k for k in range(1, back + 1)] + [i]
            if unit:
                span.append(i + 1)
            if nutrient:
                for j in (i - back - 1, i + 1, i + 2):
                    if self.nutrient(self.tok(j)):
                        span.append(j)
                        break
                self.set_nutrient(nutrient, value, direction or ("le" if nutrient != "protein" else "ge"))
            elif unit == "kcal":
                self.set_kcal(value, direction or "le")
            elif unit == "money":
                self.set_price(value)
            elif unit == "minutes":
                self.set_cook(value)
            elif direction == "le" and not unit:
                if value >= 1000:
                    self.set_price(value)
                elif value >= 50:
                    self.set_kcal(value, "le")
                else:
                    continue
            elif direction == "ge" and not unit and value >= 50:
                self.set_kcal(value, "ge")
            else:
                continue
            self.mark(*span)

    def set_kcal(self, value: int, direction: str) -> None:
        if direction == "ge":
            self.q.min_kcal = value
            self.q.chip("kcal", f"≥ {value} ккал")
        else:
            self.q.max_kcal = value
            self.q.chip("kcal", f"≤ {value} ккал")

    def set_price(self, value: int) -> None:
        self.q.max_price = tiyn(value)
        self.q.chip("price", f"до {fmt_money(tiyn(value))}")

    def set_cook(self, value: int) -> None:
        self.q.max_cook = value
        self.q.chip("time", f"≤ {value} мин")

    def set_nutrient(self, nutrient: str, value: int, direction: str) -> None:
        if nutrient == "protein":
            self.q.min_protein = float(value)
            self.q.chip("protein", f"белок ≥ {value} г")
        elif nutrient == "fat":
            self.q.max_fat = float(value)
            self.q.chip("fat", f"жиры ≤ {value} г")
        else:
            self.q.max_carbs = float(value)
            self.q.chip("carbs", f"углеводы ≤ {value} г")

    def exclude(self, word: str) -> None:
        code = resolve_allergen(word)
        if code:
            self.q.exclude_allergens.add(code)
            self.q.chip("allergen", f"без: {ALLERGEN_BY_CODE[code].short}")
        elif len(word) >= 3:
            self.q.exclude_terms.append(stem(word))
            self.q.chip("exclude", f"без: {word}")

    def add_diet(self, code: str) -> None:
        self.q.diets.add(code)
        self.q.chip("diet", DIETS[code]["name"])

    def negations(self) -> None:
        for i, token in enumerate(self.tokens):
            if self.used[i] or token not in VOCAB["negations"]:
                continue
            nxt = self.tok(i + 1)
            if _starts(nxt, VOCAB["flags"]["spicy"]):
                self.q.no_spicy = True
                self.q.chip("diet", "не острое")
                self.mark(i, i + 1)
            elif token == "без" and _starts(nxt, VOCAB["meat_words"]):
                self.add_diet("vegetarian")
                self.mark(i, i + 1)
            elif token in ("без", "without", "no") and nxt and not nxt.isdigit():
                j = i + 1
                self.mark(i)
                while j < len(self.tokens) and not self.used[j]:
                    word = self.tokens[j]
                    if word in VOCAB["joiners"]:
                        self.mark(j)
                        j += 1
                        continue
                    if word.isdigit() or word in STOPWORDS or self.unit(word) or self.comparator(j)[0]:
                        break
                    self.exclude(word)
                    self.mark(j)
                    j += 1
                    if self.tok(j) not in VOCAB["joiners"]:
                        break

    def flags(self) -> None:
        f = VOCAB["flags"]
        for i, token in enumerate(self.tokens):
            if self.used[i]:
                continue
            if _starts(token, f["gluten_free"]):
                self.exclude("глютен")
            elif _starts(token, f["lactose_free"]):
                self.exclude("лактоза")
            elif _starts(token, f["high_protein"]) or (token in ("много", "высокий") and self.nutrient(self.tok(i + 1)) == "protein"):
                self.q.min_protein = max(self.q.min_protein or 0, 30)
                self.q.chip("protein", "белок ≥ 30 г")
                self.mark(i + 1)
            elif _starts(token, f["low_fat"]):
                self.q.max_fat = 15
                self.q.chip("fat", "жиры ≤ 15 г")
            elif _starts(token, f["low_carb"]):
                self.q.max_carbs = 20
                self.q.chip("carbs", "углеводы ≤ 20 г")
            elif _starts(token, f["light"]):
                if self.q.max_kcal is None:
                    self.set_kcal(450, "le")
            elif _starts(token, f["fast"]):
                self.set_cook(self.q.max_cook or 10)
            elif _starts(token, f["vegan"]):
                self.add_diet("vegan")
            elif _starts(token, f["vegetarian"]):
                self.add_diet("vegetarian")
            elif _starts(token, f["halal"]):
                self.add_diet("halal")
            elif _starts(token, f["spicy"]):
                self.add_diet("spicy")
            else:
                continue
            self.mark(i)

    def parse(self) -> SearchQuery:
        self.numbers()
        self.negations()
        self.flags()
        for i, token in enumerate(self.tokens):
            if self.used[i] or token in STOPWORDS or token.isdigit() or len(token) < 2 or not re.match(r"[a-zа-я]", token):
                continue
            if token in UNIT_WORDS or self.nutrient(token) or token in VOCAB["less"] + VOCAB["more"] + VOCAB["negations"] + VOCAB["joiners"]:
                continue
            self.q.terms.append(token)
            self.q.chip("text", f"«{token}»")
        return self.q


def parse_search(raw: str) -> SearchQuery:
    return _Parser(raw).parse()


class MenuIndex:
    """In-memory SQLite FTS5 index (trigram tokenizer: substring search in any language) rebuilt per menu revision."""

    COLUMNS = ("name", "ingredients", "category", "description")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._revision: Any = None
        self._conn: Optional[sqlite3.Connection] = None
        self._vocabulary: list[str] = []

    def ensure(self, items: list[dict[str, Any]], revision: Any) -> None:
        with self._lock:
            if self._revision == revision and self._conn is not None:
                return
            conn = sqlite3.connect(":memory:", check_same_thread=False)
            conn.execute(f"CREATE VIRTUAL TABLE menu USING fts5({', '.join(self.COLUMNS)}, tokenize='trigram')")
            conn.executemany("INSERT INTO menu(rowid, name, ingredients, category, description) VALUES (?,?,?,?,?)", [
                (i["id"], normalize_text(i["name"]), normalize_text(" , ".join(i.get("ingredients") or [])),
                 normalize_text(i.get("category_name", "")), normalize_text(i.get("description", ""))) for i in items])
            vocabulary = {w for i in items for w in words(i["name"] + " " + " ".join(i.get("ingredients") or [])) if len(w) >= 4}
            vocabulary |= {normalize_text(s) for a in ALLERGENS for s in a.synonyms if len(s) >= 4}
            if self._conn is not None:
                self._conn.close()
            self._conn, self._revision, self._vocabulary = conn, revision, sorted(vocabulary)

    def hits(self, term: str) -> dict[str, set[int]]:
        base = stem(term)
        needle = base if len(base) >= 3 else term
        result: dict[str, set[int]] = {c: set() for c in self.COLUMNS}
        if len(needle) < 3 or self._conn is None:
            return result
        quoted = '"' + needle.replace('"', "") + '"'
        with self._lock:
            for column in self.COLUMNS:
                rows = self._conn.execute("SELECT rowid FROM menu WHERE menu MATCH ?", (f"{column} : {quoted}",)).fetchall()
                result[column] = {r[0] for r in rows}
        return result

    def correct(self, term: str) -> Optional[str]:
        if len(term) < 4:
            return None
        found = difflib.get_close_matches(term, self._vocabulary, n=1, cutoff=0.78)
        return found[0] if found and found[0] != term else None


def _term_score(term: str, item: dict, hits: dict[str, set[int]]) -> tuple[int, Optional[str]]:
    item_id = item["id"]
    base = stem(term)
    if item_id in hits["name"] or any(w.startswith(base) for w in words(item["name"])):
        return 10, None
    for ingredient in item.get("ingredients") or []:
        if base in normalize_text(ingredient):
            return 7, f"в составе: {ingredient}"
    if item_id in hits["ingredients"]:
        return 7, "в составе"
    if item_id in hits["category"]:
        return 4, None
    code = allergen_by_name(term)
    if code and code in (item.get("allergens") or []):
        return 6, f"содержит: {ALLERGEN_BY_CODE[code].short}"
    if code and code in (item.get("traces") or []):
        return 3, f"возможны следы: {ALLERGEN_BY_CODE[code].short}"
    if item_id in hits["description"]:
        return 3, "в описании"
    return 0, None


def _passes(item: dict, query: SearchQuery) -> bool:
    if query.exclude_allergens & set(item.get("allergens") or []):
        return False
    item_words = [w for ing in item.get("ingredients") or [] for w in words(ing)] + words(item["name"])
    if any(any(w.startswith(ex) for w in item_words) for ex in query.exclude_terms):
        return False
    if query.diets and not diet_allows(item.get("diets") or [], query.diets):
        return False
    if query.no_spicy and "spicy" in (item.get("diets") or []):
        return False
    limits = ((query.max_kcal, "kcal", 1), (query.min_kcal, "kcal", -1), (query.max_price, "price", 1), (query.min_protein, "protein", -1),
              (query.max_fat, "fat", 1), (query.max_carbs, "carbs", 1), (query.max_cook, "cook_minutes", 1))
    return all(limit is None or (item[key] - limit) * sign <= 0 for limit, key, sign in limits)


def match_menu(items: list[dict], query: SearchQuery, index: Optional[MenuIndex] = None) -> list[dict[str, Any]]:
    term_hits = {}
    for n, term in enumerate(list(query.terms)):
        hits = index.hits(term) if index else {c: set() for c in MenuIndex.COLUMNS}
        if index and not any(hits.values()) and not any(_term_score(term, i, hits)[0] for i in items):
            fixed = index.correct(term)
            if fixed:
                query.terms[n] = fixed
                query.chips = [c for c in query.chips if c["text"] != f"«{term}»"]
                query.chip("text", f"«{fixed}» — исправили «{term}»")
                hits = index.hits(fixed)
                term = fixed
        term_hits[term] = hits
    results = []
    for item in items:
        if not _passes(item, query):
            continue
        score = 1 + (2 if item.get("popular") else 0)
        reason: Optional[str] = None
        matched = True
        for term in query.terms:
            hit, why = _term_score(term, item, term_hits[term])
            if hit == 0:
                matched = False
                break
            score += hit
            reason = reason or why
        if not matched:
            continue
        trace_flags = sorted(query.exclude_allergens & set(item.get("traces") or []), key=ALLERGEN_ORDER.get)
        if trace_flags and not reason:
            reason = "возможны следы: " + ", ".join(ALLERGEN_BY_CODE[c].short for c in trace_flags)
        results.append({"id": item["id"], "score": score, "reason": reason})
    results.sort(key=lambda r: (-r["score"], r["id"]))
    return results
