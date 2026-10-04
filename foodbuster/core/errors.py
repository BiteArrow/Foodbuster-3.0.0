from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


FIELD_LABELS = {
    "name": "Имя", "username": "Логин", "password": "Пароль", "new_password": "Новый пароль", "pin": "Код", "qty": "Количество",
    "price_tiyn": "Цена", "kcal": "Калории", "protein": "Белки", "fat": "Жиры", "carbs": "Углеводы", "weight_g": "Выход",
    "cook_minutes": "Время приготовления", "category_id": "Категория", "label": "Название стола", "seats": "Места",
    "count": "Количество столов", "service_percent": "Обслуживание", "cutoff_minutes": "Дедлайн", "minutes": "Время",
    "tip_percent": "Чаевые", "description": "Описание", "note": "Комментарий", "title": "Название", "choices": "Варианты",
    "options": "Модификаторы",
}
ERROR_TEXT = {
    "missing": "обязательное поле", "string_too_short": "слишком короткое значение", "string_too_long": "слишком длинное значение",
    "too_short": "нужно больше элементов", "too_long": "слишком много элементов", "int_parsing": "нужно целое число",
    "float_parsing": "нужно число", "decimal_parsing": "нужно число", "literal_error": "недопустимое значение",
    "extra_forbidden": "неизвестное поле", "string_pattern_mismatch": "неверный формат", "bool_parsing": "нужно да или нет",
    "int_from_float": "нужно целое число", "int_type": "нужно целое число",
}


def describe_validation(errors: list[dict[str, Any]]) -> tuple[str, list[dict[str, str]]]:
    details = []
    for error in errors:
        loc = [str(part) for part in error.get("loc", []) if part not in ("body", "query", "path", "header")]
        field_key = next((p for p in reversed(loc) if not p.isdigit()), "")
        ctx = error.get("ctx") or {}
        kind = error.get("type", "")
        if kind == "greater_than_equal":
            text = f"не меньше {ctx.get('ge')}"
        elif kind == "less_than_equal":
            text = f"не больше {ctx.get('le')}"
        elif kind == "value_error":
            text = str(ctx.get("error") or "некорректное значение")
        else:
            text = ERROR_TEXT.get(kind, "некорректное значение")
        details.append({"field": ".".join(loc), "label": FIELD_LABELS.get(field_key, field_key or "запрос"), "message": text})
    first = details[0] if details else {"label": "запрос", "message": "некорректные данные"}
    return f"Проверьте поле «{first['label']}»: {first['message']}", details
