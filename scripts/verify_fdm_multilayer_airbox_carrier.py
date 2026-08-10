"""Validate a runtime-origin FDM multilayer Airbox observation carrier."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


class AirboxCarrierError(ValueError):
    """Raised when the runtime did not publish a separate Airbox carrier."""


def _fail(reason: str) -> None:
    raise AirboxCarrierError(f"not_qualified: {reason}")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        _fail(f"airbox_carrier_missing:{path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"airbox_carrier_unreadable:{path}:{exc}")
    if not isinstance(payload, dict):
        _fail("airbox_carrier_manifest_malformed")
    return payload


def verify_airbox_carrier(path: str | Path) -> dict[str, Any]:
    """Validate one runtime-created carrier directory without synthesizing data."""

    carrier = Path(path)
    manifest_path = carrier / "manifest.json" if carrier.is_dir() else carrier
    payload = _read_json(manifest_path)
    if payload.get("schema_version") != "fdm_multilayer_observation.v1":
        _fail("airbox_carrier_schema_mismatch")
    if payload.get("scope_kind") != "airbox":
        _fail("airbox_carrier_scope_kind_mismatch")
    if payload.get("quantity_id") != "H_demag":
        _fail("airbox_carrier_quantity_mismatch")
    if payload.get("source_policy") != "target_only":
        _fail("airbox_carrier_source_policy_mismatch")
    if payload.get("target_only") is not True:
        _fail("airbox_carrier_target_only_missing")
    if payload.get("published_quantities") != ["H_demag"]:
        _fail("airbox_carrier_published_quantities_mismatch")
    unavailable = payload.get("unavailable_quantities")
    if not isinstance(unavailable, dict) or unavailable.get("H_eff") != (
        "fdm_multilayer_airbox_h_eff_unavailable.v1"
    ):
        _fail("airbox_carrier_h_eff_unavailable_contract_mismatch")
    source_fingerprints = payload.get("source_grid_fingerprints")
    if (
        not isinstance(source_fingerprints, list)
        or not source_fingerprints
        or any(not isinstance(value, str) or len(value) < 16 for value in source_fingerprints)
    ):
        _fail("airbox_carrier_source_grid_fingerprints_missing")
    if not isinstance(payload.get("source_common_grid"), dict):
        _fail("airbox_carrier_source_common_grid_missing")
    source_identity = payload.get("source_runtime_identity")
    if not isinstance(source_identity, dict):
        _fail("airbox_carrier_source_runtime_identity_missing")
    for key in ("execution_engine", "precision", "demag_operator_kind", "run_status"):
        value = source_identity.get(key)
        if not isinstance(value, str) or not value:
            _fail(f"airbox_carrier_source_runtime_identity_{key}_missing")
    fingerprint = payload.get("carrier_fingerprint")
    if not isinstance(fingerprint, str) or len(fingerprint) < 16:
        _fail("airbox_carrier_fingerprint_missing")
    field_artifact = payload.get("field_artifact")
    if not isinstance(field_artifact, str) or not field_artifact:
        _fail("airbox_carrier_field_artifact_missing")
    field_path = (manifest_path.parent / field_artifact).resolve()
    try:
        field_path.relative_to(manifest_path.parent.resolve())
    except ValueError:
        _fail("airbox_carrier_field_artifact_outside_carrier")
    if not field_path.is_file():
        _fail(f"airbox_carrier_field_artifact_missing:{field_path}")
    field_bytes = field_path.read_bytes()
    field_hash = hashlib.sha256(field_bytes).hexdigest()
    manifest_field_hash = payload.get("field_artifact_sha256")
    if manifest_field_hash != field_hash:
        _fail("airbox_carrier_field_artifact_hash_mismatch")
    field_payload = _read_json(field_path)
    if field_payload.get("schema_version") != "fdm_multilayer_observation_field.v1":
        _fail("airbox_carrier_field_schema_mismatch")
    if field_payload.get("quantity_id") != "H_demag" or field_payload.get("scope_kind") != "airbox":
        _fail("airbox_carrier_field_identity_mismatch")
    if field_payload.get("unit") != "A/m":
        _fail("airbox_carrier_field_unit_mismatch")
    values = field_payload.get("values")
    if (
        not isinstance(values, list)
        or not values
        or any(
            not isinstance(vector, list)
            or len(vector) != 3
            or any(not isinstance(component, (int, float)) for component in vector)
            for vector in values
        )
    ):
        _fail("airbox_carrier_field_values_malformed")
    sample_count = payload.get("sample_count")
    if not isinstance(sample_count, int) or sample_count <= 0 or sample_count != len(values):
        _fail("airbox_carrier_sample_count_mismatch")
    payload["manifest_path"] = str(manifest_path)
    payload["field_artifact_sha256"] = field_hash
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("carrier", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        payload = verify_airbox_carrier(args.carrier)
    except AirboxCarrierError as exc:
        print(str(exc))
        return 3
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
