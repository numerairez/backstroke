"""Small date helpers shared by services."""

from __future__ import annotations

from datetime import date

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def format_day(value: str | None) -> str:
    """"2026-09-23" -> "23 Sep" (for automatic commit reasons)."""
    if not value:
        return ""
    d = date.fromisoformat(value)
    return f"{d.day} {_MONTHS[d.month - 1]}"
