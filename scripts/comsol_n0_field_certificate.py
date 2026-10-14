"""Compute n0 diagnostics from independently checked native modal payloads."""
from pathlib import Path
import hashlib
import json
import math
import struct

from comsol_modal_field_certificate import validate_modal_field_certificate, DEFAULT_PHASE_TOLERANCE
from comsol_magnetic_support import magnetic_element_indices, tet4_cells
from comsol_n0_projection import tet4_n0_projection
from comsol_equilibrium_artifacts import read_sample_equilibrium


def measure_n0_field(case_dir, sample_index, raw_mode_index, *, expected_k, phase_tolerance=DEFAULT_PHASE_TOLERANCE, equilibrium_manifest=None):
    """Return measured diagnostics, never a scientific qualification verdict.

    The caller must check C1 material/equilibrium applicability and its justified
    profile tolerance. Every input is rechecked against the phase certificate.
    When equilibrium_manifest is supplied, the accepted per-sample state and
    its C1 orientation are mandatory; absence retains diagnostics-only use.
    """
    root = Path(case_dir)
    phase = validate_modal_field_certificate(root, mode_selections=[(sample_index, raw_mode_index)], phase_tolerance=phase_tolerance)
    result = {"schema_version": "fullmag.comsol-n0-field-measurement.v1", "status": "unverified", "reasons": [], "phase_certificate": phase}
    if phase["status"] != "pass":
        result["reasons"].extend(phase["reasons"])
        return result
    hashes = {item["path"]: item["sha256"] for item in phase["file_hashes"]}

    def bound_bytes(relative):
        # These paths came from the certificate, but reject changed links too.
        path = root / relative
        for candidate in (path, *path.parents):
            if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
                raise ValueError("modal input path became a link")
            if candidate == root:
                break
        data = path.read_bytes()
        if "sha256:" + hashlib.sha256(data).hexdigest() != hashes.get(relative):
            raise ValueError("modal input changed after phase certification")
        return data

    try:
        mode = phase["modes"][0]
        vector = mode["k_vector_rad_per_m"]
        if len(expected_k) != 3 or any(type(x) not in (int, float) for x in expected_k):
            raise ValueError("expected_k must contain three finite real numbers")
        if not all(math.isfinite(x) for x in expected_k):
            raise ValueError("expected_k must be finite")
        if any(abs(a-b) > 1e-10 * max(1.0, abs(a), abs(b)) for a, b in zip(vector, expected_k)):
            raise ValueError("modal field k does not match the numeric spectrum")
        metadata = json.loads(bound_bytes("metadata.json"))
        if equilibrium_manifest is not None:
            mode_metadata = json.loads(bound_bytes(mode["metadata_path"]))
            equilibrium = read_sample_equilibrium(root, equilibrium_manifest, metadata, mode_metadata, sample_index)
            # The n0 projector below uses the fixed yz tangent plane of C1.
            # Check the accepted magnetic state, never the air extension.
            if any(abs(value - target) > 1e-8 for vector in equilibrium["magnetic_m0"]
                   for value, target in zip(vector, (1.0, 0.0, 0.0))):
                raise ValueError("accepted magnetic equilibrium is outside the C1 +x n0 model")
            result["equilibrium_binding"] = equilibrium
        plan = metadata["execution_plan"]["backend_plan"]
        mesh = plan["mesh"]
        cells = tet4_cells(mesh)
        selected = magnetic_element_indices(mesh, plan.get("mesh_parts"))
        data = bound_bytes(mode["vector_path"])
        values = struct.unpack("<" + str(len(data)//8) + "d", data)
        field = [[complex(values[i+j], values[i+j+1]) for j in (0, 2, 4)] for i in range(0, len(values), 6)]
        metrics = tet4_n0_projection(mesh["nodes"], cells, selected, field, vector)
        result.update(status="measured", metrics=metrics, sample_index=sample_index, raw_mode_index=raw_mode_index, file_hashes=phase["file_hashes"])
    except (OSError, ValueError, TypeError, KeyError, IndexError, struct.error, SystemExit) as error:
        result["reasons"].append(str(error))
    return result
