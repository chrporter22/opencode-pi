"""Minimal standard 5-field cron matcher (pure python, UTC).

Fields: minute hour day-of-month month day-of-week (0=Sunday..6; 7=Sunday).
Supported syntax per field: `*`, lists `a,b`, ranges `a-b`, steps `*/n`,
`a-b/n`, `a/n`, and wildcard weekday `*`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _parse_field(expr: str, lo: int, hi: int) -> set[int]:
    values: set[int] = set()
    for part in str(expr).strip().split(","):
        if not part:
            continue
        base, _, step = part.partition("/")
        step = int(step) if step else 1
        if base == "*":
            a, b = lo, hi
        elif "-" in base:
            x, y = base.split("-", 1)
            a, b = int(x), int(y)
        else:
            a = int(base)
            b = a
        values.update(range(max(lo, a), min(hi, b) + 1, step))
    return values


class Cron:
    def __init__(self, expr: str) -> None:
        parts = str(expr or "").strip().split()
        self.expr = " ".join(parts)
        if len(parts) != 5:
            self.valid = False
            self.minutes = self.hours = self.days = self.months = self.dows = set()
            return
        (
            self.minutes,
            self.hours,
            self.days,
            self.months,
            dows,
        ) = [_parse_field(p, *bounds) for p, bounds in zip(
            parts,
            [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)],
        )]
        # 7 == Sunday
        if 7 in dows:
            dows.add(0)
        self.dows = dows
        if self.dows:
            self.dows.discard(7)
        self.valid = True

    def matches(self, dt: datetime) -> bool:
        if not self.valid:
            return False
        if dt.minute not in self.minutes:
            return False
        if dt.hour not in self.hours:
            return False
        if dt.day not in self.days:
            return False
        if dt.month not in self.months:
            return False
        return int(dt.strftime("%w")) in self.dows

    def next_runs(self, count: int = 5, start: datetime | None = None) -> list[datetime]:
        """Earliest `count` run times, strictly after `start` (default: now, UTC)."""
        if not self.valid:
            return []
        cur = start or datetime.now(timezone.utc)
        if cur.tzinfo is None:
            cur = cur.replace(tzinfo=timezone.utc)
        cur = cur.replace(second=0, microsecond=0) + timedelta(minutes=1)
        out: list[datetime] = []
        guard = 0
        while len(out) < count and guard < 60 * 24 * 8:
            if self.matches(cur):
                out.append(cur)
            cur += timedelta(minutes=1)
            guard += 1
        return out

    def next_run_ms(self, count: int = 1) -> int | None:
        runs = self.next_runs(count)
        return int(runs[0].timestamp() * 1000) if runs else None