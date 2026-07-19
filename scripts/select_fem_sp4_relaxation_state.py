#!/usr/bin/env python3
"""Select the FEM SP4 S-state only after the full relaxation matrix passes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from scripts.write_fem_magnetic_initial_state_from_shared_domain import (
    write_magnetic_initial_state,
)
from tests.standard_problems.mumag.sp4.common.contract import (
    CANONICAL_RELAXATION_ALGORITHM,
    CANONICAL_RELAXATION_DEVICE,
)
from tests.standard_problems.mumag.sp4.common.references import (
    parse_ovf2_rectangular,
)
from tests.standard_problems.mumag.sp4.fem.verify import (
    relaxation_artifact_path,
    relaxation_matrix_metrics,
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def select_state(root: Path, *, mesh: str, airbox: str) -> dict[str, object]:
    reference_path = (
        Path(__file__).parents[1]
        / "tests/standard_problems/mumag/sp4/references/nist/oommf/stdprob4-start.omf"
    )
    matrix = relaxation_matrix_metrics(
        root,
        mesh=mesh,
        airbox=airbox,
        reference=parse_ovf2_rectangular(reference_path),
    )
    state_root = root / "states" / mesh / airbox
    state_root.mkdir(parents=True, exist_ok=True)
    canonical_artifacts = relaxation_artifact_path(
        root,
        device=CANONICAL_RELAXATION_DEVICE,
        mesh=mesh,
        airbox=airbox,
        algorithm=CANONICAL_RELAXATION_ALGORITHM,
    )
    state_path = state_root / "initial_state.json"
    write_magnetic_initial_state(canonical_artifacts, state_path)
    state_sha256 = _sha256(state_path)
    canonical_id = str(matrix["canonical_run"])
    canonical_entry = matrix["entries"][canonical_id]
    selection = {
        "schema": "fullmag.mumag.sp4.relaxation_selection.v1",
        "status": "passed",
        "mesh": mesh,
        "airbox": airbox,
        "device": CANONICAL_RELAXATION_DEVICE,
        "algorithm": CANONICAL_RELAXATION_ALGORITHM,
        "source_artifact_dir": str(canonical_artifacts.relative_to(root)),
        "source_m_final_sha256": canonical_entry["m_final_sha256"],
        "topology_fingerprint": canonical_entry["topology_fingerprint"],
        "initial_state_sha256": state_sha256,
    }
    (state_root / "relaxation_matrix.json").write_text(
        json.dumps(matrix, indent=2) + "\n",
        encoding="utf-8",
    )
    (state_root / "canonical_source.json").write_text(
        json.dumps(selection, indent=2) + "\n",
        encoding="utf-8",
    )
    (state_root / "initial_state.sha256").write_text(
        f"{state_sha256}  initial_state.json\n",
        encoding="utf-8",
    )
    return selection


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--airbox", required=True)
    args = parser.parse_args()
    selection = select_state(args.root, mesh=args.mesh, airbox=args.airbox)
    print(json.dumps(selection, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
