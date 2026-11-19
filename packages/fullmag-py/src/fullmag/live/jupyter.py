"""Notebook helpers for live sessions (``fullmag[jupyter]``, spec python-live-client-v1 §7).

``fm.live.jupyter.monitor()`` subscribes to ``scalar.sample`` events and keeps
one notebook output up to date: a matplotlib plot when matplotlib is
installed, otherwise a compact text table.  Without IPython the monitor still
collects samples, so scripts can read ``monitor.samples`` in a terminal.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Sequence

from . import require_session

__all__ = ["ScalarMonitor", "monitor"]


@dataclass
class ScalarMonitor:
    columns: tuple[str, ...]
    x_column: str = "time"
    min_interval_s: float = 0.25
    max_samples: int = 20_000
    samples: list[dict[str, float]] = field(default_factory=list)
    _subscription: Any = None
    _display: Any = None
    _last_render: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def start(self) -> "ScalarMonitor":
        session = require_session("live.jupyter.monitor")
        self._display = _display_handle()
        self._subscription = session.on("scalar.sample", self._on_sample)
        return self

    def stop(self) -> None:
        if self._subscription is not None:
            self._subscription.cancel()
            self._subscription = None
        self.render(force=True)

    def _on_sample(self, event: Any) -> None:
        row = event.payload.get("row") or {}
        if not isinstance(row, dict):
            return
        sample = {key: float(value) for key, value in row.items() if isinstance(value, (int, float))}
        with self._lock:
            self.samples.append(sample)
            if len(self.samples) > self.max_samples:
                del self.samples[: len(self.samples) - self.max_samples]
        self.render()

    def render(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if self._display is None or (not force and now - self._last_render < self.min_interval_s):
            return
        self._last_render = now
        with self._lock:
            samples = list(self.samples)
        self._display.update(_figure_or_table(samples, self.x_column, self.columns))


def monitor(columns: Sequence[str] = ("mx", "my", "mz"), *, x_column: str = "time", min_interval_s: float = 0.25) -> ScalarMonitor:
    """Show live scalar samples of the connected session in the current notebook cell."""
    return ScalarMonitor(tuple(columns), x_column=x_column, min_interval_s=min_interval_s).start()


def _display_handle() -> Any:
    try:
        from IPython import get_ipython
        from IPython.display import display
    except ImportError:
        return None
    if get_ipython() is None:
        return None
    return display("waiting for scalar samples…", display_id=True)


def _figure_or_table(samples: list[dict[str, float]], x_column: str, columns: tuple[str, ...]) -> Any:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return _table(samples, x_column, columns)
    figure, axis = plt.subplots(figsize=(6, 3))
    xs = [sample.get(x_column, index) for index, sample in enumerate(samples)]
    for column in columns:
        axis.plot(xs, [sample.get(column, float("nan")) for sample in samples], label=column)
    axis.set_xlabel(x_column)
    axis.legend(loc="best")
    figure.tight_layout()
    plt.close(figure)
    return figure


def _table(samples: list[dict[str, float]], x_column: str, columns: tuple[str, ...]) -> str:
    header = "  ".join(f"{name:>14}" for name in (x_column, *columns))
    rows = [
        "  ".join(f"{sample.get(name, float('nan')):>14.6g}" for name in (x_column, *columns))
        for sample in samples[-10:]
    ]
    return "\n".join([header, *rows]) if rows else "waiting for scalar samples…"
