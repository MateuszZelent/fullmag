"""Parameter sweeps across several running Fullmag groups (ADR 0068 D5, spec §8).

The counterpart of Boris ``NSMultiClient``: every Docker DEV group (ADR 0067)
owns one ``current`` session, so ``fm.sweep`` runs one worker thread per group.
Each worker has its own authoring context and live connection, resets the
scene before every point and pulls the next point from a shared queue.
"""
from __future__ import annotations

import queue
import threading
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional, Sequence

__all__ = ["SweepError", "SweepResult", "sweep"]


@dataclass(frozen=True)
class SweepResult:
    index: int
    point: Mapping[str, Any]
    group: str
    value: Any = None
    run_id: Optional[str] = None
    error: Optional[BaseException] = field(default=None, compare=False)
    traceback: Optional[str] = field(default=None, repr=False, compare=False)

    @property
    def ok(self) -> bool:
        return self.error is None


class SweepError(RuntimeError):
    """One or more sweep points failed; ``results`` holds every point in order."""

    def __init__(self, results: list[SweepResult]) -> None:
        failed = [result for result in results if not result.ok]
        detail = "; ".join(f"#{r.index} on {r.group}: {type(r.error).__name__}: {r.error}" for r in failed[:5])
        super().__init__(f"{len(failed)} of {len(results)} sweep point(s) failed: {detail}")
        self.results = results


def sweep(
    function: Callable[..., Any],
    *,
    groups: Sequence[str],
    points: Optional[Sequence[Mapping[str, Any]]] = None,
    new_session: bool = False,
    raise_on_error: bool = True,
    token: Optional[str] = None,
    command_timeout: Optional[float] = None,
    connect_retry_s: float = 5.0,
    **parameters: Sequence[Any],
) -> list[SweepResult]:
    """Evaluate ``function(**point)`` for every point, spread over ``groups``.

    Points come from ``points=[{...}, ...]`` or from equal-length keyword
    lists (``H=[...], T=[...]``).  Before each point the worker's world is
    reset, so ``function`` builds the complete model with the ordinary DSL.
    Results are returned in point order with the group URL and run ID.
    A group that does not answer within ``connect_retry_s`` is skipped and the
    remaining groups take its points.
    """
    import fullmag as fm

    resolved = _points(points, parameters)
    if not groups:
        raise ValueError("fm.sweep() needs at least one group URL")
    if len(set(groups)) != len(groups):
        raise ValueError("fm.sweep() groups must be distinct: one group owns one current session")
    work: "queue.Queue[tuple[int, Mapping[str, Any]]]" = queue.Queue()
    for item in enumerate(resolved):
        work.put(item)
    results: list[Optional[SweepResult]] = [None] * len(resolved)
    connect_errors: dict[str, BaseException] = {}

    def worker(group: str) -> None:
        with fm.ExecutionContext():
            try:
                session = fm.connect(group, new_session=new_session, token=token, command_timeout=command_timeout, events=False, retry_budget_s=connect_retry_s)
            except BaseException as error:  # the group is unusable: other workers take its points
                connect_errors[group] = error
                return
            # The short budget only applies to reaching the group; later requests keep the default.
            session.client.transport.retry_budget_s = 60.0
            try:
                while True:
                    try:
                        index, point = work.get_nowait()
                    except queue.Empty:
                        return
                    try:
                        fm.reset()
                        value = function(**point)
                        results[index] = SweepResult(index, dict(point), group, value, _run_id(session))
                    except BaseException as error:
                        results[index] = SweepResult(index, dict(point), group, None, _run_id(session), error, traceback.format_exc())
            finally:
                fm.disconnect()

    threads = [threading.Thread(target=worker, args=(group,), name=f"fullmag-sweep-{i}", daemon=True) for i, group in enumerate(groups)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    final = [result for result in results if result is not None]
    if len(final) != len(resolved):
        missing = [index for index, result in enumerate(results) if result is None]
        reasons = "; ".join(f"{group}: {type(error).__name__}: {error}" for group, error in connect_errors.items())
        raise RuntimeError(f"fm.sweep() could not evaluate points {missing}; no group accepted them ({reasons})")
    if raise_on_error and any(not result.ok for result in final):
        raise SweepError(final)
    return final


def _points(points: Optional[Sequence[Mapping[str, Any]]], parameters: Mapping[str, Sequence[Any]]) -> list[Mapping[str, Any]]:
    if points is not None and parameters:
        raise ValueError("pass either points=[...] or keyword parameter lists, not both")
    if points is not None:
        return [dict(point) for point in points]
    if not parameters:
        raise ValueError("fm.sweep() needs points=[...] or keyword parameter lists")
    lengths = {name: len(values) for name, values in parameters.items()}
    if len(set(lengths.values())) != 1:
        raise ValueError(f"all parameter lists must have equal length, got {lengths}")
    count = next(iter(lengths.values()))
    return [{name: values[index] for name, values in parameters.items()} for index in range(count)]


def _run_id(session: Any) -> Optional[str]:
    try:
        run = session.client.simulation.current_run()
    except Exception:
        return None
    if isinstance(run, Mapping):
        value = run.get("run_id")
        return None if value is None else str(value)
    return None
