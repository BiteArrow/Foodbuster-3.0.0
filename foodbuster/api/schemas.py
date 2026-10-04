"""Request bodies. Money always travels as integer tiyn (price_tiyn), never as a float."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class JoinIn(APIModel):
    name: str = Field(min_length=1, max_length=40)
    avatar: Optional[str] = Field(default=None, max_length=8)
    intent: Literal["solo", "group"] = "solo"
    allergens: list[str] = Field(default_factory=list, max_length=14)
    diets: list[str] = Field(default_factory=list, max_length=4)
    share_allergies: bool = True


class OfficeIn(APIModel):
    title: str = Field(default="Офисный обед", max_length=60)
    name: str = Field(min_length=1, max_length=40)
    avatar: Optional[str] = Field(default=None, max_length=8)
    cutoff_minutes: int = Field(default=45, ge=5, le=600)
    pickup_note: str = Field(default="", max_length=120)
    allergens: list[str] = Field(default_factory=list, max_length=14)
    diets: list[str] = Field(default_factory=list, max_length=4)


class OfficeJoinIn(APIModel):
    name: str = Field(min_length=1, max_length=40)
    avatar: Optional[str] = Field(default=None, max_length=8)
    allergens: list[str] = Field(default_factory=list, max_length=14)
    diets: list[str] = Field(default_factory=list, max_length=4)


class RecoverIn(APIModel):
    name: str = Field(min_length=1, max_length=40)
    pin: str = Field(pattern=r"^\d{4}$")


class MeIn(APIModel):
    name: Optional[str] = Field(default=None, max_length=40)
    avatar: Optional[str] = Field(default=None, max_length=8)
    allergens: Optional[list[str]] = Field(default=None, max_length=14)
    diets: Optional[list[str]] = Field(default=None, max_length=4)
    share_allergies: Optional[bool] = None
    ready: Optional[bool] = None


class PresenceIn(APIModel):
    kind: Literal["dish", "category", "tab", "search", "none"]
    ref: Optional[str] = Field(default=None, max_length=60)


class CartAddIn(APIModel):
    menu_item_id: int = Field(ge=1)
    qty: int = Field(default=1, ge=1, le=30)
    options: dict[str, list[str]] = Field(default_factory=dict)
    note: str = Field(default="", max_length=200)
    shared_with: list[str] = Field(default_factory=list, max_length=30)


class CartUpdateIn(APIModel):
    qty: Optional[int] = Field(default=None, ge=0, le=30)
    note: Optional[str] = Field(default=None, max_length=200)
    shared_with: Optional[list[str]] = Field(default=None, max_length=30)


class SubmitIn(APIModel):
    scope: Literal["mine", "table"] = "table"
    confirm_allergens: bool = False
    kitchen_note: str = Field(default="", max_length=200)


class DeadlineIn(APIModel):
    minutes: Optional[int] = Field(default=None, ge=5, le=240)


class CallIn(APIModel):
    reason: str = Field(max_length=20)


class PaymentIn(APIModel):
    beneficiaries: list[str] = Field(default_factory=list, max_length=30)
    method: Literal["kaspi", "card", "cash"]
    tip_percent: Optional[int] = Field(default=None, ge=0, le=50)
    tip_amount: Optional[int] = Field(default=None, ge=0, le=100_000_000)


class LoginIn(APIModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class PasswordIn(APIModel):
    new_password: str = Field(min_length=1, max_length=128)
    current_password: Optional[str] = Field(default=None, max_length=128)


class AcceptIn(APIModel):
    eta_minutes: Optional[int] = Field(default=None, ge=1, le=180)


class StatusIn(APIModel):
    status: Literal["accepted", "cooking", "ready", "served", "cancelled"]
    reason: str = Field(default="", max_length=120)


class ItemStatusIn(APIModel):
    status: Literal["cooking", "ready", "served", "cancelled"]
    reason: str = Field(default="", max_length=120)


class EtaIn(APIModel):
    delta: int = Field(ge=-60, le=60)

    @field_validator("delta")
    @classmethod
    def non_zero(cls, value: int) -> int:
        if value == 0:
            raise ValueError("delta must not be zero")
        return value


class CloseIn(APIModel):
    force: bool = False


class RefundIn(APIModel):
    participant_id: str = Field(min_length=4, max_length=40)


class ChoiceIn(APIModel):
    id: Optional[str] = Field(default=None, max_length=24)
    name: str = Field(min_length=1, max_length=40)
    price_tiyn: int = Field(default=0, ge=-10_000_000, le=10_000_000)
    kcal: int = Field(default=0, ge=-3000, le=3000)
    weight_g: int = Field(default=0, ge=-5000, le=5000)
    protein: float = Field(default=0, ge=-500, le=500)
    fat: float = Field(default=0, ge=-500, le=500)
    carbs: float = Field(default=0, ge=-500, le=500)
    add_allergens: list[str] = Field(default_factory=list, max_length=14)
    remove_allergens: list[str] = Field(default_factory=list, max_length=14)
    add_traces: list[str] = Field(default_factory=list, max_length=14)


class OptionGroupIn(APIModel):
    id: Optional[str] = Field(default=None, max_length=24)
    name: str = Field(min_length=1, max_length=40)
    type: Literal["single", "multi"] = "single"
    required: bool = False
    max: int = Field(default=1, ge=1, le=12)
    choices: list[ChoiceIn] = Field(min_length=1, max_length=12)


class MenuItemIn(APIModel):
    name: str = Field(min_length=2, max_length=80)
    category_id: int = Field(ge=1)
    description: str = Field(default="", max_length=400)
    ingredients: list[str] = Field(default_factory=list, max_length=40)
    price_tiyn: int = Field(ge=0, le=100_000_000)
    weight_g: int = Field(default=0, ge=0, le=5000)
    kcal: Optional[int] = Field(default=None, ge=0, le=5000)
    protein: float = Field(default=0, ge=0, le=500)
    fat: float = Field(default=0, ge=0, le=500)
    carbs: float = Field(default=0, ge=0, le=1000)
    allergens: list[str] = Field(default_factory=list, max_length=14)
    traces: list[str] = Field(default_factory=list, max_length=14)
    diets: list[str] = Field(default_factory=list, max_length=4)
    cook_minutes: int = Field(default=10, ge=1, le=180)
    emoji: str = Field(default="🍽", max_length=8)
    popular: bool = False
    new: bool = False
    available: bool = True
    options: list[OptionGroupIn] = Field(default_factory=list, max_length=8)


class AvailabilityIn(APIModel):
    available: bool


class ImageIn(APIModel):
    data_url: str = Field(min_length=20, max_length=5_000_000)


class CategoryIn(APIModel):
    name: str = Field(min_length=1, max_length=40)
    emoji: str = Field(default="🍽", max_length=8)
    active: bool = True


class ReorderIn(APIModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class TableIn(APIModel):
    label: str = Field(min_length=1, max_length=30)
    zone: str = Field(default="", max_length=40)
    seats: int = Field(default=4, ge=1, le=40)
    active: bool = True


class TablePlace(APIModel):
    id: int
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)


class BulkTablesIn(APIModel):
    count: int = Field(ge=1, le=100)
    seats: int = Field(default=4, ge=1, le=40)
    zone: str = Field(default="", max_length=40)
    prefix: str = Field(default="Стол", max_length=20)


class LayoutIn(APIModel):
    items: list[TablePlace] = Field(min_length=1, max_length=200)


class RestaurantIn(APIModel):
    name: str = Field(min_length=1, max_length=60)
    city: str = Field(default="", max_length=40)
    service_percent: Decimal = Field(ge=0, le=30, max_digits=4, decimal_places=1)


class ResetIn(APIModel):
    full: bool = False
