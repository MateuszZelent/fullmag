"""Isolation checks for the context-bound flat authoring API."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest

import fullmag as fm
import fullmag.world as world


def _names() -> tuple[str, ...]:
    return tuple(magnet._name for magnet in world._state._magnets)


def _add_body(name: str) -> None:
    fm.geometry(fm.Box(10e-9, 10e-9, 5e-9), name=name)


def test_nested_context_restores_outer_state_after_exception() -> None:
    fm.reset()
    _add_body("outer")
    outer_state = world._state.current()

    with pytest.raises(RuntimeError, match="inner failure"):
        with fm.execution_context() as inner:
            _add_body("inner")
            assert _names() == ("inner",)
            assert inner.state is world._state.current()
            assert inner.state is not outer_state
            raise RuntimeError("inner failure")

    assert _names() == ("outer",)


def test_async_tasks_fork_inherited_mutable_state() -> None:
    fm.reset()
    _add_body("parent")

    async def worker(name: str) -> tuple[str, ...]:
        # The task inherits the ContextVar binding, but the binding must fork
        # before this first mutation instead of sharing the parent's list.
        _add_body(name)
        await asyncio.sleep(0)
        return _names()

    async def run_workers() -> list[tuple[str, ...]]:
        return list(await asyncio.gather(worker("a"), worker("b")))

    assert sorted(asyncio.run(run_workers())) == [("a",), ("b",)]
    assert _names() == ("parent",)


def test_threads_get_independent_legacy_contexts() -> None:
    fm.reset()
    _add_body("parent")

    def worker(name: str) -> tuple[str, ...]:
        with fm.execution_context():
            _add_body(name)
            return _names()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, ("a", "b")))

    assert sorted(results) == [("a",), ("b",)]
    assert _names() == ("parent",)


def test_capture_state_is_restored_with_nested_context() -> None:
    fm.reset()
    world.begin_script_capture()
    try:
        assert world._capture_binding.current().enabled is True
        with pytest.raises(ValueError, match="nested capture failure"):
            with fm.execution_context():
                world.begin_script_capture()
                assert world._capture_binding.current().enabled is True
                raise ValueError("nested capture failure")
        assert world._capture_binding.current().enabled is True
    finally:
        world.finish_script_capture()


def test_handles_reject_mutation_after_their_context_is_closed() -> None:
    with fm.execution_context():
        layer = fm.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="owned")
        layer.Ms = 800e3
        layer.Aex = 13e-12
        region = layer.add_region("core", fm.Box(2e-9, 2e-9, 2e-9))

    with pytest.raises(RuntimeError, match="different authoring context"):
        layer.Ms = 900e3
    with pytest.raises(RuntimeError, match="different authoring context"):
        layer.m.set(fm.texture.uniform(0, 1, 0))
    with pytest.raises(RuntimeError, match="different authoring context"):
        layer.mesh(hmax=2e-9)
    with pytest.raises(RuntimeError, match="different authoring context"):
        region.set_material("Ms", 700e3)
    with pytest.raises(RuntimeError, match="different authoring context"):
        region.name = "stale"


def test_context_materialization_is_explicit_and_context_bound() -> None:
    with fm.execution_context() as context:
        layer = fm.geometry(fm.Box(10e-9, 10e-9, 5e-9), name="materialized")
        layer.Ms = 800e3
        layer.Aex = 13e-12
        problem = context.materialize_problem()
        assert problem.magnets[0].name == "materialized"

    with pytest.raises(RuntimeError, match="active authoring context"):
        context.materialize_problem()
