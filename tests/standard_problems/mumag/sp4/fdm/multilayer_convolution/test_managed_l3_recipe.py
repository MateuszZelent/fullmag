"""Contract for the dedicated managed CPU L=3 runtime gate."""

from __future__ import annotations

import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[6]


def test_managed_l3_recipe_runs_both_sp4_derived_cases_in_the_container() -> None:
    result = subprocess.run(
        ["just", "--dry-run", "verify-fdm-multilayer-l3-runtime"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    rendered = result.stdout + result.stderr
    assert "docker compose --profile fem-gpu run --rm --no-deps" in rendered
    assert "scenario_l3_regular_small.py" in rendered
    assert "scenario_l3_heterogeneous_small.py" in rendered
    assert "verify_fdm_multilayer_independent_oracle.py" in rendered
    assert "verify_fdm_multilayer_transfer_parity.py" in rendered
    assert "managed_runtime_unavailable" in rendered
    assert "input-hashes.v1.json" in rendered
    assert "source-hashes.v1.json" in rendered
    assert "source_drift_after_runtime" in rendered
    assert "input_hash_drift_after_runtime" in rendered
    assert "source_hash_drift_after_runtime" in rendered
    assert "regular_oracle_failed" in rendered
    assert "heterogeneous_transfer_failed" in rendered
    assert "summary_write_failed" in rendered
    assert ".build_identity.source_snapshot_sha256" in rendered
    assert "managed_runtime_source_snapshot_missing" in rendered
    assert "managed_runtime_source_snapshot_mismatch" in rendered
    assert "source-snapshot-post.v1.json" in rendered
    assert 'snapshot_file":{"sha256":"%s"}' in rendered
    assert 'snapshot_file":{"path":"source-snapshot.v1.json' not in rendered
    assert "source_snapshot:$source[0]" in rendered
    assert "source_snapshot:\\$source[0]" not in rendered
