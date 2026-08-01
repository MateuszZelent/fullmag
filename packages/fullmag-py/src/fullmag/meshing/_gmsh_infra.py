from __future__ import annotations

import os
from pathlib import Path
import threading
import time
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress
from fullmag.model.geometry import Geometry, Translate

from ._gmsh_types import MeshData, _rebuild_mixed_layer_topology_certificate


def _peel_translate_chain(
    geometry: Geometry,
) -> tuple[tuple[float, float, float], Geometry]:
    """Collapse a chain of ``Translate`` wrappers into an accumulated offset.

    Returns ``(accumulated_offset, inner_geometry)`` where *inner_geometry* is
    the first non-``Translate`` node in the chain.
    """
    dx, dy, dz = 0.0, 0.0, 0.0
    g: Geometry = geometry
    while isinstance(g, Translate):
        ox, oy, oz = g.offset
        dx += ox
        dy += oy
        dz += oz
        g = g.geometry
    return (dx, dy, dz), g


def _import_gmsh() -> Any:
    try:
        import gmsh  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "Gmsh Python SDK is required for FEM meshing. "
            "Install with: python -m pip install 'gmsh>=4.15,<5'"
        ) from exc
    return gmsh


def _import_meshio() -> Any:
    try:
        import meshio  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "meshio is required to read pre-generated mesh files. "
            "Install with: python -m pip install 'meshio>=5.3.5,<6'"
        ) from exc
    return meshio



def _normalize_scale_xyz(scale: float | tuple[float, float, float]) -> NDArray[np.float64]:
    if isinstance(scale, (int, float)):
        return np.full(3, float(scale), dtype=np.float64)
    return np.asarray(scale, dtype=np.float64)


def _source_hmax_from_scale(hmax: float, scale_xyz: NDArray[np.float64]) -> float:
    # Imported files are meshed in their own source coordinates. Convert the
    # requested SI hmax into a source-space target using the most restrictive
    # axis so anisotropic scales do not under-resolve the final SI geometry.
    positive_scales = scale_xyz[scale_xyz > 0]
    if positive_scales.size == 0:
        raise ValueError("imported geometry scale must be strictly positive")
    return float(hmax / float(np.max(positive_scales)))


def _scale_mesh_nodes(mesh: MeshData, scale_xyz: NDArray[np.float64]) -> MeshData:
    scale_xyz = np.asarray(scale_xyz, dtype=np.float64)
    if scale_xyz.shape != (3,) or not np.all(np.isfinite(scale_xyz)) or np.any(scale_xyz <= 0.0):
        raise ValueError("mesh scale must contain exactly three finite positive values")
    if np.array_equal(scale_xyz, np.ones(3, dtype=np.float64)):
        return mesh
    certificate = mesh.mixed_layer_topology_certificate
    if certificate is not None and not (
        scale_xyz[0] == scale_xyz[1] == scale_xyz[2]
    ):
        raise ValueError(
            "anisotropic scaling of a certified mixed shared-domain mesh is not qualified"
        )
    scaled = MeshData(
        nodes=np.asarray(mesh.nodes, dtype=np.float64) * scale_xyz.reshape(1, 3),
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        element_markers=mesh.element_markers,
        facet_types=mesh.facet_types,
        facet_roles=mesh.facet_roles,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
        boundary_markers=mesh.boundary_markers,
        cell_global_ordinals=mesh.cell_global_ordinals,
        facet_global_ordinals=mesh.facet_global_ordinals,
        cell_mesh_parts=mesh.cell_mesh_parts,
        periodic_boundary_pairs=mesh.periodic_boundary_pairs,
        periodic_node_pairs=mesh.periodic_node_pairs,
        periodic_mesh_certificate=mesh.periodic_mesh_certificate,
        quality=mesh.quality,
        per_domain_quality=mesh.per_domain_quality,
        realization_report=mesh.realization_report,
    )
    if certificate is not None:
        return _rebuild_mixed_layer_topology_certificate(
            scaled,
            certificate,
            authored_scale=float(scale_xyz[0]),
        )
    return scaled




def _resolve_gmsh_thread_count(requested_threads: int | None = None) -> int:
    for env_var in ("FULLMAG_GMSH_THREADS", "FULLMAG_CPU_THREADS"):
        env_value = os.environ.get(env_var)
        if env_value:
            try:
                parsed = int(env_value)
                if parsed >= 1:
                    return parsed
            except ValueError:
                pass
    if requested_threads is not None and requested_threads >= 1:
        return requested_threads
    cpu_total = os.cpu_count() or 1
    return max(1, cpu_total)


def _configure_gmsh_threads(
    gmsh: Any,
    requested_threads: int | None = None,
    *,
    honor_environment: bool = True,
) -> int:
    thread_count = (
        _resolve_gmsh_thread_count(requested_threads)
        if honor_environment
        else max(1, int(requested_threads or 1))
    )
    gmsh.option.setNumber("General.NumThreads", thread_count)
    gmsh.option.setNumber("Mesh.MaxNumThreads1D", thread_count)
    gmsh.option.setNumber("Mesh.MaxNumThreads2D", thread_count)
    gmsh.option.setNumber("Mesh.MaxNumThreads3D", thread_count)
    emit_progress(f"Gmsh: multithreading enabled ({thread_count} threads)")
    return thread_count


def _normalize_gmsh_log_line(message: str) -> str | None:
    text = message.strip()
    if not text:
        return None
    if text.startswith("Info: "):
        text = text[len("Info: ") :].strip()
    elif text.startswith("Progress: "):
        text = text[len("Progress: ") :].strip()

    lower = text.lower()
    if not text:
        return None
    if lower.startswith("meshing curve "):
        return None
    if lower.startswith("meshing surface ") and "[" not in text:
        return None
    if lower.startswith("optimizing volume "):
        return None
    if lower.startswith("0.00 < quality <") or lower.startswith("0.10 < quality <"):
        return None
    if lower.startswith("0.20 < quality <") or lower.startswith("0.30 < quality <"):
        return None
    if lower.startswith("0.40 < quality <") or lower.startswith("0.50 < quality <"):
        return None
    if lower.startswith("0.60 < quality <") or lower.startswith("0.70 < quality <"):
        return None
    if lower.startswith("0.80 < quality <") or lower.startswith("0.90 < quality <"):
        return None
    if lower.startswith("progress:"):
        return None
    if "[" in text and "%" in text:
        return f"Gmsh: {text}"
    if (
        "tetrahedrizing" in lower
        or "reconstructing mesh" in lower
        or "creating surface mesh" in lower
        or "identifying boundary edges" in lower
        or "recovering boundary" in lower
        or "3d meshing" in lower
        or "refinement terminated" in lower
        or lower.startswith("it. ")
        or "done tetrahedrizing" in lower
        or "done reconstructing mesh" in lower
        or "done meshing 3d" in lower
        or "optimizing mesh" in lower
        or "optimization starts" in lower
        or "edge swaps" in lower
        or "no ill-shaped tets" in lower
    ):
        return f"Gmsh: {text}"
    return None


def _phase_from_gmsh_message(message: str | None) -> str:
    if not message:
        return "generating 3D mesh"
    lower = message.lower()
    if "meshing curve" in lower or "meshing 1d" in lower:
        return "meshing curves"
    if "meshing surface" in lower or "meshing 2d" in lower:
        return "meshing surfaces"
    if "meshing volume" in lower or "meshing 3d" in lower:
        return "meshing 3D volume"
    if (
        "tetrahedrizing" in lower
        or "reconstructing mesh" in lower
        or "recovering boundary" in lower
        or "done tetrahedrizing" in lower
        or "done reconstructing mesh" in lower
    ):
        return "generating 3D mesh"
    if "optimizing mesh" in lower or "optimization starts" in lower or "edge swaps" in lower:
        return "optimizing mesh"
    return "generating 3D mesh"


def _format_gmsh_heartbeat(
    elapsed_s: float,
    last_message: str | None = None,
    *,
    backend_idle_s: float | None = None,
) -> str:
    label = _phase_from_gmsh_message(last_message)
    suffix = ""
    if last_message:
        last = last_message.removeprefix("Gmsh: ").strip()
        suffix = f"; last: {last}"
    idle_detail = (
        f"no detailed backend update for {backend_idle_s:.1f}s"
        if last_message and backend_idle_s is not None
        else "no detailed backend update yet"
    )
    return f"Gmsh: meshing active ({label}; {elapsed_s:.1f}s elapsed; {idle_detail}{suffix})"


def _gmsh_heartbeat_interval(elapsed_s: float, base_interval_s: float) -> float:
    if elapsed_s < 30.0:
        return base_interval_s
    if elapsed_s < 120.0:
        return max(base_interval_s, 15.0)
    return max(base_interval_s, 30.0)


class _GmshProgressLogger:
    def __init__(
        self,
        gmsh: Any,
        poll_interval_s: float = 0.2,
        heartbeat_interval_s: float = 5.0,
    ) -> None:
        self._gmsh = gmsh
        self._poll_interval_s = poll_interval_s
        self._heartbeat_interval_s = heartbeat_interval_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seen_count = 0
        self._started_at = 0.0
        self._last_emit_at = 0.0
        self._last_detail_at = 0.0
        self._last_normalized_message: str | None = None
        self._logger_error_reported = False

    def __enter__(self) -> "_GmshProgressLogger":
        self._gmsh.logger.start()
        now = time.monotonic()
        self._started_at = now
        self._last_emit_at = now
        self._last_detail_at = now
        self._thread = threading.Thread(target=self._poll, name="fullmag-gmsh-progress", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(0.5, self._poll_interval_s * 4))
        self._flush()
        try:
            self._gmsh.logger.stop()
        except Exception:
            pass

    def _poll(self) -> None:
        while not self._stop.wait(self._poll_interval_s):
            emitted = self._flush()
            now = time.monotonic()
            elapsed = now - self._started_at
            heartbeat_interval = _gmsh_heartbeat_interval(
                elapsed,
                self._heartbeat_interval_s,
            )
            if not emitted and now - self._last_emit_at >= heartbeat_interval:
                backend_idle = now - self._last_detail_at
                emit_progress(
                    _format_gmsh_heartbeat(
                        elapsed,
                        self._last_normalized_message,
                        backend_idle_s=backend_idle,
                    )
                )
                self._last_emit_at = now

    def _flush(self) -> bool:
        try:
            messages = self._gmsh.logger.get()
        except Exception as exc:
            if not self._logger_error_reported:
                emit_progress(
                    "Gmsh telemetry warning: failed to read native progress log "
                    f"({exc}); mesh progress is indeterminate"
                )
                self._logger_error_reported = True
            return False
        if self._seen_count > len(messages):
            self._seen_count = 0
        new_messages = messages[self._seen_count :]
        self._seen_count = len(messages)
        emitted_any = False
        for message in new_messages:
            normalized = _normalize_gmsh_log_line(message)
            if normalized:
                self._last_detail_at = time.monotonic()
                emit_progress(normalized)
                self._last_normalized_message = normalized
                emitted_any = True
                self._last_emit_at = time.monotonic()
        return emitted_any
