from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Sequence

from .magnetization import SampledMagnetization

MAGNETIZATION_STATE_FORMATS = ("json", "zarr", "h5")


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


def _write_h5_state(path: Path, values: np.ndarray, *, dataset: str) -> None:
    h5py = _require_h5py()
    with h5py.File(path, "w") as handle:
        target = _ensure_h5_dataset(handle, dataset, values)
        handle.attrs["fullmag_kind"] = "magnetization_state"
        handle.attrs["observable"] = "m"
        handle.attrs["format"] = "h5"
        target.attrs["observable"] = "m"
        target.attrs["vector_count"] = int(values.shape[0])


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
