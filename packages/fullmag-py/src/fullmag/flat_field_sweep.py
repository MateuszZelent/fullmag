"""mumax3-style field sweeps for flat scripts.

A mumax3 user writes a hysteresis loop as a plain loop::

    B = 0.0
    while B <= Bmax:
        fm.b_ext(B, 0, 0)
        fm.minimize()
        fm.tablesave()
        B += Bstep

Each ``minimize()`` captures one minimization stage. Run as hundreds of separate
stages this would cost one scheduled task per field point. Consecutive
``b_ext`` + ``minimize()`` + ``tablesave()`` stages that differ only in a
collinear uniform field are therefore folded into one hysteresis stage with the
same field points, the same minimizer settings, one table row per point, and the
start state left by the previous stage, so the script stays a mumax3 loop.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import TYPE_CHECKING, Sequence

from fullmag.model.energy import Zeeman
from fullmag.model.study import Hysteresis, MinimizeStep, Relaxation, SettlePipeline

if TYPE_CHECKING:
    from fullmag.model.problem import Problem
    from fullmag.world import CapturedStage

_MINIMIZE_ALGORITHMS = {"projected_gradient_bb"}


def coalesce_field_sweeps(stages: Sequence["CapturedStage"]) -> list["CapturedStage"]:
    """Fold each run of table-saved minimizations at collinear fields into one sweep."""
    folded: list[CapturedStage] = []
    sweep: list[CapturedStage] = []

    def flush() -> None:
        if sweep:
            folded.append(_sweep_stage(sweep))
            sweep.clear()

    for stage in stages:
        if not stage.table_save:
            flush()
            folded.append(stage)
            continue
        if not _is_minimization(stage.problem):
            raise ValueError(
                "tablesave() is supported after minimize() only; use tableautosave() for "
                "run() and relax() tables"
            )
        if sweep and not _same_sweep(sweep[0].problem, stage.problem):
            flush()
        sweep.append(stage)
        if _sweep_direction([*sweep]) is None:
            sweep.pop()
            flush()
            sweep.append(stage)
    flush()
    return folded


def _is_minimization(problem: "Problem") -> bool:
    study = problem.study
    return isinstance(study, Relaxation) and study.algorithm in _MINIMIZE_ALGORITHMS


def _uniform_field(problem: "Problem") -> tuple[float, float, float]:
    fields = [term.B for term in problem.energy if isinstance(term, Zeeman)]
    if len(fields) > 1:
        raise ValueError("a field-sweep point must have at most one uniform b_ext()")
    return fields[0] if fields else (0.0, 0.0, 0.0)


def _without_field(problem: "Problem") -> "Problem":
    return replace(problem, energy=[term for term in problem.energy if not isinstance(term, Zeeman)])


def _same_sweep(first: "Problem", other: "Problem") -> bool:
    """Same model and minimizer; only the uniform field may differ."""
    return _without_field(first) == _without_field(other)


def _sweep_direction(sweep: Sequence["CapturedStage"]) -> tuple[float, float, float] | None:
    """Unit direction shared by every nonzero field of the sweep (x when all are zero)."""
    direction = None
    for stage in sweep:
        B = _uniform_field(stage.problem)
        norm = math.sqrt(sum(component * component for component in B))
        if norm == 0.0:
            continue
        unit = tuple(component / norm for component in B)
        if direction is None:
            # A sweep keeps one axis orientation; the first field fixes its sign.
            direction = unit
            continue
        dot = sum(a * b for a, b in zip(direction, unit))
        if abs(abs(dot) - 1.0) > 1e-12:
            return None
    return direction or (1.0, 0.0, 0.0)


def _sweep_stage(sweep: Sequence["CapturedStage"]) -> "CapturedStage":
    first = sweep[0]
    study = first.problem.study
    assert isinstance(study, Relaxation)
    direction = _sweep_direction(sweep)
    assert direction is not None
    fields_mT = [
        1e3 * sum(a * b for a, b in zip(_uniform_field(stage.problem), direction)) for stage in sweep
    ]
    stop = study.stop
    minimize = MinimizeStep(
        method=study.algorithm,
        torque_tolerance=stop.torque_tolerance_apm,
        max_steps=stop.max_steps,
        on_non_convergence="continue_with_warning",
        **({"energy_tolerance": stop.energy_tolerance_j} if stop.energy_tolerance_j else {}),
    )
    hysteresis = Hysteresis(
        outputs=study.outputs,
        field_values_mT=fields_mT,
        direction=direction,
        initial_protocol="as_authored",
        settle_pipeline=SettlePipeline([minimize]),
    )
    return replace(
        first,
        problem=replace(_without_field(first.problem), study=hysteresis),
        entrypoint_kind="flat_hysteresis",
        default_until_seconds=None,
        table_save=False,
    )
