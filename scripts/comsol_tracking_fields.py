"""Hash-bound modal envelopes for independent tracking replay.

This reader validates fields/geometry/metric, not branch assignment or physics.
It never turns successful input validation into a scientific qualification.
"""
from pathlib import Path
import hashlib
import json

import numpy as np

from comsol_modal_field_certificate import validate_modal_field_certificate, DEFAULT_PHASE_TOLERANCE
from comsol_mesh_identity import mesh_topology_fingerprint_v3
from comsol_magnetic_support import magnetic_element_indices, tet4_cells
from comsol_tracking_metric import Tet4TrackingMetric


def load_tracking_fields(case_dir, mode_selections, *, phase_tolerance=DEFAULT_PHASE_TOLERANCE):
    """Read exactly the certificate-bound bytes, or raise ValueError.

    Caller must still bind these mode IDs, frequencies and k to the spectrum
    and replay the recorded branch edges. Returned envelopes are full XYZ.
    """
    root = Path(case_dir)
    if not mode_selections:
        raise ValueError("explicit nonempty tracking mode selections required")
    certificate = validate_modal_field_certificate(
        root, mode_selections=mode_selections, phase_tolerance=phase_tolerance
    )
    if certificate["status"] != "pass":
        raise ValueError("tracking field phase certificate failed: " + "; ".join(certificate["reasons"]))
    hashes = {item["path"]: item["sha256"] for item in certificate["file_hashes"]}

    def bound_bytes(relative):
        # Reject links again: they may have changed since certification.
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or relative not in hashes:
            raise ValueError("uncertified tracking input path")
        path = root / relative_path
        for candidate in (path, *path.parents):
            if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
                raise ValueError("tracking input path became a link")
            if candidate == root:
                break
        data = path.read_bytes()
        if "sha256:" + hashlib.sha256(data).hexdigest() != hashes[relative]:
            raise ValueError("tracking input changed after phase certification")
        return data

    metadata = json.loads(bound_bytes("metadata.json"))
    plan = metadata["execution_plan"]["backend_plan"]
    mesh = plan["mesh"]
    fingerprint = mesh_topology_fingerprint_v3(mesh)
    metric = Tet4TrackingMetric(mesh["nodes"], tet4_cells(mesh),
                                magnetic_element_indices(mesh, plan.get("mesh_parts")))
    modes = {}
    for report in certificate["modes"]:
        mode = json.loads(bound_bytes(report["metadata_path"]))
        if mode.get("source_mesh_topology_sha256") != fingerprint:
            raise ValueError("modal mesh fingerprint differs from actual geometry")
        if mode.get("node_mass_weights") is not None:
            raise ValueError("diagonal mass cannot accompany consistent tracking metric")
        metric.validate_persisted_metric(mode.get("tracking_consistent_p1_metric"), fingerprint)
        data = bound_bytes(report["vector_path"])
        scalars = np.frombuffer(data, dtype="<f8").reshape((-1, 3, 2))
        field = scalars[:, :, 0] + 1j * scalars[:, :, 1]
        envelope = metric.envelope(field, report["k_vector_rad_per_m"])
        metric.normalized(envelope)  # Reject an identically zero magnetic field.
        key = (report["sample_index"], report["raw_mode_index"])
        if key in modes:
            raise ValueError("duplicate modal identity")
        modes[key] = {"envelope": envelope, "k_vector_rad_per_m": report["k_vector_rad_per_m"],
                      "frequency_real_hz": mode.get("frequency_real_hz"),
                      "frequency_imag_hz": mode.get("frequency_imag_hz")}
    return {"metric": metric, "modes": modes, "file_hashes": certificate["file_hashes"],
            "source_mesh_topology_sha256": fingerprint, "qualification": "NOT VERIFIED"}
