"""Zarr magnetization/field-state input in the MuMax3, fullmag-series and row layouts."""

from __future__ import annotations

import contextlib
import io
import json
import textwrap
from pathlib import Path

import numcodecs
import numpy as np
import pytest
import zarr

from fullmag.init import field_state_cli
from fullmag.init.state_io import (
    load_field_state,
    load_magnetization,
    resample_imported_field,
    save_field_state,
    save_magnetization,
    save_ovf,
)
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import rewrite_loaded_problem_script

# Distinct extents per axis, so any axis mix-up changes the result.
NX, NY, NZ = 4, 3, 2
DX, DY, DZ = 5e-9, 4e-9, 3e-9


def _frame(seed: float, nx: int = NX, ny: int = NY, nz: int = NZ) -> np.ndarray:
    """A [z, y, x, 3] float32 frame with a different unit vector in every cell."""
    iz, iy, ix = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing="ij")
    raw = np.stack([ix + 1.0 + seed, iy + 2.0, iz + 3.0 - seed], axis=-1)
    return (raw / np.linalg.norm(raw, axis=-1, keepdims=True)).astype(np.float32)


def _x_fastest_rows(frame: np.ndarray) -> list[tuple[float, float, float]]:
    nz, ny, nx, _ = frame.shape
    return [
        tuple(float(component) for component in frame[iz, iy, ix])
        for iz in range(nz)
        for iy in range(ny)
        for ix in range(nx)
    ]


def _mumax3_root_attrs(nx: int = NX, ny: int = NY, nz: int = NZ) -> dict[str, object]:
    return {
        "Nx": nx,
        "Ny": ny,
        "Nz": nz,
        "dx": DX,
        "dy": DY,
        "dz": DZ,
        "Tx": nx * DX,
        "Ty": ny * DY,
        "Tz": nz * DZ,
        "PBCx": 0,
        "PBCy": 0,
        "PBCz": 0,
        "Msat": "{800000}",
        "Aex": "{1.3e-11}",
        "engine": "mumax 3.12",
        "completion": "complete",
    }


def _write_mumax3_store(
    path: Path,
    arrays: dict[str, np.ndarray],
    *,
    root_attrs: dict[str, object] | None = None,
    table: bool = True,
) -> Path:
    """Write a store shaped like the MuMax3 Zarr fork's output (zarr v2, f4, zstd 1)."""
    root = zarr.open_group(str(path), mode="w")
    root.attrs.update(root_attrs if root_attrs is not None else _mumax3_root_attrs())
    for name, data in arrays.items():
        chunks = (1, *data.shape[1:]) if data.ndim == 5 else data.shape
        array = root.create_dataset(
            name,
            data=data,
            chunks=chunks,
            dtype="<f4",
            compressor=numcodecs.Zstd(level=1),
        )
        frames = data.shape[0] if data.ndim == 5 else 1
        array.attrs.update({"t": [float(index) * 1e-12 for index in range(frames)], "name": name})
    if table:
        group = root.create_group("table")
        for column in ("t", "mx", "my", "mz", "E_total", "maxTorque"):
            group.create_dataset(column, data=np.zeros(6), dtype="<f8")
    return path


def test_mumax3_store_matches_ovf_of_the_same_field(tmp_path: Path) -> None:
    frame = _frame(0.25)
    store = _write_mumax3_store(tmp_path / "film.zarr", {"m": frame[None]})
    expected = _x_fastest_rows(frame)

    zarr_state = load_magnetization(store, format="zarr")
    assert zarr_state.dataset == "m"
    assert zarr_state.values == expected

    for encoding in ("binary4", "binary8", "text"):
        ovf_path = save_ovf(
            tmp_path / f"m_{encoding}.ovf",
            expected,
            grid_shape=(NX, NY, NZ),
            grid_spacing=(DX, DY, DZ),
            encoding=encoding,
        )
        ovf_values = load_magnetization(ovf_path).values
        if encoding == "text":
            # save_ovf writes 16 significant digits, one short of a float64 round trip.
            np.testing.assert_allclose(ovf_values, zarr_state.values, rtol=0.0, atol=1e-15)
        else:
            assert ovf_values == zarr_state.values

    ovf_field = load_field_state(tmp_path / "m_binary8.ovf")
    zarr_field = load_field_state(store)
    assert zarr_field.values == ovf_field.values
    assert zarr_field.quantity_id == "m"
    assert zarr_field.grid_shape == ovf_field.grid_shape == (NX, NY, NZ)
    assert zarr_field.grid_spacing == ovf_field.grid_spacing == (DX, DY, DZ)
    assert zarr_field.grid_origin == ovf_field.grid_origin == (0.0, 0.0, 0.0)
    # The MuMax3 store records no origin; OVF headers always carry xmin/ymin/zmin.
    assert zarr_field.origin_explicit is False
    assert ovf_field.origin_explicit is True


def test_mumax3_dataset_and_sample_selection(tmp_path: Path) -> None:
    frames = np.stack([_frame(0.0), _frame(0.5), _frame(1.0)])
    store = _write_mumax3_store(tmp_path / "relax.zarr", {"m_relaxed": frames})

    # A single custom-named field array is found without dataset=.
    latest = load_magnetization(store, format="zarr")
    assert latest.dataset == "m_relaxed"
    assert latest.sample_index is None
    assert latest.values == _x_fastest_rows(frames[-1])

    for sample in (0, 1, 2):
        state = load_magnetization(store, format="zarr", dataset="m_relaxed", sample=sample)
        assert state.values == _x_fastest_rows(frames[sample])
        assert state.sample_index == sample
    with pytest.raises(IndexError, match="out of range for 3 samples"):
        load_magnetization(store, format="zarr", sample=3)

    # The array directory itself, with and without an explicit format.
    for fmt in ("zarr", "auto"):
        direct = load_magnetization(store / "m_relaxed", format=fmt, sample=1)
        assert direct.values == _x_fastest_rows(frames[1])
        assert direct.dataset == ""
    direct_field = load_field_state(store / "m_relaxed", format="zarr")
    assert direct_field.grid_shape == (NX, NY, NZ)
    assert direct_field.grid_spacing == (DX, DY, DZ)
    assert direct_field.quantity_id == "m_relaxed"
    with pytest.raises(ValueError, match="points directly at a Zarr array"):
        load_magnetization(store / "m_relaxed", format="zarr", dataset="m_relaxed")

    # Two field arrays and no preferred name: refuse to guess.
    two = _write_mumax3_store(
        tmp_path / "two.zarr", {"m_relaxed": frames, "B_ext": frames[:1]}
    )
    with pytest.raises(ValueError, match="several candidate state arrays"):
        load_magnetization(two, format="zarr")
    assert load_magnetization(two, format="zarr", dataset="B_ext").values == _x_fastest_rows(frames[0])


def test_mumax3_single_frame_zyxc_array(tmp_path: Path) -> None:
    frame = _frame(0.75)
    store = _write_mumax3_store(tmp_path / "single.zarr", {"m": frame}, table=False)
    assert load_magnetization(store).values == _x_fastest_rows(frame)
    assert load_magnetization(store, sample=0).values == _x_fastest_rows(frame)
    assert load_field_state(store).grid_shape == (NX, NY, NZ)
    with pytest.raises(IndexError, match="no time axis"):
        load_magnetization(store, sample=1)


def test_mumax3_grid_attributes_must_match_the_array(tmp_path: Path) -> None:
    frame = _frame(0.0)
    swapped = {**_mumax3_root_attrs(), "Nx": NY, "Ny": NX}
    store = _write_mumax3_store(tmp_path / "swapped.zarr", {"m": frame[None]}, root_attrs=swapped)
    with pytest.raises(ValueError, match="declares Nx=3"):
        load_magnetization(store)

    wrong_extent = {**_mumax3_root_attrs(), "Tx": 2 * NX * DX}
    store = _write_mumax3_store(tmp_path / "extent.zarr", {"m": frame[None]}, root_attrs=wrong_extent)
    with pytest.raises(ValueError, match="Tx=.* does not equal Nx \\* dx"):
        load_field_state(store)

    two_components = np.zeros((1, NZ, NY, NX, 2), dtype=np.float32)
    store = _write_mumax3_store(tmp_path / "two_c.zarr", {"m": two_components}, table=False)
    with pytest.raises(ValueError, match="must have 1 or 3 entries"):
        load_field_state(store, dataset="m")

    # Spacing from Tx/Ty/Tz when the cell size is not recorded.
    extent_only = {key: value for key, value in _mumax3_root_attrs().items() if key not in {"dx", "dy", "dz"}}
    store = _write_mumax3_store(tmp_path / "extent_only.zarr", {"m": frame[None]}, root_attrs=extent_only)
    assert load_field_state(store).grid_spacing == pytest.approx((DX, DY, DZ), rel=1e-12)


def test_shape_mismatch_with_the_target_grid_is_an_error(tmp_path: Path) -> None:
    store = _write_mumax3_store(tmp_path / "film.zarr", {"m": _frame(0.0)[None]})
    state = load_field_state(store)
    target_points = np.zeros((NX * NY * NZ, 3))
    # Same vector count, different grid: exact import must not reinterpret the cells.
    with pytest.raises(ValueError, match="exact interpolation grid mismatch"):
        resample_imported_field(
            state, target_points, interpolation="exact", target_grid_shape=(NY, NX, NZ)
        )
    with pytest.raises(ValueError, match="requires source count"):
        resample_imported_field(state, np.zeros((5, 3)), interpolation="exact")
    exact = resample_imported_field(
        state, target_points, interpolation="exact", target_grid_shape=(NX, NY, NZ)
    )
    assert exact.shape == (NX * NY * NZ, 3)


def test_scalar_mumax3_field_and_explicit_origin(tmp_path: Path) -> None:
    scalar = np.arange(NX * NY * NZ, dtype=np.float32).reshape((1, NZ, NY, NX, 1))
    attrs = {**_mumax3_root_attrs(), "origin": [-1e-8, -6e-9, -3e-9]}
    store = _write_mumax3_store(tmp_path / "regions.zarr", {"regions": scalar}, root_attrs=attrs)
    field = load_field_state(store)
    assert field.component_count == 1
    assert field.quantity_id == "regions"
    assert [row[0] for row in field.values] == list(range(NX * NY * NZ))
    assert field.grid_origin == (-1e-8, -6e-9, -3e-9)
    assert field.origin_explicit is True
    with pytest.raises(ValueError, match="does not contain a suitable magnetization dataset"):
        load_magnetization(store)
    with pytest.raises(ValueError, match="requires 3 components"):
        load_magnetization(store, dataset="regions")

    vector_store = _write_mumax3_store(tmp_path / "m.zarr", {"m": _frame(0.0)[None]})
    override = load_field_state(vector_store, source_origin=(1e-9, 2e-9, 3e-9))
    assert override.grid_origin == (1e-9, 2e-9, 3e-9)
    assert override.origin_explicit is True


def test_row_layouts_keep_loading(tmp_path: Path) -> None:
    vectors = [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
    for name in ("state.zarr", "state.zarr.zip"):
        path = save_magnetization(tmp_path / name, vectors)
        loaded = load_magnetization(path)
        assert loaded.values == vectors
        assert loaded.dataset == "values"

    series = np.asarray([[[1.0, 0.0, 0.0]] * 2, [[0.0, 0.0, 1.0]] * 2])
    root = zarr.open_group(str(tmp_path / "rows.zarr"), mode="w")
    root.create_dataset("m", data=series)
    root.create_dataset("flat", data=np.asarray([0.0, 1.0, 0.0, 0.0, 0.0, 1.0]))
    assert load_magnetization(tmp_path / "rows.zarr").values == [(0.0, 0.0, 1.0)] * 2
    assert load_magnetization(tmp_path / "rows.zarr", sample=0).values == [(1.0, 0.0, 0.0)] * 2
    assert load_magnetization(tmp_path / "rows.zarr", dataset="flat").values == [
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
    ]
    flat_field = load_field_state(tmp_path / "rows.zarr", dataset="flat")
    assert flat_field.component_count == 1

    field_path = save_field_state(tmp_path / "h.zarr", vectors, quantity="H_eff", target_id="film")
    field = load_field_state(field_path)
    assert (field.quantity_id, field.target_id, field.dataset) == ("H_eff", "film", "fields/H_eff")
    assert field.values == vectors
    assert field.grid_shape is None and field.grid_origin is None and field.origin_explicit is False


def test_fullmag_field_series_loads_component_major_with_its_grid(tmp_path: Path) -> None:
    first, last = _frame(0.0), _frame(0.5)
    rows = np.stack([np.asarray(_x_fastest_rows(frame)) for frame in (first, last)])
    component_major = np.ascontiguousarray(rows.transpose(0, 2, 1))  # [sample, component, cell]
    series = zarr.open_array(str(tmp_path / "m.zarr"), mode="w", shape=component_major.shape,
                             chunks=(1, 3, NX * NY * NZ), dtype="<f8")
    series[:] = component_major
    series.attrs.update({
        "observable": "m",
        "unit": "1",
        "axes": ["sample", "component", "cell"],
        "component_count": 3,
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "location": "sample",
        "layout": {
            "backend": "fdm",
            "grid_cells": [NX, NY, NZ],
            "cell_size": [DX, DY, DZ],
            "origin_m": [-1e-8, -6e-9, -3e-9],
        },
    })
    assert load_magnetization(tmp_path / "m.zarr").values == _x_fastest_rows(last)
    field = load_field_state(tmp_path / "m.zarr", sample=0)
    assert field.values == _x_fastest_rows(first)
    assert field.quantity_id == "m"
    assert field.units == "1"
    assert field.grid_shape == (NX, NY, NZ)
    assert field.grid_spacing == (DX, DY, DZ)
    assert field.grid_origin == (-1e-8, -6e-9, -3e-9)
    assert field.origin_explicit is True


def test_fullmag_stage_autosave_array_is_rejected_not_guessed(tmp_path: Path) -> None:
    root = zarr.open_group(str(tmp_path / "main.zarr"), mode="w")
    root.attrs.update({"schema_version": "fullmag.stage_autosave.v1", "target": "main"})
    stage = root.require_group("stages").require_group("stage_0000_run")
    field = stage.require_group("fields").create_dataset("m", data=np.zeros((2, 3 * 4)))
    field.attrs.update({"quantity": "m", "dimension_order": ["sample", "value"]})
    # A three-column table must never be mistaken for magnetization rows.
    table = stage.create_dataset("table", data=np.ones((5, 3)))
    table.attrs.update({"quantities": ["t", "E", "torque"], "dimension_order": ["sample", "quantity"]})
    with pytest.raises(ValueError, match="stage-autosave array"):
        load_magnetization(tmp_path / "main.zarr")
    with pytest.raises(ValueError, match="stage-autosave array"):
        load_field_state(tmp_path / "main.zarr", dataset="stages/stage_0000_run/fields/m")
    with pytest.raises(ValueError, match="scalar table"):
        load_field_state(tmp_path / "main.zarr", dataset="stages/stage_0000_run/table")


def test_field_state_cli_reports_the_mumax3_grid(tmp_path: Path) -> None:
    store = _write_mumax3_store(tmp_path / "film.zarr", {"m": _frame(0.0)[None]})
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        assert field_state_cli.main([str(store)]) == 0
    payload = json.loads(stdout.getvalue())
    assert payload["quantity_id"] == "m"
    assert payload["component_count"] == 3
    assert len(payload["values"]) == NX * NY * NZ
    assert payload["grid_shape"] == [NX, NY, NZ]
    assert payload["grid_spacing"] == [DX, DY, DZ]
    assert payload["grid_origin"] == [0.0, 0.0, 0.0]
    assert payload["origin_explicit"] is False


def test_study_loadfile_of_a_mumax3_store_lowers_to_sampled_field(tmp_path: Path) -> None:
    frame = _frame(0.25, nx=6, ny=4, nz=2)
    _write_mumax3_store(
        tmp_path / "relaxed.zarr",
        {"m_relaxed": frame[None]},
        root_attrs={**_mumax3_root_attrs(6, 4, 2), "dx": 5e-9, "dy": 5e-9, "dz": 5e-9,
                    "Tx": 30e-9, "Ty": 20e-9, "Tz": 10e-9},
    )
    script = tmp_path / "film.py"
    script.write_text(
        textwrap.dedent(
            """
            import fullmag as fm

            study = fm.study("film_from_mumax3")
            study.engine("fdm")
            study.device("cpu", precision="double")
            study.mode("strict")
            study.cell(5e-9, 5e-9, 5e-9)
            film = study.geometry(fm.Box(size=(30e-9, 20e-9, 10e-9), name="film"), name="film")
            film.Ms = 800e3
            film.Aex = 13e-12
            film.alpha = 0.02
            film.m.loadfile("relaxed.zarr", format="zarr", dataset="m_relaxed")
            study.exchange()
            study.stages.add_relax(stage_id="relax", dt=1e-13, max_steps=10)
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(script, lightweight_assets=True)
    initial = loaded.problem.to_ir()["magnets"][0]["initial_magnetization"]
    assert initial["kind"] == "sampled_field"
    assert len(initial["values"]) == 6 * 4 * 2
    assert [tuple(value) for value in initial["values"]] == _x_fastest_rows(frame)

    rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]
    assert 'film.m.loadfile("relaxed.zarr", format="zarr", dataset="m_relaxed")' in rewritten
