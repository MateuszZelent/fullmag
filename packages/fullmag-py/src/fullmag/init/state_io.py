from __future__ import annotations

import json
import math
import shutil
import struct
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Sequence

from .magnetization import SampledMagnetization

MAGNETIZATION_STATE_FORMATS = ("json", "zarr", "h5", "ovf", "npz", "npy")
FIELD_STATE_FORMATS = ("zarr", "h5", "ovf", "npz", "npy", "json")

_OVF_BINARY4_MAGIC = 1234567.0
_OVF_BINARY8_MAGIC = 123456789012345.0


@dataclass(frozen=True, slots=True)
class FieldState:
    values: list[tuple[float, ...]]
    quantity_id: str
    target_kind: str
    target_id: str
    units: str | None
    source_path: str | None
    source_format: str | None
    dataset: str | None
    sample_index: int | None
    grid_shape: tuple[int, int, int] | None = None
    grid_origin: tuple[float, float, float] | None = None
    grid_spacing: tuple[float, float, float] | None = None
    origin_explicit: bool = True

    @property
    def component_count(self) -> int:
        return len(self.values[0]) if self.values else 0

    def as_sampled_magnetization(self) -> SampledMagnetization:
        if self.quantity_id != "m" or self.component_count != 3:
            raise ValueError(
                "only 3-component quantity 'm' (valuedim=3) can be used as sampled magnetization"
            )
        return SampledMagnetization(
            self.values,  # type: ignore[arg-type]
            source_path=self.source_path,
            source_format=self.source_format,
            dataset=self.dataset,
            sample_index=self.sample_index,
        )


def load_magnetization(
    path: str | Path,
    *,
    format: str = "auto",
    dataset: str | None = None,
    sample: int = -1,
) -> SampledMagnetization:
    resolved = _resolve_state_path(path)
    normalized_format = _normalize_state_format(resolved, format)

    resolved_dataset = dataset
    resolved_sample_index: int | None = None
    if normalized_format == "json":
        values = _load_json_values(resolved, sample=sample)
        resolved_sample_index = None if sample < 0 else sample
        values_list = values
    elif normalized_format == "zarr":
        values, resolved_dataset = _load_zarr_values(resolved, dataset=dataset, sample=sample)
        resolved_sample_index = None if sample < 0 else sample
        values_list = values.tolist()
    elif normalized_format == "h5":
        values, resolved_dataset = _load_h5_values(resolved, dataset=dataset, sample=sample)
        resolved_sample_index = None if sample < 0 else sample
        values_list = values.tolist()
    elif normalized_format == "ovf":
        ovf_state = parse_ovf_bytes(resolved.read_bytes(), source_path=str(resolved))
        if ovf_state.component_count != 3:
            raise ValueError(
                f"OVF magnetization requires valuedim=3, got {ovf_state.component_count}"
            )
        values_list = ovf_state.values
    elif normalized_format in {"npz", "npy"}:
        values, resolved_dataset, _ = _load_numpy_field_values(
            resolved,
            dataset=dataset,
            sample=sample,
        )
        resolved_sample_index = None if sample < 0 else sample
        values_list = _select_state_sample(values, sample=sample).tolist()
    else:
        raise ValueError(f"unsupported magnetization state format '{normalized_format}'")

    return SampledMagnetization(
        values_list,
        source_path=str(resolved),
        source_format=normalized_format,
        dataset=resolved_dataset,
        sample_index=resolved_sample_index,
    )


def save_magnetization(
    path: str | Path,
    values: Sequence[Sequence[float]] | SampledMagnetization,
    *,
    format: str = "auto",
    dataset: str = "values",
) -> Path:
    output_path = Path(path)
    normalized_format = _normalize_state_format(output_path, format)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if normalized_format == "json":
        vectors = _normalize_vector_rows(values)
        payload = {
            "kind": "magnetization_state",
            "observable": "m",
            "format": "json",
            "vector_count": len(vectors),
            "values": vectors,
        }
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return output_path

    vectors = _normalize_vectors(values)
    if normalized_format == "zarr":
        _write_zarr_state(output_path, vectors, dataset=dataset)
        return output_path

    if normalized_format == "h5":
        _write_h5_state(output_path, vectors, dataset=dataset)
        return output_path

    raise ValueError(f"unsupported magnetization state format '{normalized_format}'")


def load_field_state(
    path: str | Path,
    *,
    format: str = "auto",
    dataset: str | None = None,
    sample: int = -1,
    source_origin: Sequence[float] | None = None,
) -> FieldState:
    resolved = _resolve_state_path(path)
    normalized_format = _normalize_field_state_format(resolved, format)
    explicit_origin = _extract_vec3(source_origin) if source_origin is not None else None
    if source_origin is not None and explicit_origin is None:
        raise ValueError("source_origin must be a finite 3-component coordinate vector")

    if normalized_format == "ovf":
        ovf_state = parse_ovf_bytes(resolved.read_bytes(), source_path=str(resolved))
        if explicit_origin is not None:
            return FieldState(
                values=ovf_state.values,
                quantity_id=ovf_state.quantity_id,
                target_kind=ovf_state.target_kind,
                target_id=ovf_state.target_id,
                units=ovf_state.units,
                source_path=ovf_state.source_path,
                source_format=ovf_state.source_format,
                dataset=ovf_state.dataset,
                sample_index=ovf_state.sample_index,
                grid_shape=ovf_state.grid_shape,
                grid_origin=explicit_origin,
                grid_spacing=ovf_state.grid_spacing,
                origin_explicit=True,
            )
        return ovf_state

    grid_shape: tuple[int, int, int] | None = None
    grid_origin: tuple[float, float, float] | None = None
    grid_spacing: tuple[float, float, float] | None = None
    if normalized_format == "zarr":
        values, resolved_dataset, metadata = _load_zarr_field_values(
            resolved,
            dataset=dataset,
            sample=sample,
        )
    elif normalized_format == "h5":
        values, resolved_dataset, metadata = _load_h5_field_values(
            resolved,
            dataset=dataset,
            sample=sample,
        )
    elif normalized_format in {"npz", "npy"}:
        values, resolved_dataset, metadata = _load_numpy_field_values(
            resolved,
            dataset=dataset,
            sample=sample,
        )
    elif normalized_format == "json":
        rows = _load_json_values(resolved, sample=sample)
        np = _require_numpy()
        values = np.asarray(rows, dtype=np.float64)
        resolved_dataset = "values"
        metadata = {"quantity_id": "m", "target_kind": "object", "target_id": "body"}
    else:
        raise ValueError(f"unsupported field state format '{normalized_format}'")

    grid_shape = _extract_grid_shape(metadata.get("grid_shape"))
    file_origin = _extract_vec3(metadata.get("grid_origin", metadata.get("origin")))
    grid_origin = explicit_origin if explicit_origin is not None else file_origin
    origin_explicit = grid_origin is not None
    grid_spacing = _extract_vec3(metadata.get("grid_spacing", metadata.get("spacing")))
    resolved_sample_index = None if sample < 0 else sample
    return FieldState(
        _field_array_to_rows(values),
        quantity_id=str(metadata.get("quantity_id") or _quantity_id_from_dataset(resolved_dataset)),
        target_kind=str(metadata.get("target_kind") or "unknown"),
        target_id=str(metadata.get("target_id") or metadata.get("target_kind") or "unknown"),
        units=metadata.get("units"),
        source_path=str(resolved),
        source_format=normalized_format,
        dataset=resolved_dataset,
        sample_index=resolved_sample_index,
        grid_shape=grid_shape,
        grid_origin=grid_origin,
        grid_spacing=grid_spacing,
        origin_explicit=origin_explicit,
    )


def save_field_state(
    path: str | Path,
    values: Sequence[Sequence[float]] | Sequence[float] | FieldState | SampledMagnetization,
    *,
    quantity: object | None = None,
    target_kind: str | None = None,
    target_id: str | None = None,
    units: str | None = None,
    format: str = "auto",
    dataset: str | None = None,
) -> Path:
    output_path = Path(path)
    normalized_format = _normalize_field_state_format(output_path, format)
    if isinstance(values, FieldState):
        quantity_id = _quantity_id(quantity if quantity is not None else values.quantity_id)
        target_kind = _normalize_non_empty(
            target_kind if target_kind is not None else values.target_kind,
            "target_kind",
        )
        target_id = _normalize_non_empty(
            target_id if target_id is not None else values.target_id,
            "target_id",
        )
        units = units if units is not None else values.units
    else:
        quantity_id = _quantity_id(quantity if quantity is not None else "m")
        target_kind = _normalize_non_empty(target_kind if target_kind is not None else "object", "target_kind")
        target_id = _normalize_non_empty(target_id if target_id is not None else "body", "target_id")
    dataset_path = dataset or f"fields/{quantity_id}"
    array = _normalize_field_array(values)
    metadata = {
        "fullmag_kind": "field_state",
        "schema_version": 1,
        "quantity_id": quantity_id,
        "target_kind": target_kind,
        "target_id": target_id,
        "format": normalized_format,
        "component_count": int(array.shape[1]),
    }
    if units is not None:
        metadata["units"] = str(units)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if normalized_format == "zarr":
        _write_zarr_field_state(output_path, array, dataset=dataset_path, metadata=metadata)
        return output_path
    if normalized_format == "h5":
        _write_h5_field_state(output_path, array, dataset=dataset_path, metadata=metadata)
        return output_path
    raise ValueError(f"unsupported field state format '{normalized_format}'")


def convert_magnetization_state(
    input_path: str | Path,
    output_path: str | Path,
    *,
    input_format: str = "auto",
    output_format: str = "auto",
    input_dataset: str | None = None,
    output_dataset: str = "values",
    sample: int = -1,
) -> Path:
    state = load_magnetization(
        input_path,
        format=input_format,
        dataset=input_dataset,
        sample=sample,
    )
    return save_magnetization(
        output_path,
        state,
        format=output_format,
        dataset=output_dataset,
    )


def infer_magnetization_state_format(path: str | Path) -> str:
    return _normalize_state_format(Path(path), "auto")


def _require_h5py() -> Any:
    try:
        import h5py
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("HDF5 magnetization state support requires h5py") from exc
    return h5py


def _require_numpy() -> Any:
    try:
        import numpy as np
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "non-JSON magnetization state support requires numpy"
        ) from exc
    return np


def _require_zarr() -> tuple[Any, Any, Any]:
    try:
        import zarr
        from zarr.storage import ZipStore
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("zarr magnetization state support requires zarr") from exc
    try:
        from zarr.storage import DirectoryStore
    except ImportError:
        try:
            from zarr.storage import LocalStore as DirectoryStore
        except ImportError as exc:
            raise RuntimeError(
                f"zarr magnetization state I/O requires zarr>=2.18 or zarr>=3; found zarr {zarr.__version__}"
            ) from exc
    return zarr, DirectoryStore, ZipStore


def _resolve_state_path(path: str | Path) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate

    try:
        import fullmag.world as world  # Local import to avoid import cycles.

        source_root = getattr(world, "_state")._script_source_root
    except Exception:
        source_root = None

    if source_root is not None:
        return (Path(source_root) / candidate).resolve()
    return candidate.resolve()


def _normalize_state_format(path: Path, format: str) -> str:
    normalized = format.strip().lower()
    if normalized and normalized != "auto":
        if normalized == "hdf5":
            return "h5"
        if normalized == "omf":
            return "ovf"
        if normalized == "field_state_json":
            return "json"
        if normalized not in MAGNETIZATION_STATE_FORMATS:
            raise ValueError(
                f"format must be one of {MAGNETIZATION_STATE_FORMATS} or 'auto', got '{format}'"
            )
        return normalized

    suffixes = [suffix.lower() for suffix in path.suffixes]
    if suffixes[-2:] == [".zarr", ".zip"] or path.name.lower().endswith(".zarr.zip"):
        return "zarr"
    if path.suffix.lower() == ".zarr":
        return "zarr"
    if path.suffix.lower() in {".h5", ".hdf5"}:
        return "h5"
    if path.suffix.lower() in {".ovf", ".omf"}:
        return "ovf"
    if path.suffix.lower() == ".npz":
        return "npz"
    if path.suffix.lower() == ".npy":
        return "npy"
    return "json"


def _normalize_field_state_format(path: Path, format: str) -> str:
    normalized = format.strip().lower()
    if normalized and normalized != "auto":
        if normalized == "hdf5":
            return "h5"
        if normalized == "omf":
            return "ovf"
        if normalized == "field_state_json":
            return "json"
        if normalized not in FIELD_STATE_FORMATS:
            raise ValueError(
                f"format must be one of {FIELD_STATE_FORMATS} or 'auto', got '{format}'"
            )
        return normalized

    suffixes = [suffix.lower() for suffix in path.suffixes]
    if suffixes[-2:] == [".zarr", ".zip"] or path.name.lower().endswith(".zarr.zip"):
        return "zarr"
    if path.suffix.lower() == ".zarr":
        return "zarr"
    if path.suffix.lower() in {".h5", ".hdf5"}:
        return "h5"
    if path.suffix.lower() in {".ovf", ".omf"}:
        return "ovf"
    if path.suffix.lower() == ".npz":
        return "npz"
    if path.suffix.lower() == ".npy":
        return "npy"
    if path.suffix.lower() == ".json":
        return "json"
    raise ValueError(
        "field state path must end with .zarr, .zarr.zip, .h5, .hdf5, .ovf, .omf, .npz, .npy, or .json"
    )


def _normalize_non_empty(value: str, label: str) -> str:
    normalized = str(value).strip()
    if not normalized:
        raise ValueError(f"{label} must not be empty")
    return normalized


def _quantity_id(quantity: object) -> str:
    if isinstance(quantity, str):
        return _normalize_non_empty(quantity, "quantity")
    name = getattr(quantity, "name", None)
    if isinstance(name, str):
        return _normalize_non_empty(name, "quantity")
    return _normalize_non_empty(str(quantity), "quantity")


def _normalize_vectors(values: Sequence[Sequence[float]] | SampledMagnetization) -> np.ndarray:
    np = _require_numpy()
    source: Sequence[Sequence[float]]
    if isinstance(values, SampledMagnetization):
        source = values.values
    else:
        source = values
    array = np.asarray(source, dtype=np.float64)
    normalized = _select_state_sample(array, sample=-1)
    if normalized.shape[0] == 0:
        raise ValueError("magnetization state must contain at least one vector")
    return normalized


def _normalize_field_array(
    values: Sequence[Sequence[float]] | Sequence[float] | FieldState | SampledMagnetization,
) -> np.ndarray:
    np = _require_numpy()
    if isinstance(values, FieldState):
        source = values.values
    elif isinstance(values, SampledMagnetization):
        source = values.values
    else:
        source = values
    array = np.asarray(source, dtype=np.float64)
    normalized = _select_field_sample(array, sample=-1)
    if normalized.shape[0] == 0:
        raise ValueError("field state must contain at least one sample point")
    return normalized


def _select_field_sample(values: np.ndarray, *, sample: int) -> np.ndarray:
    if values.ndim == 1:
        return values.reshape((-1, 1))
    if values.ndim == 2:
        if values.shape[1] <= 0:
            raise ValueError("field state component axis must not be empty")
        return values
    if values.ndim == 3:
        if values.shape[0] == 0:
            raise ValueError("field state array does not contain any samples")
        if values.shape[2] <= 0:
            raise ValueError("field state component axis must not be empty")
        index = sample if sample >= 0 else values.shape[0] - 1
        if index < 0 or index >= values.shape[0]:
            raise IndexError(f"sample index {sample} is out of range for {values.shape[0]} samples")
        return values[index]
    raise ValueError(
        f"expected field state with shape [N], [N,C], or [T,N,C], got {tuple(values.shape)}"
    )


def _field_array_to_rows(values: np.ndarray) -> list[tuple[float, ...]]:
    normalized = _select_field_sample(values, sample=-1)
    return [tuple(float(component) for component in row) for row in normalized.tolist()]


def _normalize_vector_rows(values: Any, *, sample: int = -1) -> list[tuple[float, float, float]]:
    source = values.values if isinstance(values, SampledMagnetization) else values
    if hasattr(source, "tolist"):
        source = source.tolist()
    if not isinstance(source, Sequence) or isinstance(source, (str, bytes)):
        raise ValueError("magnetization state must be a sequence")
    if len(source) == 0:
        raise ValueError("magnetization state must contain at least one vector")

    first = source[0]
    if isinstance(first, (int, float)):
        if len(source) % 3 != 0:
            raise ValueError(
                f"expected a flat magnetization buffer divisible by 3, got length {len(source)}"
            )
        return [
            (float(source[index]), float(source[index + 1]), float(source[index + 2]))
            for index in range(0, len(source), 3)
        ]

    if isinstance(first, Sequence) and not isinstance(first, (str, bytes)):
        if len(first) == 3 and all(isinstance(component, (int, float)) for component in first):
            return [_normalize_vector_row(row) for row in source]
        index = sample if sample >= 0 else len(source) - 1
        if index < 0 or index >= len(source):
            raise IndexError(f"sample index {sample} is out of range for {len(source)} samples")
        return _normalize_vector_rows(source[index], sample=-1)

    raise ValueError("expected magnetization state with shape [N,3] or [T,N,3]")


def _normalize_vector_row(row: Any) -> tuple[float, float, float]:
    if not isinstance(row, Sequence) or isinstance(row, (str, bytes)) or len(row) != 3:
        raise ValueError("expected magnetization vector with three components")
    return (float(row[0]), float(row[1]), float(row[2]))


def _load_json_values(path: Path, *, sample: int) -> list[tuple[float, float, float]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_values: Any
    if isinstance(payload, dict):
        observable = payload.get("observable")
        if observable not in {None, "m"}:
            raise ValueError(f"{path} does not contain magnetization data (observable={observable!r})")
        raw_values = payload.get("values", payload.get("magnetization"))
    else:
        raw_values = payload
    if raw_values is None:
        raise ValueError(f"{path} does not contain a 'values' array")
    return _normalize_vector_rows(raw_values, sample=sample)


def _load_h5_values(
    path: Path,
    *,
    dataset: str | None,
    sample: int,
) -> tuple[np.ndarray, str]:
    np = _require_numpy()
    h5py = _require_h5py()
    with h5py.File(path, "r") as handle:
        dataset_path = dataset or _find_h5_dataset(handle)
        if dataset_path is None:
            raise ValueError(f"{path} does not contain a suitable magnetization dataset")
        values = np.asarray(handle[dataset_path], dtype=np.float64)
    return _select_state_sample(values, sample=sample), dataset_path


def _load_h5_field_values(
    path: Path,
    *,
    dataset: str | None,
    sample: int,
) -> tuple[np.ndarray, str, dict[str, Any]]:
    np = _require_numpy()
    h5py = _require_h5py()
    with h5py.File(path, "r") as handle:
        dataset_path = dataset or _find_h5_field_dataset(handle)
        if dataset_path is None:
            raise ValueError(f"{path} does not contain a suitable field state dataset")
        target = handle[dataset_path]
        values = np.asarray(target, dtype=np.float64)
        metadata = _attrs_to_metadata(handle.attrs)
        metadata.update(_attrs_to_metadata(target.attrs))
    return _select_field_sample(values, sample=sample), dataset_path, metadata


def _load_zarr_values(
    path: Path,
    *,
    dataset: str | None,
    sample: int,
) -> tuple[np.ndarray, str]:
    np = _require_numpy()
    zarr, _, _ = _require_zarr()
    store = _open_zarr_store(path, mode="r")
    try:
        root = zarr.open(store=store, mode="r")
        dataset_path = dataset or _find_zarr_dataset(root)
        if dataset_path is None:
            raise ValueError(f"{path} does not contain a suitable magnetization dataset")
        target = root[dataset_path] if hasattr(root, "__getitem__") else root
        values = np.asarray(target, dtype=np.float64)
    finally:
        store.close()
    return _select_state_sample(values, sample=sample), dataset_path


def _load_zarr_field_values(
    path: Path,
    *,
    dataset: str | None,
    sample: int,
) -> tuple[np.ndarray, str, dict[str, Any]]:
    np = _require_numpy()
    zarr, _, _ = _require_zarr()
    store = _open_zarr_store(path, mode="r")
    try:
        root = zarr.open(store=store, mode="r")
        dataset_path = dataset or _find_zarr_field_dataset(root)
        if dataset_path is None:
            raise ValueError(f"{path} does not contain a suitable field state dataset")
        target = root[dataset_path] if dataset_path and hasattr(root, "__getitem__") else root
        values = np.asarray(target, dtype=np.float64)
        metadata = _attrs_to_metadata(getattr(root, "attrs", {}))
        metadata.update(_attrs_to_metadata(getattr(target, "attrs", {})))
    finally:
        store.close()
    return _select_field_sample(values, sample=sample), dataset_path, metadata


def _write_h5_state(path: Path, values: np.ndarray, *, dataset: str) -> None:
    h5py = _require_h5py()
    with h5py.File(path, "w") as handle:
        target = _ensure_h5_dataset(handle, dataset, values)
        handle.attrs["fullmag_kind"] = "magnetization_state"
        handle.attrs["observable"] = "m"
        handle.attrs["format"] = "h5"
        target.attrs["observable"] = "m"
        target.attrs["vector_count"] = int(values.shape[0])


def _write_h5_field_state(
    path: Path,
    values: np.ndarray,
    *,
    dataset: str,
    metadata: dict[str, object],
) -> None:
    h5py = _require_h5py()
    with h5py.File(path, "w") as handle:
        target = _ensure_h5_dataset(handle, dataset, values)
        for key, value in metadata.items():
            handle.attrs[key] = value
            target.attrs[key] = value
        target.attrs["point_count"] = int(values.shape[0])


def _write_zarr_state(path: Path, values: np.ndarray, *, dataset: str) -> None:
    zarr, _, _ = _require_zarr()
    if path.exists() and path.is_dir():
        shutil.rmtree(path)
    store = _open_zarr_store(path, mode="w")
    root_attrs = {
        "fullmag_kind": "magnetization_state",
        "observable": "m",
        "format": "zarr",
    }
    target_attrs = {
        "observable": "m",
        "vector_count": int(values.shape[0]),
    }
    try:
        try:
            root = zarr.group(store=store, overwrite=True, attributes=root_attrs)
        except TypeError:
            root = zarr.group(store=store, overwrite=True)
            root.attrs.update(root_attrs)
        parent, leaf = _ensure_zarr_group(root, dataset)
        chunks = (min(max(values.shape[0], 1), 4096), 3)
        if hasattr(parent, "create_array"):
            target = parent.create_array(
                leaf,
                data=values,
                chunks=chunks,
                attributes=target_attrs,
                overwrite=True,
            )
        else:
            target = parent.create_dataset(
                leaf,
                data=values,
                shape=values.shape,
                dtype="f8",
                chunks=chunks,
                overwrite=True,
            )
            target.attrs.update(target_attrs)
    finally:
        store.close()


def _write_zarr_field_state(
    path: Path,
    values: np.ndarray,
    *,
    dataset: str,
    metadata: dict[str, object],
) -> None:
    zarr, _, _ = _require_zarr()
    if path.exists() and path.is_dir():
        shutil.rmtree(path)
    store = _open_zarr_store(path, mode="w")
    target_attrs = {**metadata, "point_count": int(values.shape[0])}
    try:
        try:
            root = zarr.group(store=store, overwrite=True, attributes=metadata)
        except TypeError:
            root = zarr.group(store=store, overwrite=True)
            root.attrs.update(metadata)
        parent, leaf = _ensure_zarr_group(root, dataset)
        chunks = (min(max(values.shape[0], 1), 4096), min(max(values.shape[1], 1), values.shape[1]))
        if hasattr(parent, "create_array"):
            parent.create_array(
                leaf,
                data=values,
                chunks=chunks,
                attributes=target_attrs,
                overwrite=True,
            )
        else:
            target = parent.create_dataset(
                leaf,
                data=values,
                shape=values.shape,
                dtype="f8",
                chunks=chunks,
                overwrite=True,
            )
            target.attrs.update(target_attrs)
    finally:
        store.close()


def _ensure_h5_dataset(handle: Any, dataset: str, values: np.ndarray) -> Any:
    target = handle
    parts = [part for part in dataset.strip("/").split("/") if part]
    if not parts:
        raise ValueError("dataset path must not be empty")
    for group_name in parts[:-1]:
        target = target.require_group(group_name)
    return target.create_dataset(parts[-1], data=values, compression="gzip")


def _ensure_zarr_group(root: Any, dataset: str) -> tuple[Any, str]:
    parts = [part for part in dataset.strip("/").split("/") if part]
    if not parts:
        raise ValueError("dataset path must not be empty")
    target = root
    for group_name in parts[:-1]:
        target = target.require_group(group_name)
    return target, parts[-1]


def _find_h5_dataset(handle: Any) -> str | None:
    np = _require_numpy()
    h5py = _require_h5py()
    preferred = ["values", "m", "magnetization"]
    for candidate in preferred:
        if candidate in handle and isinstance(handle[candidate], h5py.Dataset):
            if _dataset_looks_like_state(np.asarray(handle[candidate])):
                return candidate

    matches: list[str] = []

    def visitor(name: str, obj: Any) -> None:
        if isinstance(obj, h5py.Dataset) and _dataset_looks_like_state(np.asarray(obj)):
            matches.append(name)

    handle.visititems(visitor)
    return matches[0] if matches else None


def _find_h5_field_dataset(handle: Any) -> str | None:
    h5py = _require_h5py()
    preferred = ["fields/m", "fields/H_eff", "values", "m", "magnetization"]
    for candidate in preferred:
        if candidate in handle and isinstance(handle[candidate], h5py.Dataset):
            return candidate

    matches: list[str] = []

    def visitor(name: str, obj: Any) -> None:
        if isinstance(obj, h5py.Dataset):
            try:
                _select_field_sample(_require_numpy().asarray(obj), sample=-1)
            except ValueError:
                return
            matches.append(name)

    handle.visititems(visitor)
    return matches[0] if matches else None


def _find_zarr_dataset(root: Any) -> str | None:
    np = _require_numpy()
    if hasattr(root, "shape") and _dataset_looks_like_state(np.asarray(root)):
        return ""

    for candidate in ("values", "m", "magnetization"):
        try:
            target = root[candidate]
        except Exception:
            continue
        if _dataset_looks_like_state(np.asarray(target)):
            return candidate

    matches: list[str] = []

    def visitor(name: str, obj: Any) -> None:
        if hasattr(obj, "shape") and _dataset_looks_like_state(np.asarray(obj)):
            matches.append(name)

    if hasattr(root, "visititems"):
        root.visititems(visitor)
    return matches[0] if matches else None


def _find_zarr_field_dataset(root: Any) -> str | None:
    if hasattr(root, "shape"):
        return ""

    for candidate in ("fields/m", "fields/H_eff", "values", "m", "magnetization"):
        try:
            target = root[candidate]
        except Exception:
            continue
        if hasattr(target, "shape"):
            return candidate

    matches: list[str] = []

    def visitor(name: str, obj: Any) -> None:
        if hasattr(obj, "shape"):
            matches.append(name)

    if hasattr(root, "visititems"):
        root.visititems(visitor)
    return matches[0] if matches else None


def _attrs_to_metadata(attrs: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for key in attrs:
        value = attrs[key]
        if hasattr(value, "item"):
            try:
                value = value.item()
            except Exception:
                pass
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        metadata[str(key)] = value
    return metadata


def _quantity_id_from_dataset(dataset: str) -> str:
    normalized = dataset.strip("/")
    if not normalized:
        return "unknown"
    return normalized.split("/")[-1]


def _dataset_looks_like_state(values: np.ndarray) -> bool:
    if values.ndim == 1:
        return values.size % 3 == 0
    return values.shape[-1] == 3 and values.ndim in {2, 3}


def _select_state_sample(values: np.ndarray, *, sample: int) -> np.ndarray:
    if values.ndim == 1:
        if values.size % 3 != 0:
            raise ValueError(
                f"expected a flat magnetization buffer divisible by 3, got length {values.size}"
            )
        return values.reshape((-1, 3))

    if values.ndim == 2 and values.shape[1] == 3:
        return values

    if values.ndim == 3 and values.shape[-1] == 3:
        if values.shape[0] == 0:
            raise ValueError("magnetization state array does not contain any samples")
        index = sample if sample >= 0 else values.shape[0] - 1
        if index < 0 or index >= values.shape[0]:
            raise IndexError(f"sample index {sample} is out of range for {values.shape[0]} samples")
        return values[index]

    raise ValueError(
        f"expected magnetization state with shape [N,3] or [T,N,3], got {tuple(values.shape)}"
    )


def _open_zarr_store(path: Path, *, mode: str) -> Any:
    _, DirectoryStore, ZipStore = _require_zarr()
    if path.name.lower().endswith(".zip"):
        return ZipStore(str(path), mode=mode)
    if getattr(DirectoryStore, "__name__", "") == "LocalStore":
        return DirectoryStore(str(path), read_only=mode == "r")
    return DirectoryStore(str(path))


def _extract_grid_shape(raw: Any) -> tuple[int, int, int] | None:
    if raw is None:
        return None
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)) and len(raw) == 3:
        dims = (int(raw[0]), int(raw[1]), int(raw[2]))
        if all(dim > 0 for dim in dims):
            return dims
    return None


def _extract_vec3(raw: Any) -> tuple[float, float, float] | None:
    if raw is None:
        return None
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)) and len(raw) == 3:
        vec = (float(raw[0]), float(raw[1]), float(raw[2]))
        if all(math.isfinite(c) for c in vec):
            return vec
    return None


def parse_ovf_bytes(raw: bytes, *, source_path: str | None = None) -> FieldState:
    """Parse an OOMMF / Mumax3 OVF 1.0 or OVF 2.0 file (Text, Binary 4, Binary 8)."""
    np = _require_numpy()
    pos = 0
    total_len = len(raw)
    if total_len == 0:
        raise ValueError("OVF payload is empty")

    def read_line() -> tuple[bytes, int]:
        nonlocal pos
        if pos >= total_len:
            return b"", pos
        newline = raw.find(b"\n", pos)
        if newline == -1:
            line = raw[pos:]
            pos = total_len
            return line, pos
        line = raw[pos:newline]
        pos = newline + 1
        return line, pos

    first_line_bytes, _ = read_line()
    first_line = first_line_bytes.decode("latin-1").strip()
    if "OVF 2.0" in first_line:
        ovf_version = 2
    elif "v1.0" in first_line or "OVF 1.0" in first_line or "OOMMF" in first_line:
        ovf_version = 1
    else:
        raise ValueError(f"unsupported or missing OVF header line: {first_line!r}")

    headers: dict[str, str] = {}
    data_mode: str | None = None
    data_start_offset = 0

    while pos < total_len:
        line_bytes, next_pos = read_line()
        line = line_bytes.decode("latin-1").strip()
        if not line:
            continue
        if not line.startswith("#"):
            raise ValueError(f"unexpected non-comment line before OVF data block: {line!r}")
        body = line[1:].strip()
        lower_body = body.lower()
        if lower_body.startswith("begin: data"):
            tokens = body.split()
            # e.g. "Begin: Data Text", "Begin: Data Binary 4", "Begin: Data Binary 8"
            mode_tokens = [token.lower() for token in tokens[2:]]
            if mode_tokens == ["text"]:
                data_mode = "text"
            elif mode_tokens == ["binary", "4"]:
                data_mode = "binary4"
            elif mode_tokens == ["binary", "8"]:
                data_mode = "binary8"
            else:
                raise ValueError(f"unsupported OVF data encoding: {body!r}")
            data_start_offset = next_pos
            break
        if ":" in body:
            key, val = body.split(":", 1)
            key_norm = key.strip().lower()
            if key_norm not in {"begin", "end"}:
                headers[key_norm] = val.strip()

    if data_mode is None:
        raise ValueError("OVF file is missing '# Begin: Data' block")

    meshtype = headers.get("meshtype", "rectangular").strip().lower()
    if meshtype != "rectangular":
        raise ValueError(f"OVF meshtype '{meshtype}' is not supported; expected 'rectangular'")

    try:
        nx = int(headers["xnodes"])
        ny = int(headers["ynodes"])
        nz = int(headers["znodes"])
    except (KeyError, ValueError) as exc:
        raise ValueError("OVF header must define integer xnodes, ynodes, and znodes") from exc
    if nx <= 0 or ny <= 0 or nz <= 0:
        raise ValueError("OVF grid node counts must be positive")

    valuedim = int(headers.get("valuedim", "3"))
    if valuedim not in (1, 3):
        raise ValueError(f"OVF valuedim must be 1 or 3, got {valuedim}")

    origin_explicit = all(k in headers for k in ("xmin", "ymin", "zmin"))
    xmin = float(headers.get("xmin", "0.0"))
    ymin = float(headers.get("ymin", "0.0"))
    zmin = float(headers.get("zmin", "0.0"))
    dx = float(headers["xstepsize"]) if "xstepsize" in headers else (float(headers.get("xmax", str(nx))) - xmin) / nx
    dy = float(headers["ystepsize"]) if "ystepsize" in headers else (float(headers.get("ymax", str(ny))) - ymin) / ny
    dz = float(headers["zstepsize"]) if "zstepsize" in headers else (float(headers.get("zmax", str(nz))) - zmin) / nz
    if not all(math.isfinite(s) and s > 0.0 for s in (dx, dy, dz)):
        raise ValueError("OVF step sizes must be finite and positive")

    value_multiplier = float(headers.get("valuemultiplier", "1.0")) if ovf_version == 1 else 1.0
    if not math.isfinite(value_multiplier):
        raise ValueError("OVF valuemultiplier must be finite")

    expected_count = nx * ny * nz
    expected_scalars = expected_count * valuedim

    if data_mode == "text":
        scalars: list[float] = []
        text_tail = raw[data_start_offset:].decode("latin-1")
        for line in text_tail.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                if stripped[1:].strip().lower().startswith("end: data"):
                    break
                continue
            for token in stripped.split():
                scalars.append(float(token))
        if len(scalars) != expected_scalars:
            raise ValueError(
                f"OVF Text data expected {expected_scalars} scalars, got {len(scalars)}"
            )
        arr = np.asarray(scalars, dtype=np.float64).reshape((expected_count, valuedim))
    elif data_mode == "binary4":
        endian = "<" if ovf_version == 2 else ">"
        needed_bytes = 4 + 4 * expected_scalars
        if data_start_offset + needed_bytes > total_len:
            raise ValueError("OVF Binary 4 payload is truncated")
        magic = struct.unpack_from(f"{endian}f", raw, data_start_offset)[0]
        if magic != _OVF_BINARY4_MAGIC:
            raise ValueError(
                f"OVF Binary 4 magic mismatch for OVF {ovf_version}.0: expected {_OVF_BINARY4_MAGIC}, got {magic}"
            )
        arr = np.frombuffer(
            raw,
            dtype=np.dtype(f"{endian}f4"),
            count=expected_scalars,
            offset=data_start_offset + 4,
        ).astype(np.float64).reshape((expected_count, valuedim))
    else:  # binary8
        endian = "<" if ovf_version == 2 else ">"
        needed_bytes = 8 + 8 * expected_scalars
        if data_start_offset + needed_bytes > total_len:
            raise ValueError("OVF Binary 8 payload is truncated")
        magic = struct.unpack_from(f"{endian}d", raw, data_start_offset)[0]
        if magic != _OVF_BINARY8_MAGIC:
            raise ValueError(
                f"OVF Binary 8 magic mismatch for OVF {ovf_version}.0: expected {_OVF_BINARY8_MAGIC}, got {magic}"
            )
        arr = np.frombuffer(
            raw,
            dtype=np.dtype(f"{endian}f8"),
            count=expected_scalars,
            offset=data_start_offset + 8,
        ).astype(np.float64).reshape((expected_count, valuedim))

    if value_multiplier != 1.0:
        arr = arr * value_multiplier

    if not np.all(np.isfinite(arr)):
        raise ValueError("OVF field data contains non-finite values")

    rows = [tuple(float(component) for component in row) for row in arr.tolist()]
    return FieldState(
        values=rows,
        quantity_id="m" if valuedim == 3 else "scalar",
        target_kind="object",
        target_id="body",
        units=headers.get("valueunits", "1"),
        source_path=source_path,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(nx, ny, nz),
        grid_origin=(xmin, ymin, zmin),
        grid_spacing=(dx, dy, dz),
        origin_explicit=origin_explicit,
    )


def save_ovf(
    path: str | Path,
    values: Sequence[Sequence[float]] | FieldState | SampledMagnetization,
    *,
    grid_shape: tuple[int, int, int],
    grid_spacing: tuple[float, float, float],
    grid_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    encoding: Literal["binary4", "binary8", "text"] = "binary4",
    title: str = "fullmag",
) -> Path:
    """Write an OVF 2.0 rectangular-mesh vector field (x fastest, then y, then z)."""
    np = _require_numpy()
    nx, ny, nz = (int(grid_shape[0]), int(grid_shape[1]), int(grid_shape[2]))
    dx, dy, dz = (float(grid_spacing[0]), float(grid_spacing[1]), float(grid_spacing[2]))
    x0, y0, z0 = (float(grid_origin[0]), float(grid_origin[1]), float(grid_origin[2]))
    if nx <= 0 or ny <= 0 or nz <= 0:
        raise ValueError("grid_shape dimensions must be positive")
    if not all(math.isfinite(s) and s > 0.0 for s in (dx, dy, dz)):
        raise ValueError("grid_spacing components must be finite and positive")

    arr = _normalize_field_array(values)
    expected_count = nx * ny * nz
    if arr.shape[0] != expected_count:
        raise ValueError(
            f"save_ovf expected {expected_count} points for grid {grid_shape}, got {arr.shape[0]}"
        )
    valuedim = int(arr.shape[1])
    if valuedim not in (1, 3):
        raise ValueError(f"OVF valuedim must be 1 or 3, got {valuedim}")

    data_header = {
        "text": "Text",
        "binary4": "Binary 4",
        "binary8": "Binary 8",
    }.get(encoding)
    if data_header is None:
        raise ValueError(f"unsupported OVF encoding '{encoding}'")

    header_lines = [
        "# OOMMF OVF 2.0",
        "# Segment count: 1",
        "# Begin: Segment",
        "# Begin: Header",
        f"# Title: {title}",
        "# meshtype: rectangular",
        "# meshunit: m",
        f"# xmin: {x0!r}",
        f"# ymin: {y0!r}",
        f"# zmin: {z0!r}",
        f"# xmax: {x0 + nx * dx!r}",
        f"# ymax: {y0 + ny * dy!r}",
        f"# zmax: {z0 + nz * dz!r}",
        f"# valuedim: {valuedim}",
        "# valuelabels: m_x m_y m_z" if valuedim == 3 else "# valuelabels: value",
        "# valueunits: 1 1 1" if valuedim == 3 else "# valueunits: 1",
        f"# xnodes: {nx}",
        f"# ynodes: {ny}",
        f"# znodes: {nz}",
        f"# xstepsize: {dx!r}",
        f"# ystepsize: {dy!r}",
        f"# zstepsize: {dz!r}",
        "# End: Header",
        f"# Begin: Data {data_header}",
    ]
    header_bytes = ("\n".join(header_lines) + "\n").encode("ascii")
    if encoding == "text":
        body_lines = [" ".join(f"{float(c):.16g}" for c in row) for row in arr.tolist()]
        payload_bytes = ("\n".join(body_lines) + "\n").encode("ascii")
    elif encoding == "binary4":
        payload_bytes = struct.pack("<f", _OVF_BINARY4_MAGIC) + np.ascontiguousarray(arr, dtype="<f4").tobytes() + b"\n"
    else:
        payload_bytes = struct.pack("<d", _OVF_BINARY8_MAGIC) + np.ascontiguousarray(arr, dtype="<f8").tobytes() + b"\n"
    trailer_bytes = f"# End: Data {data_header}\n# End: Segment\n".encode("ascii")

    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(header_bytes + payload_bytes + trailer_bytes)
    return output_path


def _load_numpy_field_values(
    path: Path,
    *,
    dataset: str | None,
    sample: int,
) -> tuple[Any, str, dict[str, Any]]:
    np = _require_numpy()
    metadata: dict[str, Any] = {
        "quantity_id": "m",
        "target_kind": "object",
        "target_id": "body",
    }
    axis_order: str | None = None
    raw_loaded = np.load(path, allow_pickle=False)
    try:
        if hasattr(raw_loaded, "files"):
            files = list(raw_loaded.files)
            if not files:
                raise ValueError(f"{path} NPZ archive contains no arrays")
            for meta_key, target_key in (
                ("origin", "grid_origin"),
                ("grid_origin", "grid_origin"),
                ("spacing", "grid_spacing"),
                ("grid_spacing", "grid_spacing"),
                ("grid_shape", "grid_shape"),
            ):
                if meta_key in raw_loaded.files:
                    metadata[target_key] = np.asarray(raw_loaded[meta_key]).tolist()
            if "axis_order" in raw_loaded.files:
                raw_axis_order = raw_loaded["axis_order"]
                if hasattr(raw_axis_order, "item"):
                    raw_axis_order = raw_axis_order.item()
                if isinstance(raw_axis_order, bytes):
                    raw_axis_order = raw_axis_order.decode("utf-8")
                axis_order = str(raw_axis_order).strip().lower()
                if axis_order not in {"zyx", "xyz"}:
                    raise ValueError(
                        f"NPZ axis_order must be 'zyx' (canonical [Nz, Ny, Nx, C]) or 'xyz' ([Nx, Ny, Nz, C]), got {raw_axis_order!r}"
                    )
            reserved_meta = {
                "origin",
                "grid_origin",
                "spacing",
                "grid_spacing",
                "grid_shape",
                "axis_order",
                "coords",
            }
            selected_key = dataset
            if selected_key is None:
                for preferred in ("m", "values", "magnetization", "fields/m"):
                    if preferred in raw_loaded.files:
                        selected_key = preferred
                        break
            if selected_key is None:
                vec_keys = [
                    key
                    for key in files
                    if key not in reserved_meta
                    and np.asarray(raw_loaded[key]).ndim >= 2
                    and np.asarray(raw_loaded[key]).shape[-1] in (1, 3)
                ]
                if len(vec_keys) == 1:
                    selected_key = vec_keys[0]
                elif len(files) == 1:
                    selected_key = files[0]
                else:
                    raise ValueError(
                        f"{path} NPZ archive has multiple arrays {files}; specify dataset explicitly"
                    )
            if selected_key not in raw_loaded.files:
                raise ValueError(f"dataset '{selected_key}' not found in {path}")
            arr = np.asarray(raw_loaded[selected_key], dtype=np.float64)
            dataset_name = selected_key
        else:
            arr = np.asarray(raw_loaded, dtype=np.float64)
            dataset_name = dataset or "values"
    finally:
        if hasattr(raw_loaded, "close"):
            raw_loaded.close()

    # Handle 4D structured grid: canonical layout is [Nz, Ny, Nx, C] (x fastest in C-order: idx = x + nx*(y + ny*z))
    if arr.ndim == 4 and arr.shape[-1] in (1, 3):
        declared_shape = _extract_grid_shape(metadata.get("grid_shape"))
        if axis_order == "xyz":
            nx, ny, nz, comp = arr.shape
            if declared_shape is not None and declared_shape != (nx, ny, nz):
                raise ValueError(
                    f"NPZ 4D array shape {tuple(arr.shape)} with axis_order='xyz' does not match grid_shape={declared_shape}"
                )
            arr = np.ascontiguousarray(np.transpose(arr, (2, 1, 0, 3))).reshape(
                (nx * ny * nz, comp)
            )
            metadata["grid_shape"] = [int(nx), int(ny), int(nz)]
        else:
            d0, d1, d2, comp = arr.shape
            if declared_shape is not None:
                gx, gy, gz = declared_shape
                if (d0, d1, d2) != (gz, gy, gx):
                    if (d0, d1, d2) == (gx, gy, gz):
                        raise ValueError(
                            f"NPZ 4D array shape {tuple(arr.shape)} uses [Nx, Ny, Nz, C] axis order instead of canonical [Nz, Ny, Nx, C]=({gz}, {gy}, {gx}, {comp}) for grid_shape={declared_shape}; transpose with arr.transpose(2, 1, 0, 3) or include axis_order='xyz' explicitly"
                        )
                    raise ValueError(
                        f"NPZ 4D array shape {tuple(arr.shape)} does not match canonical [Nz, Ny, Nx, C]=({gz}, {gy}, {gx}, {comp}) for grid_shape={declared_shape}"
                    )
                nz, ny, nx = gz, gy, gx
            else:
                nz, ny, nx = d0, d1, d2
                metadata["grid_shape"] = [int(nx), int(ny), int(nz)]
            arr = np.ascontiguousarray(arr).reshape((nx * ny * nz, comp))
    elif arr.ndim == 3 and arr.shape[-1] in (1, 3):
        arr = _select_field_sample(arr, sample=sample)
    elif arr.ndim == 2:
        arr = _select_field_sample(arr, sample=sample)
    elif arr.ndim == 1:
        if arr.size % 3 == 0:
            arr = arr.reshape((-1, 3))
        else:
            arr = arr.reshape((-1, 1))
    else:
        raise ValueError(f"unsupported NumPy field array shape {tuple(arr.shape)}")

    if arr.shape[1] not in (1, 3):
        raise ValueError(f"field state valuedim must be 1 or 3, got {arr.shape[1]}")
    if arr.shape[1] == 1 and dataset_name not in {"m", "magnetization", "fields/m"}:
        metadata["quantity_id"] = "scalar"

    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{path} contains non-finite field values")
    return arr, dataset_name, metadata


_DETERMINISTIC_UNIT_FALLBACK: tuple[float, float, float] = (0.0, 0.0, 1.0)


def _nearest_nonzero_cell(
    grid: Any,
    nx: int,
    ny: int,
    nz: int,
    origin: tuple[float, float, float],
    spacing: tuple[float, float, float],
    point: tuple[float, float, float],
    zero_threshold: float,
) -> tuple[float, float, float]:
    ix = max(0, min(nx - 1, math.floor((point[0] - origin[0]) / spacing[0])))
    iy = max(0, min(ny - 1, math.floor((point[1] - origin[1]) / spacing[1])))
    iz = max(0, min(nz - 1, math.floor((point[2] - origin[2]) / spacing[2])))
    v = grid[iz, iy, ix]
    norm = math.sqrt(float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))
    if norm > zero_threshold:
        return (float(v[0]), float(v[1]), float(v[2]))

    best_vec: tuple[float, float, float] | None = None
    best_dist_sq = math.inf
    max_shell = max(nx, ny, nz) - 1
    found_shell = 0

    for r in range(1, max_shell + 1):
        z_lo = max(0, iz - r)
        z_hi = min(nz - 1, iz + r)
        y_lo = max(0, iy - r)
        y_hi = min(ny - 1, iy + r)
        x_lo = max(0, ix - r)
        x_hi = min(nx - 1, ix + r)
        for jz in range(z_lo, z_hi + 1):
            on_z = abs(jz - iz) == r
            cz = origin[2] + (jz + 0.5) * spacing[2]
            for jy in range(y_lo, y_hi + 1):
                on_yz = on_z or (abs(jy - iy) == r)
                cy = origin[1] + (jy + 0.5) * spacing[1]
                for jx in range(x_lo, x_hi + 1):
                    if not (on_yz or abs(jx - ix) == r):
                        continue
                    cand = grid[jz, jy, jx]
                    cnorm = math.sqrt(
                        float(cand[0] * cand[0] + cand[1] * cand[1] + cand[2] * cand[2])
                    )
                    if cnorm <= zero_threshold:
                        continue
                    cx = origin[0] + (jx + 0.5) * spacing[0]
                    dist_sq = (
                        (point[0] - cx) ** 2
                        + (point[1] - cy) ** 2
                        + (point[2] - cz) ** 2
                    )
                    if dist_sq < best_dist_sq:
                        best_dist_sq = dist_sq
                        best_vec = (float(cand[0]), float(cand[1]), float(cand[2]))
        if best_vec is not None:
            found_shell = r
            break

    if best_vec is None:
        return _DETERMINISTIC_UNIT_FALLBACK

    # Refine across anisotropic cells whose Euclidean center distance could beat found_shell
    best_dist = math.sqrt(best_dist_sq)
    rx = int(math.ceil(best_dist / spacing[0])) + 1
    ry = int(math.ceil(best_dist / spacing[1])) + 1
    rz = int(math.ceil(best_dist / spacing[2])) + 1
    for jz in range(max(0, iz - rz), min(nz - 1, iz + rz) + 1):
        cz = origin[2] + (jz + 0.5) * spacing[2]
        for jy in range(max(0, iy - ry), min(ny - 1, iy + ry) + 1):
            cy = origin[1] + (jy + 0.5) * spacing[1]
            for jx in range(max(0, ix - rx), min(nx - 1, ix + rx) + 1):
                if max(abs(jx - ix), abs(jy - iy), abs(jz - iz)) <= found_shell:
                    continue
                cand = grid[jz, jy, jx]
                cnorm = math.sqrt(
                    float(cand[0] * cand[0] + cand[1] * cand[1] + cand[2] * cand[2])
                )
                if cnorm <= zero_threshold:
                    continue
                cx = origin[0] + (jx + 0.5) * spacing[0]
                dist_sq = (
                    (point[0] - cx) ** 2
                    + (point[1] - cy) ** 2
                    + (point[2] - cz) ** 2
                )
                if dist_sq < best_dist_sq:
                    best_dist_sq = dist_sq
                    best_vec = (float(cand[0]), float(cand[1]), float(cand[2]))
    return best_vec


def resample_imported_field(
    source_values: Sequence[Sequence[float]] | Any | FieldState | SampledMagnetization,
    target_points: Sequence[Sequence[float]] | Any,
    *,
    interpolation: Literal["exact", "nearest", "trilinear"] = "trilinear",
    source_grid_shape: tuple[int, int, int] | None = None,
    source_origin: tuple[float, float, float] | None = None,
    source_spacing: tuple[float, float, float] | None = None,
    target_grid_shape: tuple[int, int, int] | None = None,
    normalize: bool = True,
    zero_threshold: float = 1.0e-12,
) -> Any:
    """Resample an imported vector field onto target coordinates.

    Supports ``exact``, ``nearest``, and ``trilinear`` interpolation. In
    ``trilinear`` mode, inactive/zero corners (``||m|| <= zero_threshold``) are
    excluded from the weighted sum, and antipodal cancellation
    (``||m_tilde|| <= zero_threshold``) deterministically falls back to
    ``nearest`` so every active output vector remains finite with unit norm.
    """
    np = _require_numpy()
    origin_was_explicit = source_origin is not None
    if isinstance(source_values, FieldState):
        if source_values.component_count != 3:
            raise ValueError(
                f"magnetization resampling requires 3-component vector data (valuedim=3), got valuedim={source_values.component_count}"
            )
        if source_grid_shape is None:
            source_grid_shape = source_values.grid_shape
        if source_origin is None:
            source_origin = source_values.grid_origin
            origin_was_explicit = source_values.origin_explicit
        if source_spacing is None:
            source_spacing = source_values.grid_spacing
        raw_src = source_values.values
    elif isinstance(source_values, SampledMagnetization):
        raw_src = source_values.values
    else:
        raw_src = source_values

    src = np.asarray(raw_src, dtype=np.float64)
    if src.ndim == 4 and src.shape[-1] == 3:
        d0, d1, d2, _ = src.shape
        if source_grid_shape is not None:
            gx, gy, gz = (
                int(source_grid_shape[0]),
                int(source_grid_shape[1]),
                int(source_grid_shape[2]),
            )
            if (d0, d1, d2) != (gz, gy, gx):
                if (d0, d1, d2) == (gx, gy, gz):
                    raise ValueError(
                        f"4D source_values shape {tuple(src.shape)} uses [Nx, Ny, Nz, 3] order instead of canonical [Nz, Ny, Nx, 3]=({gz}, {gy}, {gx}, 3) for source_grid_shape={source_grid_shape}; transpose with src.transpose(2, 1, 0, 3) first"
                    )
                raise ValueError(
                    f"4D source_values shape {tuple(src.shape)} does not match canonical [Nz, Ny, Nx, 3]=({gz}, {gy}, {gx}, 3) for source_grid_shape={source_grid_shape}"
                )
            nz, ny, nx = gz, gy, gx
        else:
            nz, ny, nx = d0, d1, d2
            source_grid_shape = (int(nx), int(ny), int(nz))
        src = np.ascontiguousarray(src).reshape((nx * ny * nz, 3))
    elif src.ndim != 2 or src.shape[1] != 3:
        raise ValueError(
            f"source_values must have shape [N, 3] (valuedim=3), got {tuple(src.shape)}"
        )

    pts = np.asarray(target_points, dtype=np.float64)
    if pts.ndim == 1:
        pts = pts.reshape((1, 3))
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"target_points must have shape [M, 3], got {tuple(pts.shape)}")

    mode = interpolation.strip().lower()
    if mode == "exact":
        if src.shape[0] != pts.shape[0]:
            raise ValueError(
                f"exact interpolation requires source count ({src.shape[0]}) == target count ({pts.shape[0]})"
            )
        if source_grid_shape is not None and target_grid_shape is not None and source_grid_shape != target_grid_shape:
            raise ValueError(
                f"exact interpolation grid mismatch: source {source_grid_shape} != target {target_grid_shape}"
            )
        out = src.copy()
        if normalize:
            norms = np.linalg.norm(out, axis=1, keepdims=True)
            nonzero = norms > zero_threshold
            out = np.where(nonzero, out / np.where(nonzero, norms, 1.0), 0.0)
        return out

    if mode not in {"nearest", "trilinear"}:
        raise ValueError(f"unsupported interpolation mode '{interpolation}'; expected exact, nearest, or trilinear")

    if source_grid_shape is None or source_origin is None or source_spacing is None:
        raise ValueError(
            f"interpolation='{mode}' requires source_grid_shape, source_origin, and source_spacing"
        )
    nx, ny, nz = (int(source_grid_shape[0]), int(source_grid_shape[1]), int(source_grid_shape[2]))
    if nx <= 0 or ny <= 0 or nz <= 0 or nx * ny * nz != src.shape[0]:
        raise ValueError(
            f"source_grid_shape {source_grid_shape} does not match source vector count {src.shape[0]}"
        )
    origin = (float(source_origin[0]), float(source_origin[1]), float(source_origin[2]))
    spacing = (float(source_spacing[0]), float(source_spacing[1]), float(source_spacing[2]))
    if not all(math.isfinite(o) for o in origin):
        raise ValueError("source_origin components must be finite")
    if not all(math.isfinite(s) and s > 0.0 for s in spacing):
        raise ValueError("source_spacing components must be finite and positive")

    if pts.shape[0] > 0:
        src_min = np.array(origin, dtype=np.float64)
        src_max = src_min + np.array([nx, ny, nz], dtype=np.float64) * np.array(
            spacing, dtype=np.float64
        )
        tol_bound = 1.0e-9 * np.array(spacing, dtype=np.float64)
        in_bounds = np.all(
            (pts >= (src_min - tol_bound)) & (pts <= (src_max + tol_bound)),
            axis=1,
        )
        n_out = int(pts.shape[0] - int(np.sum(in_bounds)))
        if n_out == pts.shape[0]:
            pts_min = pts.min(axis=0).tolist()
            pts_max = pts.max(axis=0).tolist()
            raise ValueError(
                f"source grid bounding box [{src_min.tolist()} .. {src_max.tolist()}] m "
                f"does not overlap target points [{pts_min} .. {pts_max}] m; "
                "pass explicit source_origin=(...) when importing a [0, L] grid onto a centered [-L/2, L/2] domain"
            )
        if n_out > 0 or not origin_was_explicit:
            diag_parts: list[str] = []
            if not origin_was_explicit:
                diag_parts.append(
                    "source OVF header omitted xmin/ymin/zmin so origin defaulted to (0, 0, 0) m"
                )
            if n_out > 0:
                diag_parts.append(
                    f"{n_out} of {pts.shape[0]} target points lie outside source grid bounds "
                    f"[{src_min.tolist()} .. {src_max.tolist()}] m and were clamped to boundary cells"
                )
            warnings.warn(
                "; ".join(diag_parts)
                + " (pass explicit source_origin=(...) if source/target domain origins differ)",
                UserWarning,
                stacklevel=2,
            )

    # Canonical x-fastest flat layout maps to [nz, ny, nx, 3]
    grid = np.ascontiguousarray(src).reshape((nz, ny, nx, 3))
    result = np.zeros((pts.shape[0], 3), dtype=np.float64)

    for idx in range(pts.shape[0]):
        px, py, pz = float(pts[idx, 0]), float(pts[idx, 1]), float(pts[idx, 2])
        if mode == "nearest":
            vx, vy, vz = _nearest_nonzero_cell(
                grid, nx, ny, nz, origin, spacing, (px, py, pz), zero_threshold
            )
            norm = math.sqrt(vx * vx + vy * vy + vz * vz)
            if normalize and norm > zero_threshold:
                result[idx] = (vx / norm, vy / norm, vz / norm)
            else:
                result[idx] = (vx, vy, vz)
            continue

        # Trilinear + unit renormalization with deterministic Nearest fallback on antipodal cancellation
        ux = (px - (origin[0] + 0.5 * spacing[0])) / spacing[0]
        uy = (py - (origin[1] + 0.5 * spacing[1])) / spacing[1]
        uz = (pz - (origin[2] + 0.5 * spacing[2])) / spacing[2]

        ux_c = max(0.0, min(float(nx - 1), ux))
        uy_c = max(0.0, min(float(ny - 1), uy))
        uz_c = max(0.0, min(float(nz - 1), uz))

        ix0 = int(math.floor(ux_c))
        iy0 = int(math.floor(uy_c))
        iz0 = int(math.floor(uz_c))
        ix1 = min(ix0 + 1, nx - 1)
        iy1 = min(iy0 + 1, ny - 1)
        iz1 = min(iz0 + 1, nz - 1)

        tx = ux_c - ix0
        ty = uy_c - iy0
        tz = uz_c - iz0

        acc_x = 0.0
        acc_y = 0.0
        acc_z = 0.0
        weight_sum = 0.0
        for dz_i, jz, wz in ((0, iz0, 1.0 - tz), (1, iz1, tz)):
            if dz_i == 1 and iz1 == iz0:
                continue
            w_z = 1.0 if iz1 == iz0 else wz
            for dy_i, jy, wy in ((0, iy0, 1.0 - ty), (1, iy1, ty)):
                if dy_i == 1 and iy1 == iy0:
                    continue
                w_yz = w_z * (1.0 if iy1 == iy0 else wy)
                for dx_i, jx, wx in ((0, ix0, 1.0 - tx), (1, ix1, tx)):
                    if dx_i == 1 and ix1 == ix0:
                        continue
                    w = w_yz * (1.0 if ix1 == ix0 else wx)
                    if w <= 0.0:
                        continue
                    c = grid[jz, jy, jx]
                    cnorm = math.sqrt(float(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]))
                    if cnorm <= zero_threshold:
                        continue
                    acc_x += w * float(c[0])
                    acc_y += w * float(c[1])
                    acc_z += w * float(c[2])
                    weight_sum += w

        acc_norm = math.sqrt(acc_x * acc_x + acc_y * acc_y + acc_z * acc_z)
        if acc_norm <= zero_threshold:
            vx, vy, vz = _nearest_nonzero_cell(
                grid, nx, ny, nz, origin, spacing, (px, py, pz), zero_threshold
            )
            nnorm = math.sqrt(vx * vx + vy * vy + vz * vz)
            if normalize and nnorm > zero_threshold:
                result[idx] = (vx / nnorm, vy / nnorm, vz / nnorm)
            else:
                result[idx] = (vx, vy, vz)
        elif normalize:
            result[idx] = (acc_x / acc_norm, acc_y / acc_norm, acc_z / acc_norm)
        else:
            inv_w = 1.0 / weight_sum if weight_sum > zero_threshold else 1.0
            result[idx] = (acc_x * inv_w, acc_y * inv_w, acc_z * inv_w)

    return result
