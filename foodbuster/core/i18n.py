"""Localization through standard gettext catalogs; .po files are compiled to .mo on start-up."""

from __future__ import annotations

import ast
import gettext
import struct
from functools import lru_cache
from pathlib import Path

from settings import settings

LOCALES_DIR = Path(__file__).resolve().parent.parent / "locales"
DOMAIN = "foodbuster"


def _parse_po(path: Path) -> dict[str, str]:
    messages: dict[str, str] = {}
    msgid = msgstr = None
    section = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("msgid "):
            if msgid is not None and msgstr is not None:
                messages[msgid] = msgstr
            msgid, msgstr, section = ast.literal_eval(line[6:]), None, "id"
        elif line.startswith("msgstr "):
            msgstr, section = ast.literal_eval(line[7:]), "str"
        elif line.startswith('"') and section:
            chunk = ast.literal_eval(line)
            if section == "id":
                msgid += chunk
            else:
                msgstr += chunk
    if msgid is not None and msgstr is not None:
        messages[msgid] = msgstr
    return messages


def _write_mo(messages: dict[str, str], target: Path) -> None:
    keys = sorted(messages)
    ids = strs = b""
    offsets = []
    for key in keys:
        k, v = key.encode("utf-8"), messages[key].encode("utf-8")
        offsets.append((len(ids), len(k), len(strs), len(v)))
        ids += k + b"\0"
        strs += v + b"\0"
    start = 7 * 4 + 16 * len(keys)
    key_table = [x for o in offsets for x in (o[1], o[0] + start)]
    value_table = [x for o in offsets for x in (o[3], o[2] + start + len(ids))]
    header = struct.pack("Iiiiiii", 0x950412DE, 0, len(keys), 7 * 4, 7 * 4 + 8 * len(keys), 0, 0)
    target.write_bytes(header + struct.pack(f"{len(key_table)}i", *key_table) + struct.pack(f"{len(value_table)}i", *value_table) + ids + strs)


def compile_catalogs() -> None:
    for po in LOCALES_DIR.glob(f"*/LC_MESSAGES/{DOMAIN}.po"):
        mo = po.with_suffix(".mo")
        if not mo.exists() or mo.stat().st_mtime < po.stat().st_mtime:
            _write_mo(_parse_po(po), mo)


@lru_cache(maxsize=8)
def translator(locale: str) -> gettext.NullTranslations:
    if locale not in settings.supported_locales or locale == "ru":
        return gettext.NullTranslations()
    compile_catalogs()
    return gettext.translation(DOMAIN, localedir=str(LOCALES_DIR), languages=[locale], fallback=True)


def t(text: str, locale: str = "ru") -> str:
    return translator(locale).gettext(text) if text else text
