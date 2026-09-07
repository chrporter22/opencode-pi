"""Tiny in-process event bus for the live serving layer.

Everything analytics surfaces is live-update-capable: window scores, PCA
summaries, training trials. Producers call emit(); SSE streams and the
gateway WS fan-out subscribe.
"""

from __future__ import annotations

import threading
from typing import Callable


class EventBus:
    def __init__(self) -> None:
        self._subs: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()

    def subscribe(self, cb: Callable[[dict], None]) -> Callable[[], None]:
        with self._lock:
            self._subs.append(cb)
        return lambda: self._unsubscribe(cb)

    def _unsubscribe(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            if cb in self._subs:
                self._subs.remove(cb)

    def emit(self, payload: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for cb in subs:
            try:
                cb(payload)
            except Exception:  # noqa: BLE001
                continue


def event(payload: dict, _type: str | None = None) -> dict:
    if _type is not None:
        payload = dict(payload)
        payload["type"] = _type
    return payload