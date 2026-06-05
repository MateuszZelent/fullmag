from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .magnetization import SampledMagnetization

MAGNETIZATION_STATE_FORMATS = ("json", "zarr", "h5")
FIELD_STATE_FORMATS = ("zarr", "h5")


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

    @property
    def component_count(self) -> int:
        return len(self.values[0]) if self.values else 0

    def as_sampled_magnetization(self) -> SampledMagnetization:
        if self.quantity_id != "m":
            raise ValueError("only quantity 'm' can be used as sampled magnetization")
        return SampledMagnetization(
            self.values,
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
) -> FieldState:
    resolved = _resolve_state_path(path)
    normalized_format = _normalize_field_state_format(resolved, format)

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
    else:
        raise ValueError(f"unsupported field state format '{normalized_format}'")

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
    return "json"


def _normalize_field_state_format(path: Path, format: str) -> str:
    normalized = format.strip().lower()
    if normalized and normalized != "auto":
        if normalized == "hdf5":
            return "h5"
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
    raise ValueError("field state path must end with .zarr, .zarr.zip, .h5, or .hdf5")


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
