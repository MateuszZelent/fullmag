#!/usr/bin/env python3
"""Materialize identity-bound gate evidence for the solved-current racetrack.

The producer is an evidence adapter, not a claim generator.  A gate can be
published as ``pass`` only when a versioned proof file exists, its claims pass
the canonical validator, and every referenced evidence artifact is present
inside the same evidence root.  Missing or invalid proofs produce explicit
``blocked`` gate artifacts so the assembler can report the real blocker.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from scripts.assemble_fdm_gpu_racetrack_qualification import (
        _source_identity,
        input_digest,
        sha256_file,
    )
    from scripts.verify_fdm_gpu_racetrack_qualification import (
        GATE_EVIDENCE_SCHEMA,
        REQUIRED_GATES,
        QualificationError,
        identity,
        runtime_identity,
        validate_gate_claims,
    )
except ModuleNotFoundError:  # direct ``python scripts/produce_...py`` invocation
    from assemble_fdm_gpu_racetrack_qualification import (  # type: ignore
        _source_identity,
        input_digest,
        sha256_file,
    )
    from verify_fdm_gpu_racetrack_qualification import (  # type: ignore
        GATE_EVIDENCE_SCHEMA,
        REQUIRED_GATES,
        QualificationError,
        identity,
        runtime_identity,
        validate_gate_claims,
    )


PROOF_SCHEMA = "fdm_gpu_racetrack_gate_proof.v1"
SUMMARY_SCHEMA = "fdm_gpu_racetrack_gate_evidence_summary.v1"
SUMMARY_NAME = "fdm_gpu_racetrack_gate_evidence_summary.v1.json"


class GateEvidenceError(RuntimeError):
    """The proof set cannot be converted into gate artifacts."""


def _json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GateEvidenceError(f"{label}_unreadable") from error
    if not isinstance(value, Mapping):
        raise GateEvidenceError(f"{label}_invalid")
    return value


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _evidence_paths(root: Path, proof: Mapping[str, Any]) -> list[str]:
    raw = proof.get("evidence_paths")
    if not isinstance(raw, list) or not raw:
        raise GateEvidenceError("proof_evidence_paths_missing")
    result: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item:
            raise GateEvidenceError("proof_evidence_path_invalid")
        candidate = (root / item).resolve()
        try:
            relative = candidate.relative_to(root.resolve()).as_posix()
        except ValueError as error:
            raise GateEvidenceError("proof_evidence_outside_root") from error
        if relative.split("/", 1)[0] in {"proofs", "gates"}:
            raise GateEvidenceError("proof_evidence_must_be_raw")
        if not candidate.is_file():
            raise GateEvidenceError("proof_evidence_missing")
        result.append(relative)
    return sorted(set(result))


def _blocked(
    gate_id: str,
    source: Mapping[str, Any] | None,
    runtime: Mapping[str, Any] | None,
    reasons: Sequence[str],
) -> dict[str, Any]:
    return {
        "schema_version": GATE_EVIDENCE_SCHEMA,
        "gate_id": gate_id,
        "status": "blocked",
        "source_identity": dict(source) if source is not None else None,
        "runtime_identity": dict(runtime) if runtime is not None else None,
        "reason_codes": sorted(set(reasons)),
        "claims": {},
        "producer": "produce_fdm_gpu_racetrack_gate_evidence.py",
    }


def _pass_gate(
    root: Path,
    gate_id: str,
    proof_path: Path,
    proof: Mapping[str, Any],
    source: Mapping[str, Any],
    runtime: Mapping[str, Any],
) -> dict[str, Any]:
    if proof.get("schema_version") != PROOF_SCHEMA:
        raise GateEvidenceError("proof_schema_invalid")
    if proof.get("gate_id") != gate_id:
        raise GateEvidenceError("proof_gate_id_mismatch")
    if proof.get("status") != "pass":
        raise GateEvidenceError("proof_not_pass")
    claims = proof.get("claims")
    if not isinstance(claims, dict):
        raise GateEvidenceError("proof_claims_invalid")
    try:
        validate_gate_claims(gate_id, claims)
        evidence_paths = _evidence_paths(root, proof)
        if "source_identity" not in proof:
            raise GateEvidenceError("proof_source_identity_missing")
        if identity(proof["source_identity"], f"{gate_id}_proof_source") != dict(source):
            raise GateEvidenceError("proof_source_identity_mismatch")
        if "runtime_identity" not in proof:
            raise GateEvidenceError("proof_runtime_identity_missing")
        if runtime_identity(proof["runtime_identity"], f"{gate_id}_proof_runtime") != dict(runtime):
            raise GateEvidenceError("proof_runtime_identity_mismatch")
    except QualificationError as error:
        raise GateEvidenceError(str(error)) from error
    try:
        proof_relative = proof_path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise GateEvidenceError("proof_outside_root") from error
    return {
        "schema_version": GATE_EVIDENCE_SCHEMA,
        "gate_id": gate_id,
        "status": "pass",
        "source_identity": dict(source),
        "runtime_identity": dict(runtime),
        "claims": claims,
        "proof": {
            "schema_version": PROOF_SCHEMA,
            "path": proof_relative,
            "evidence_paths": evidence_paths,
        },
        "producer": "produce_fdm_gpu_racetrack_gate_evidence.py",
    }


def produce(
    evidence_root: str | Path,
    *,
    source_snapshot_path: str | Path,
    runtime_identity_path: str | Path,
    input_paths: Sequence[str | Path],
    fixture_path: str | Path,
    qualification_input: str | None = None,
    proof_root: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(evidence_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    proofs = Path(proof_root).resolve() if proof_root is not None else root / "proofs"
    reasons: list[str] = []
    try:
        source = _source_identity(
            Path(source_snapshot_path),
            tuple(Path(item) for item in input_paths),
            Path(fixture_path),
            qualification_input,
        )
        runtime = runtime_identity(_json(Path(runtime_identity_path), "runtime_identity"), "runtime_identity")
    except (GateEvidenceError, QualificationError) as error:
        summary = {
            "schema_version": SUMMARY_SCHEMA,
            "status": "blocked",
            "passed_gates": [],
            "blocked_gates": list(REQUIRED_GATES),
            "reason_codes": [str(error)],
        }
        _write_json(root / SUMMARY_NAME, summary)
        return summary

    passed: list[str] = []
    blocked: list[str] = []
    for gate_id in REQUIRED_GATES:
        path = proofs / f"{gate_id}.json"
        try:
            if not path.is_file():
                raise GateEvidenceError("proof_missing")
            artifact = _pass_gate(root, gate_id, path, _json(path, gate_id), source, runtime)
        except (GateEvidenceError, QualificationError) as error:
            artifact = _blocked(gate_id, source, runtime, [str(error)])
            blocked.append(gate_id)
            reasons.append(f"{gate_id}_{error}")
        else:
            passed.append(gate_id)
        _write_json(root / "gates" / f"{gate_id}.json", artifact)

    summary = {
        "schema_version": SUMMARY_SCHEMA,
        "status": "pass" if not blocked else "blocked",
        "passed_gates": passed,
        "blocked_gates": blocked,
        "reason_codes": sorted(set(reasons)),
        "source_identity": source,
        "runtime_identity": runtime,
        "input_sha256": input_digest(tuple(Path(item) for item in input_paths)),
        "fixture_sha256": sha256_file(Path(fixture_path)),
    }
    _write_json(root / SUMMARY_NAME, summary)
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--source-snapshot", type=Path, required=True)
    parser.add_argument("--runtime-identity", type=Path, required=True)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--qualification-input")
    parser.add_argument("--proof-root", type=Path)
    args = parser.parse_args(argv)
    result = produce(
        args.evidence_root,
        source_snapshot_path=args.source_snapshot,
        runtime_identity_path=args.runtime_identity,
        input_paths=args.input,
        fixture_path=args.fixture,
        qualification_input=args.qualification_input,
        proof_root=args.proof_root,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
