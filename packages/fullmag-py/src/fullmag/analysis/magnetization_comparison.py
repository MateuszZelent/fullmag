"""Quantitative comparison of final MuMax3 and Fullmag magnetization states."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np


class MagnetizationComparisonError(ValueError):
    """Raised when a comparison artifact violates its declared contract."""


def _vector3(value: Sequence[float], label: str) -> tuple[float, float, float]:
    array = np.asarray(value, dtype=np.float64)
    if array.shape != (3,) or not np.all(np.isfinite(array)):
        raise ValueError(f"{label} must contain three finite values")
    return tuple(float(component) for component in array)


@dataclass(frozen=True, slots=True)
class CartesianGrid:
    """Uniform Cartesian grid with Fullmag/MuMax axis order ``(z, y, x)``."""

    shape_zyx: tuple[int, int, int]
    bounds_min_xyz: tuple[float, float, float]
    bounds_max_xyz: tuple[float, float, float]

    def __post_init__(self) -> None:
        shape = tuple(int(value) for value in self.shape_zyx)
        if len(shape) != 3 or any(value <= 0 for value in shape):
            raise ValueError("shape_zyx must contain three positive integers")
        minimum = _vector3(self.bounds_min_xyz, "bounds_min_xyz")
        maximum = _vector3(self.bounds_max_xyz, "bounds_max_xyz")
        if any(upper <= lower for lower, upper in zip(minimum, maximum)):
            raise ValueError("Cartesian bounds must have positive extent")
        object.__setattr__(self, "shape_zyx", shape)
        object.__setattr__(self, "bounds_min_xyz", minimum)
        object.__setattr__(self, "bounds_max_xyz", maximum)

    @property
    def cell_size_xyz(self) -> tuple[float, float, float]:
        return tuple(
            (upper - lower) / count
            for lower, upper, count in zip(
                self.bounds_min_xyz,
                self.bounds_max_xyz,
                (self.shape_zyx[2], self.shape_zyx[1], self.shape_zyx[0]),
            )
        )

    @property
    def voxel_volume(self) -> float:
        dx, dy, dz = self.cell_size_xyz
        return dx * dy * dz

    @property
    def voxel_count(self) -> int:
        return int(np.prod(self.shape_zyx))

    def to_dict(self) -> dict[str, object]:
        return {
            "shape_zyx": list(self.shape_zyx),
            "bounds_min_xyz": list(self.bounds_min_xyz),
            "bounds_max_xyz": list(self.bounds_max_xyz),
            "cell_size_xyz": list(self.cell_size_xyz),
            "voxel_volume_m3": self.voxel_volume,
            "axis_order": "zyx",
        }


def _masked_values(values: object) -> np.ma.MaskedArray:
    array = np.asanyarray(values, dtype=np.float64)
    if array.ndim != 5 or array.shape[-1] != 3:
        raise MagnetizationComparisonError(
            "magnetization texture must have shape (t,z,y,x,component) with three components"
        )
    mask = np.ma.getmaskarray(array)
    data = np.asarray(np.ma.getdata(array), dtype=np.float64)
    if not np.all(np.isfinite(data[~mask])):
        raise MagnetizationComparisonError("magnetization texture contains non-finite values")
    return np.ma.array(data, mask=mask, copy=False)


def _validate_vector_norms(values: object, label: str) -> None:
    array = np.asanyarray(values, dtype=np.float64)
    mask = np.ma.getmaskarray(array)
    data = np.asarray(np.ma.getdata(array), dtype=np.float64)
    valid = ~np.any(mask, axis=-1)
    if np.any(np.linalg.norm(data[valid], axis=-1) > 1.0 + 1.0e-5):
        raise MagnetizationComparisonError(
            f"{label} contains vectors with norm greater than one"
        )


@dataclass(frozen=True, slots=True)
class StructuredMagnetization:
    """A reduced-magnetization texture in the canonical ``(t,z,y,x,c)`` layout."""

    values: np.ma.MaskedArray
    times: np.ndarray
    grid: CartesianGrid
    source_path: str | None = None
    dataset: str = "m"
    metadata: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        values = _masked_values(self.values)
        if values.shape[1:4] != self.grid.shape_zyx:
            raise MagnetizationComparisonError(
                "texture spatial shape does not match the declared Cartesian grid"
            )
        times = np.asarray(self.times, dtype=np.float64).reshape(-1)
        if times.shape != (values.shape[0],) or not np.all(np.isfinite(times)):
            raise MagnetizationComparisonError(
                "texture times must contain one finite value per stored frame"
            )
        object.__setattr__(self, "values", values)
        object.__setattr__(self, "times", times)
        object.__setattr__(self, "metadata", dict(self.metadata))

    @property
    def frame_count(self) -> int:
        return int(self.values.shape[0])

    @property
    def final_values(self) -> np.ma.MaskedArray:
        return self.values[-1]

    def require_single_final_frame(self) -> None:
        if self.frame_count != 1:
            raise MagnetizationComparisonError(
                "comparison requires exactly one final frame; found "
                f"{self.frame_count}. Re-run MuMax3 with save(m) after minimize()."
            )

    def to_dict(self) -> dict[str, object]:
        return {
            "source_path": self.source_path,
            "dataset": self.dataset,
            "frame_count": self.frame_count,
            "times_s": self.times.tolist(),
            "grid": self.grid.to_dict(),
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True, slots=True)
class FEMMagnetizationState:
    """Fullmag final nodal magnetization plus its persisted FEM mesh."""

    values: np.ndarray
    mesh: Any
    source_path: str
    mesh_path: str
    dataset: str
    topology_fingerprint: str
    source_fingerprint: str
    run_bundle_path: str | None = None
    run_bundle_fingerprint: str | None = None

    def __post_init__(self) -> None:
        values = np.asanyarray(self.values, dtype=np.float64)
        if values.ndim != 2 or values.shape[1] != 3:
            raise MagnetizationComparisonError("Fullmag state must have shape (node, component)")
        if not np.all(np.isfinite(values)):
            raise MagnetizationComparisonError("Fullmag state contains non-finite values")
        _validate_vector_norms(values, "Fullmag state")
        if values.shape[0] != int(self.mesh.n_nodes):
            raise MagnetizationComparisonError(
                "Fullmag state node count does not match the persisted FEM mesh"
            )
        object.__setattr__(self, "values", values)

    def to_dict(self) -> dict[str, object]:
        return {
            "source_path": self.source_path,
            "mesh_path": self.mesh_path,
            "dataset": self.dataset,
            "node_count": int(self.values.shape[0]),
            "topology_fingerprint": self.topology_fingerprint,
            "source_fingerprint": self.source_fingerprint,
            "run_bundle_path": self.run_bundle_path,
            "run_bundle_fingerprint": self.run_bundle_fingerprint,
        }


@dataclass(frozen=True, slots=True)
class MagnetizationComparison:
    """Metrics for two final textures on one common masked grid."""

    grid: CartesianGrid
    valid_voxel_count: int
    component: dict[str, dict[str, float]]
    vector: dict[str, float]
    mean_left: tuple[float, float, float]
    mean_right: tuple[float, float, float]
    mean_difference: tuple[float, float, float]
    integral_left: tuple[float, float, float]
    integral_right: tuple[float, float, float]
    valid_fraction: float

    def to_dict(self) -> dict[str, object]:
        return {
            "grid": self.grid.to_dict(),
            "valid_voxel_count": self.valid_voxel_count,
            "valid_fraction": self.valid_fraction,
            "component": self.component,
            "vector": self.vector,
            "mean_left": list(self.mean_left),
            "mean_right": list(self.mean_right),
            "mean_difference": list(self.mean_difference),
            "integral_left": list(self.integral_left),
            "integral_right": list(self.integral_right),
        }


def _source_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.read_bytes())
    elif path.is_dir():
        for child in sorted(item for item in path.rglob("*") if item.is_file()):
            digest.update(str(child.relative_to(path)).encode("utf-8"))
            digest.update(child.read_bytes())
    else:
        raise FileNotFoundError(path)
    return f"sha256:{digest.hexdigest()}"


def _jsonish(value: object) -> object:
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def _zarr_store(path: Path, mode: str) -> tuple[Any, Any]:
    try:
        import zarr
        from zarr.storage import ZipStore
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("MuMax3 Zarr comparison requires zarr") from exc
    if path.name.lower().endswith(".zarr.zip") or path.suffix.lower() == ".zip":
        return zarr, ZipStore(str(path), mode=mode)
    try:
        from zarr.storage import DirectoryStore
    except ImportError:
        from zarr.storage import LocalStore as DirectoryStore
    if getattr(DirectoryStore, "__name__", "") == "LocalStore":
        return zarr, DirectoryStore(str(path), read_only=mode == "r")
    return zarr, DirectoryStore(str(path))


def _find_dataset(root: Any, dataset: str) -> tuple[Any, str]:
    if dataset:
        try:
            return root[dataset], dataset
        except Exception as exc:
            raise MagnetizationComparisonError(
                f"MuMax3 Zarr bundle does not contain dataset {dataset!r}"
            ) from exc
    for candidate in ("m", "magnetization", "values"):
        try:
            return root[candidate], candidate
        except Exception:
            continue
    raise MagnetizationComparisonError("MuMax3 Zarr bundle has no magnetization dataset")


def _grid_from_mumax_attrs(shape: tuple[int, int, int, int, int], attrs: Mapping[str, object]) -> CartesianGrid:
    _, nz, ny, nx, _ = shape
    dimensions = (
        int(_jsonish(attrs.get("Nz", nz))),
        int(_jsonish(attrs.get("Ny", ny))),
        int(_jsonish(attrs.get("Nx", nx))),
    )
    if dimensions != (nz, ny, nx):
        raise MagnetizationComparisonError(
            f"MuMax3 grid attributes {dimensions} disagree with m shape {(nz, ny, nx)}"
        )
    extents = tuple(
        float(_jsonish(attrs[key]))
        for key in ("Tx", "Ty", "Tz")
        if key in attrs
    )
    if len(extents) != 3 or any(value <= 0.0 or not np.isfinite(value) for value in extents):
        raise MagnetizationComparisonError(
            "MuMax3 Zarr must declare positive Tx, Ty, and Tz extents"
        )
    minimum = attrs.get("bounds_min_xyz")
    maximum = attrs.get("bounds_max_xyz")
    if minimum is not None and maximum is not None:
        bounds_min = _vector3(_jsonish(minimum), "bounds_min_xyz")
        bounds_max = _vector3(_jsonish(maximum), "bounds_max_xyz")
    else:
        origin = attrs.get("origin_xyz", attrs.get("origin", (0.0, 0.0, 0.0)))
        center = _vector3(_jsonish(origin), "origin_xyz")
        bounds_min = tuple(center[index] - extents[index] / 2.0 for index in range(3))
        bounds_max = tuple(center[index] + extents[index] / 2.0 for index in range(3))
    return CartesianGrid(
        shape_zyx=(nz, ny, nx),
        bounds_min_xyz=bounds_min,
        bounds_max_xyz=bounds_max,
    )


def load_mumax_magnetization(
    path: str | Path,
    *,
    dataset: str = "m",
    require_single_frame: bool = False,
) -> StructuredMagnetization:
    """Load MuMax3's final-field Zarr contract without reshaping away axes."""

    source = Path(path)
    zarr, store = _zarr_store(source, "r")
    try:
        root = zarr.open(store=store, mode="r")
        target, dataset_path = _find_dataset(root, dataset)
        values = np.asanyarray(target)
        if values.ndim != 5 or values.shape[-1] != 3:
            raise MagnetizationComparisonError(
                "MuMax3 m must have shape (t,z,y,x,component) with three components"
            )
        _validate_vector_norms(values, "MuMax3 m")
        root_attrs = {str(key): _jsonish(root.attrs[key]) for key in root.attrs}
        target_attrs = {str(key): _jsonish(target.attrs[key]) for key in target.attrs}
    finally:
        store.close()
    attrs = {**root_attrs, **target_attrs}
    component_order = attrs.get("component_order", ["x", "y", "z"])
    if list(component_order) != ["x", "y", "z"]:
        raise MagnetizationComparisonError(
            f"unsupported MuMax3 component order {component_order!r}; expected x,y,z"
        )
    grid = _grid_from_mumax_attrs(tuple(int(value) for value in values.shape), attrs)
    raw_times = attrs.get("t", attrs.get("time"))
    if raw_times is None:
        times = np.arange(values.shape[0], dtype=np.float64)
    else:
        times = np.asarray(_jsonish(raw_times), dtype=np.float64).reshape(-1)
    texture = StructuredMagnetization(
        values=np.ma.asanyarray(values),
        times=times,
        grid=grid,
        source_path=str(source),
        dataset=dataset_path,
        metadata={
            "solver": "mumax3",
            "axis_order": "tzyxc",
            "component_order": ["x", "y", "z"],
            "source_fingerprint": _source_fingerprint(source),
            **attrs,
        },
    )
    if require_single_frame:
        texture.require_single_final_frame()
    return texture


def load_fullmag_fem_magnetization(
    state_path: str | Path,
    *,
    mesh_path: str | Path,
    run_bundle: str | Path | None = None,
    dataset: str = "m",
) -> FEMMagnetizationState:
    """Load Fullmag's post-relaxation ``(node, component)`` state artifact."""

    from fullmag.init.state_io import load_magnetization
    from fullmag.meshing.persistence import load_mesh_artifact

    state_source = Path(state_path)
    mesh_source = Path(mesh_path)
    sampled = load_magnetization(state_source, format="zarr", dataset=dataset)
    values = np.asarray(sampled.values, dtype=np.float64)
    mesh_artifact = load_mesh_artifact(mesh_source)
    run_bundle_path = None
    run_bundle_fingerprint = None
    if run_bundle is not None:
        run_bundle_source = Path(run_bundle)
        if not run_bundle_source.exists():
            raise FileNotFoundError(run_bundle)
        run_bundle_path = str(run_bundle_source)
        run_bundle_fingerprint = _source_fingerprint(run_bundle_source)
    return FEMMagnetizationState(
        values=values,
        mesh=mesh_artifact.mesh,
        source_path=str(state_source),
        mesh_path=str(mesh_source),
        dataset=dataset,
        topology_fingerprint=mesh_artifact.topology_fingerprint,
        source_fingerprint=_source_fingerprint(state_source),
        run_bundle_path=run_bundle_path,
        run_bundle_fingerprint=run_bundle_fingerprint,
    )


def _final_values(value: object, *, require_single_frame: bool) -> np.ma.MaskedArray:
    if isinstance(value, StructuredMagnetization):
        if require_single_frame:
            value.require_single_final_frame()
        return np.ma.asanyarray(value.final_values)[np.newaxis, ...]
    array = _masked_values(value)
    if require_single_frame and array.shape[0] != 1:
        raise MagnetizationComparisonError(
            "comparison requires exactly one final frame; provide one (t,z,y,x,c) frame"
        )
    return array[-1:]


def _grid_for_comparison(left: object, right: object, grid: CartesianGrid | None) -> CartesianGrid:
    if grid is not None:
        return grid
    left_grid = getattr(left, "grid", None)
    right_grid = getattr(right, "grid", None)
    if not isinstance(left_grid, CartesianGrid) or not isinstance(right_grid, CartesianGrid):
        raise MagnetizationComparisonError("grid is required when comparing raw arrays")
    if left_grid != right_grid:
        raise MagnetizationComparisonError("textures use different Cartesian grids")
    return left_grid


def compare_magnetization_textures(
    left: object,
    right: object,
    *,
    grid: CartesianGrid | None = None,
    high_error_threshold: float = 1.0e-3,
    require_single_frame: bool = True,
) -> MagnetizationComparison:
    """Compare two reduced-magnetization textures on their common valid mask."""

    if not np.isfinite(high_error_threshold) or high_error_threshold < 0.0:
        raise ValueError("high_error_threshold must be finite and non-negative")
    resolved_grid = _grid_for_comparison(left, right, grid)
    left_values = _final_values(left, require_single_frame=require_single_frame)[0]
    right_values = _final_values(right, require_single_frame=require_single_frame)[0]
    if left_values.shape != right_values.shape or left_values.shape[:3] != resolved_grid.shape_zyx:
        raise MagnetizationComparisonError("texture shapes do not match the comparison grid")
    left_data = np.asarray(np.ma.getdata(left_values), dtype=np.float64)
    right_data = np.asarray(np.ma.getdata(right_values), dtype=np.float64)
    valid = ~np.any(np.ma.getmaskarray(left_values), axis=-1)
    valid &= ~np.any(np.ma.getmaskarray(right_values), axis=-1)
    valid &= np.all(np.isfinite(left_data), axis=-1)
    valid &= np.all(np.isfinite(right_data), axis=-1)
    count = int(np.count_nonzero(valid))
    if count == 0:
        raise MagnetizationComparisonError("textures have no common valid voxels")
    left_flat = left_data[valid]
    right_flat = right_data[valid]
    difference = right_flat - left_flat
    component: dict[str, dict[str, float]] = {}
    for index, name in enumerate(("x", "y", "z")):
        error = np.abs(difference[:, index])
        component[name] = {
            "mae": float(np.mean(error)),
            "rms": float(np.sqrt(np.mean(np.square(difference[:, index])))),
            "max": float(np.max(error)),
            "p99": float(np.percentile(error, 99.0)),
        }
    vector_error = np.linalg.norm(difference, axis=1)
    dot = float(np.sum(left_flat * right_flat))
    denominator = float(np.linalg.norm(left_flat) * np.linalg.norm(right_flat))
    vector = {
        "rms": float(np.sqrt(np.mean(np.square(vector_error)))),
        "max": float(np.max(vector_error)),
        "p99": float(np.percentile(vector_error, 99.0)),
        "cosine_similarity": dot / denominator if denominator > 0.0 else 0.0,
        "fraction_above_threshold": float(np.mean(vector_error > high_error_threshold)),
        "high_error_threshold": float(high_error_threshold),
    }
    voxel_volume = resolved_grid.voxel_volume
    left_integral = np.sum(left_flat, axis=0) * voxel_volume
    right_integral = np.sum(right_flat, axis=0) * voxel_volume
    compared_volume = count * voxel_volume
    left_mean = left_integral / compared_volume
    right_mean = right_integral / compared_volume
    return MagnetizationComparison(
        grid=resolved_grid,
        valid_voxel_count=count,
        component=component,
        vector=vector,
        mean_left=tuple(float(value) for value in left_mean),
        mean_right=tuple(float(value) for value in right_mean),
        mean_difference=tuple(float(value) for value in right_mean - left_mean),
        integral_left=tuple(float(value) for value in left_integral),
        integral_right=tuple(float(value) for value in right_integral),
        valid_fraction=count / resolved_grid.voxel_count,
    )


def compare_relaxed_states(
    mumax_path: str | Path,
    *,
    fullmag_state_path: str | Path,
    fullmag_mesh_path: str | Path,
    fullmag_run_bundle: str | Path | None = None,
    magnetic_markers: tuple[int, ...] = (1,),
    grid: CartesianGrid | None = None,
    high_error_threshold: float = 1.0e-3,
) -> dict[str, object]:
    """Load, restrict, and compare the two explicit final relaxation states."""

    from fullmag.analysis.fem_cartesian_restriction import (
        build_prism6_cartesian_restriction,
        restrict_fem_magnetization,
    )

    mumax = load_mumax_magnetization(mumax_path, require_single_frame=True)
    fem = load_fullmag_fem_magnetization(
        fullmag_state_path,
        mesh_path=fullmag_mesh_path,
        run_bundle=fullmag_run_bundle,
    )
    comparison_grid = grid or mumax.grid
    restriction = build_prism6_cartesian_restriction(
        fem.mesh,
        comparison_grid,
        magnetic_markers=magnetic_markers,
    )
    fem_texture = restrict_fem_magnetization(fem.values, restriction)
    metrics = compare_magnetization_textures(
        fem_texture,
        mumax,
        high_error_threshold=high_error_threshold,
    )
    conservation = restriction.conservation(fem.values)
    return {
        "scope": {
            "state": "final_relaxed_state",
            "dynamics_included": False,
            "mumax_dataset": mumax.dataset,
            "fullmag_dataset": fem.dataset,
        },
        "mumax": mumax.to_dict(),
        "fullmag": fem.to_dict(),
        "restriction": restriction.to_dict(),
        "conservation": conservation,
        "metrics": metrics.to_dict(),
    }
