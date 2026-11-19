"""VTK XML UnstructuredGrid (``.vtu``) and ParaView (``.pvd`` / ``.vtu.zip``) writers."""

from __future__ import annotations

import base64
from pathlib import Path
import struct
from typing import Any, Mapping, Sequence
from xml.sax.saxutils import escape, quoteattr
import zipfile

import numpy as np
from numpy.typing import ArrayLike, NDArray

from .gltf_writer import resolve_coordinate_transform

VTK_CELL_TYPE_CODES: dict[str, int] = {
    "vertex": 1,
    "line": 3,
    "tri3": 5,
    "triangle": 5,
    "quad4": 9,
    "quad": 9,
    "tet4": 10,
    "tetra": 10,
    "tetrahedron": 10,
    "hex8": 12,
    "hexahedron": 12,
    "prism6": 13,
    "wedge": 13,
    "pyramid5": 14,
    "pyramid": 14,
}

_DTYPE_TO_VTK: dict[str, tuple[str, str]] = {
    "float64": ("Float64", "<f8"),
    "float32": ("Float32", "<f4"),
    "uint8": ("UInt8", "|u1"),
    "int8": ("Int8", "|i1"),
    "uint16": ("UInt16", "<u2"),
    "int16": ("Int16", "<i2"),
    "uint32": ("UInt32", "<u4"),
    "int32": ("Int32", "<i4"),
    "uint64": ("UInt64", "<u8"),
    "int64": ("Int64", "<i8"),
}


def _normalize_cell_types(cell_types: ArrayLike | int | str, cell_count: int) -> NDArray[np.uint8]:
    if isinstance(cell_types, (int, np.integer)):
        return np.full((cell_count,), int(cell_types), dtype=np.uint8)
    if isinstance(cell_types, str):
        key = cell_types.strip().lower()
        if key not in VTK_CELL_TYPE_CODES:
            raise ValueError(f"unsupported VTK cell type '{cell_types}'")
        return np.full((cell_count,), VTK_CELL_TYPE_CODES[key], dtype=np.uint8)

    raw = np.asarray(cell_types)
    if raw.ndim != 1 or raw.shape[0] != cell_count:
        raise ValueError(f"cell_types must have length {cell_count}, got shape {raw.shape}")
    if raw.dtype.kind in {"U", "S", "O"}:
        codes = []
        for item in raw.tolist():
            key = str(item).strip().lower()
            if key not in VTK_CELL_TYPE_CODES:
                raise ValueError(f"unsupported VTK cell type '{item}'")
            codes.append(VTK_CELL_TYPE_CODES[key])
        return np.asarray(codes, dtype=np.uint8)
    return raw.astype(np.uint8, copy=False)


def _normalize_cells(
    cells: ArrayLike | tuple[ArrayLike, ArrayLike],
) -> tuple[NDArray[np.int64], NDArray[np.int64], int]:
    """Return ``(connectivity_1d, offsets_1d, cell_count)`` in VTK CSR layout."""
    if isinstance(cells, tuple) and len(cells) == 2:
        conn = np.asarray(cells[0], dtype=np.int64).ravel()
        offs = np.asarray(cells[1], dtype=np.int64).ravel()
        if offs.size == 0:
            return conn, offs, 0
        # Support either N+1 CSR offsets ([0, ..., M]) or VTK N end-offsets ([k0, k0+k1, ...]).
        if offs[0] == 0 and offs.size > 1:
            vtk_offsets = offs[1:]
        else:
            vtk_offsets = offs
        return conn, vtk_offsets, int(vtk_offsets.shape[0])

    arr = np.asarray(cells, dtype=np.int64)
    if arr.ndim != 2 or arr.shape[1] < 1:
        raise ValueError(
            "cells must be a 2D array (C, nodes_per_cell) or a (connectivity, offsets) tuple"
        )
    cell_count, arity = arr.shape
    conn = arr.ravel()
    vtk_offsets = np.arange(1, cell_count + 1, dtype=np.int64) * arity
    return conn, vtk_offsets, cell_count


def _encode_data_array(
    array: np.ndarray,
    *,
    name: str,
    encoding: str,
    header_type: str,
    indent: str = "        ",
) -> str:
    arr = np.ascontiguousarray(array)
    dtype_name = arr.dtype.name
    if dtype_name not in _DTYPE_TO_VTK:
        if arr.dtype.kind == "b":
            arr = arr.astype(np.uint8)
            dtype_name = "uint8"
        elif arr.dtype.kind in {"i", "u"}:
            arr = arr.astype(np.int64)
            dtype_name = "int64"
        else:
            arr = arr.astype(np.float64)
            dtype_name = "float64"

    vtk_type, le_dtype = _DTYPE_TO_VTK[dtype_name]
    n_comp = 1 if arr.ndim == 1 else int(arr.shape[1])
    comp_attr = f' NumberOfComponents="{n_comp}"' if n_comp > 1 else ""

    if encoding == "ascii":
        flat = arr.ravel()
        if arr.dtype.kind in {"i", "u"}:
            text = " ".join(str(int(v)) for v in flat.tolist())
        else:
            text = " ".join(f"{float(v):.17g}" for v in flat.tolist())
        return (
            f'{indent}<DataArray type="{vtk_type}" Name={quoteattr(name)}'
            f'{comp_attr} format="ascii">{text}</DataArray>'
        )

    le_bytes = arr.astype(le_dtype, copy=False).tobytes(order="C")
    hdr_fmt = "<Q" if header_type == "UInt64" else "<I"
    payload = struct.pack(hdr_fmt, len(le_bytes)) + le_bytes
    b64 = base64.b64encode(payload).decode("ascii")
    return (
        f'{indent}<DataArray type="{vtk_type}" Name={quoteattr(name)}'
        f'{comp_attr} format="binary">{b64}</DataArray>'
    )


def _format_attribute_block(
    tag_name: str,
    arrays: Mapping[str, ArrayLike] | None,
    expected_count: int,
    *,
    encoding: str,
    header_type: str,
) -> list[str]:
    if not arrays:
        return [f"      <{tag_name}/>"]

    normalized: list[tuple[str, np.ndarray]] = []
    default_vectors: str | None = None
    default_scalars: str | None = None

    for key, raw_val in arrays.items():
        arr = np.asarray(raw_val)
        if arr.ndim == 0 or arr.shape[0] != expected_count:
            raise ValueError(
                f"{tag_name} array '{key}' leading dimension {arr.shape[0] if arr.ndim else 0} "
                f"does not match expected count {expected_count}"
            )
        if arr.ndim > 2:
            arr = arr.reshape(expected_count, -1)
        normalized.append((str(key), arr))
        if (
            default_vectors is None
            and arr.ndim == 2
            and arr.shape[1] == 3
            and arr.dtype.kind == "f"
        ):
            default_vectors = str(key)
        if default_scalars is None and (arr.ndim == 1 or (arr.ndim == 2 and arr.shape[1] == 1)):
            default_scalars = str(key)

    attrs: list[str] = []
    if default_scalars is not None:
        attrs.append(f"Scalars={quoteattr(default_scalars)}")
    if default_vectors is not None:
        attrs.append(f"Vectors={quoteattr(default_vectors)}")
    attr_str = (" " + " ".join(attrs)) if attrs else ""

    lines = [f"      <{tag_name}{attr_str}>"]
    for name, arr in normalized:
        lines.append(
            _encode_data_array(
                arr,
                name=name,
                encoding=encoding,
                header_type=header_type,
                indent="        ",
            )
        )
    lines.append(f"      </{tag_name}>")
    return lines


def serialize_vtu_xml(
    *,
    points_m: ArrayLike,
    cells: ArrayLike | tuple[ArrayLike, ArrayLike],
    cell_types: ArrayLike | int | str,
    point_data: Mapping[str, ArrayLike] | None = None,
    cell_data: Mapping[str, ArrayLike] | None = None,
    field_data: Mapping[str, Any] | None = None,
    coordinate_scale: str = "si_m",
    encoding: str = "binary",
) -> str:
    """Serialize a VTK XML UnstructuredGrid (``.vtu``) document as UTF-8 text."""
    enc = encoding.strip().lower()
    if enc not in {"binary", "ascii"}:
        raise ValueError(f"VTK encoding must be 'binary' or 'ascii', got '{encoding}'")

    pts = np.asarray(points_m, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"points_m must have shape (N, 3), got {pts.shape}")

    coord_scale, origin_offset_m, _ = resolve_coordinate_transform(
        [pts],
        coordinate_scale=coordinate_scale,
    )
    scaled_pts = (pts - np.asarray(origin_offset_m, dtype=np.float64)) * coord_scale

    conn, offsets, cell_count = _normalize_cells(cells)
    types_arr = _normalize_cell_types(cell_types, cell_count)
    n_points = int(scaled_pts.shape[0])

    if conn.size > 0 and (int(np.min(conn)) < 0 or int(np.max(conn)) >= n_points):
        raise ValueError("cell connectivity index out of bounds for points_m")

    idx_dtype = np.int32 if (n_points < 2**31 and conn.size < 2**31) else np.int64
    conn_arr = conn.astype(idx_dtype, copy=False)
    offs_arr = offsets.astype(idx_dtype, copy=False)

    max_payload = max(
        scaled_pts.nbytes,
        conn_arr.nbytes,
        offs_arr.nbytes,
        types_arr.nbytes,
        *(
            np.asarray(v).nbytes
            for group in (point_data, cell_data)
            if group
            for v in group.values()
        ),
    )
    header_type = "UInt64" if max_payload >= (2**32) else "UInt32"

    lines: list[str] = [
        '<?xml version="1.0" encoding="utf-8"?>',
        (
            f'<VTKFile type="UnstructuredGrid" version="0.1" '
            f'byte_order="LittleEndian" header_type="{header_type}">'
        ),
        "  <UnstructuredGrid>",
    ]

    if field_data:
        lines.append("    <FieldData>")
        for key, value in field_data.items():
            if isinstance(value, str):
                encoded = value.encode("utf-8")
                arr = np.frombuffer(encoded + b"\x00", dtype=np.uint8)
                lines.append(
                    _encode_data_array(
                        arr,
                        name=str(key),
                        encoding="ascii",
                        header_type=header_type,
                        indent="      ",
                    )
                )
            else:
                arr = np.atleast_1d(np.asarray(value, dtype=np.float64)).ravel()
                lines.append(
                    _encode_data_array(
                        arr,
                        name=str(key),
                        encoding="ascii",
                        header_type=header_type,
                        indent="      ",
                    )
                )
        lines.append("    </FieldData>")

    lines.append(f'    <Piece NumberOfPoints="{n_points}" NumberOfCells="{cell_count}">')
    lines.extend(
        _format_attribute_block(
            "PointData",
            point_data,
            n_points,
            encoding=enc,
            header_type=header_type,
        )
    )
    lines.extend(
        _format_attribute_block(
            "CellData",
            cell_data,
            cell_count,
            encoding=enc,
            header_type=header_type,
        )
    )

    lines.append("      <Points>")
    lines.append(
        _encode_data_array(
            scaled_pts,
            name="Points",
            encoding=enc,
            header_type=header_type,
            indent="        ",
        )
    )
    lines.append("      </Points>")

    lines.append("      <Cells>")
    lines.append(
        _encode_data_array(
            conn_arr,
            name="connectivity",
            encoding=enc,
            header_type=header_type,
            indent="        ",
        )
    )
    lines.append(
        _encode_data_array(
            offs_arr,
            name="offsets",
            encoding=enc,
            header_type=header_type,
            indent="        ",
        )
    )
    lines.append(
        _encode_data_array(
            types_arr,
            name="types",
            encoding=enc,
            header_type=header_type,
            indent="        ",
        )
    )
    lines.append("      </Cells>")
    lines.append("    </Piece>")
    lines.append("  </UnstructuredGrid>")
    lines.append("</VTKFile>")
    return "\n".join(lines) + "\n"


def export_vtu(
    output_path: str | Path,
    *,
    points_m: ArrayLike,
    cells: ArrayLike | tuple[ArrayLike, ArrayLike],
    cell_types: ArrayLike | int | str,
    point_data: Mapping[str, ArrayLike] | None = None,
    cell_data: Mapping[str, ArrayLike] | None = None,
    field_data: Mapping[str, Any] | None = None,
    coordinate_scale: str = "si_m",
    encoding: str = "binary",
) -> Path:
    """Write a VTK XML UnstructuredGrid ``.vtu`` file to ``output_path``."""
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    xml_text = serialize_vtu_xml(
        points_m=points_m,
        cells=cells,
        cell_types=cell_types,
        point_data=point_data,
        cell_data=cell_data,
        field_data=field_data,
        coordinate_scale=coordinate_scale,
        encoding=encoding,
    )
    target.write_text(xml_text, encoding="utf-8")
    return target


def build_pvd_xml(datasets: Sequence[tuple[float, str, str, int]]) -> str:
    """Build ParaView ``.pvd`` XML collection text for ``(timestep, file, group, part)``."""
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">',
        "  <Collection>",
    ]
    for timestep, rel_file, group, part in datasets:
        lines.append(
            f'    <DataSet timestep="{float(timestep):.17g}" '
            f'group={quoteattr(escape(group))} part="{int(part)}" '
            f"file={quoteattr(rel_file)}/>"
        )
    lines.extend(["  </Collection>", "</VTKFile>", ""])
    return "\n".join(lines)


def write_pvd_bundle(
    output_path: str | Path,
    frames: Sequence[Mapping[str, Any]],
    *,
    coordinate_scale: str = "si_m",
    encoding: str = "binary",
    zip_archive: bool | None = None,
) -> tuple[Path, tuple[Path, ...]]:
    """Write a ParaView ``.pvd`` collection + frame ``.vtu`` files or ``.vtu.zip`` archive."""
    if not frames:
        raise ValueError("frames must contain at least one frame to write a PVD collection")

    target = Path(output_path)
    lower_name = target.name.lower()
    use_zip = (
        zip_archive
        if zip_archive is not None
        else (lower_name.endswith(".vtu.zip") or lower_name.endswith(".zip"))
    )

    frame_xmls: list[tuple[float, str, str, int, str]] = []
    for index, frame in enumerate(frames):
        timestep = float(frame.get("timestep", float(index)))
        group = str(frame.get("group", ""))
        part = int(frame.get("part", 0))
        if "vtu_xml" in frame:
            xml_text = str(frame["vtu_xml"])
        else:
            xml_text = serialize_vtu_xml(
                points_m=frame["points_m"],
                cells=frame["cells"],
                cell_types=frame["cell_types"],
                point_data=frame.get("point_data"),
                cell_data=frame.get("cell_data"),
                field_data=frame.get("field_data"),
                coordinate_scale=str(frame.get("coordinate_scale", coordinate_scale)),
                encoding=str(frame.get("encoding", encoding)),
            )
        frame_filename = f"frame_{index:04d}.vtu"
        frame_xmls.append((timestep, frame_filename, group, part, xml_text))

    if use_zip:
        target.parent.mkdir(parents=True, exist_ok=True)
        datasets = [
            (ts, f"frames/{fname}", grp, part)
            for ts, fname, grp, part, _ in frame_xmls
        ]
        pvd_xml = build_pvd_xml(datasets)
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("series.pvd", pvd_xml.encode("utf-8"))
            for _, fname, _, _, xml_text in frame_xmls:
                zf.writestr(f"frames/{fname}", xml_text.encode("utf-8"))
        return target, (target,)

    if lower_name.endswith(".pvd"):
        pvd_path = target
        frames_dir_name = f"{target.stem}_frames"
        frames_dir = target.parent / frames_dir_name
        rel_prefix = frames_dir_name
    else:
        target.mkdir(parents=True, exist_ok=True)
        pvd_path = target / "series.pvd"
        frames_dir = target / "frames"
        rel_prefix = "frames"

    pvd_path.parent.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    datasets = []
    for ts, fname, grp, part, xml_text in frame_xmls:
        vtu_path = frames_dir / fname
        vtu_path.write_text(xml_text, encoding="utf-8")
        written.append(vtu_path)
        datasets.append((ts, f"{rel_prefix}/{fname}", grp, part))

    pvd_xml = build_pvd_xml(datasets)
    pvd_path.write_text(pvd_xml, encoding="utf-8")
    return pvd_path, (pvd_path, *written)


def export_pvd(
    output_path: str | Path,
    frames: Sequence[Mapping[str, Any]],
    *,
    coordinate_scale: str = "si_m",
    encoding: str = "binary",
    zip_archive: bool | None = None,
) -> Path:
    """Export a ParaView ``.pvd`` series (directory + ``.vtu`` frames or ``.vtu.zip``)."""
    primary_path, _ = write_pvd_bundle(
        output_path,
        frames,
        coordinate_scale=coordinate_scale,
        encoding=encoding,
        zip_archive=zip_archive,
    )
    return primary_path
