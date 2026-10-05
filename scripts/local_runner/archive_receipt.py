"""Archive integrity for disposable execution cleanup, never runtime admission.

Historical producer contracts are retained as evidence. This validator does not
qualify their physics, ABI, or compatibility with the current runtime profile.
"""
import hashlib
import json
from pathlib import Path
import re

from local_runner import retention
from local_runner.build_executor import artifact_sha256
from local_runner.worker_entrypoint import canonical


def validate_archive_receipt(artifacts, job, journal):
    try:
        path = retention._checked_child(artifacts, ("build-receipt.json",), kind="file")
        if path.stat().st_size > 4 * 1024**2:
            raise ValueError("Oversized archive receipt")
        receipt = json.loads(path.read_text(encoding="utf-8"))
        expected = {"schema": "fullmag.local-runner.build-receipt.v1",
                    "job_id": job["job_id"], "source_digest": job["source_digest"],
                    "profile": job["profile"], "state": "succeeded",
                    "qualification": "NOT VERIFIED", "image_digest": journal["image_digest"]}
        if not isinstance(receipt, dict) or any(receipt.get(k) != v for k, v in expected.items()):
            raise ValueError("Archive receipt identity mismatch")
        native = job.get("payload", {}).get("native_source_identity")
        if (not isinstance(native, dict) or receipt.get("native_source_identity") != native
                or receipt.get("native_source_identity_sha256") != hashlib.sha256(canonical(native)).hexdigest()):
            raise ValueError("Archive native identity mismatch")
        stages = receipt.get("stages")
        if (not isinstance(stages, list) or not stages
                or any(not isinstance(s, dict) or type(s.get("exit_code")) is not int
                       or s["exit_code"] != 0 or not isinstance(s.get("name"), str)
                       or not s["name"] for s in stages)):
            raise ValueError("Archive build stages are incomplete or failed")
        entries = receipt.get("artifacts")
        if not isinstance(entries, list) or not entries:
            raise ValueError("Archive receipt has no artifacts")
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Invalid archive artifact member")
            relative = entry.get("path")
            if (not isinstance(relative, str) or not relative or relative in seen
                    or "\\" in relative or ":" in relative or relative.startswith("/")
                    or any(part in ("", ".", "..") for part in relative.split("/"))
                    or type(entry.get("size")) is not int or entry["size"] < 0
                    or re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", ""))) is None):
                raise ValueError("Invalid archive artifact member")
            seen.add(relative)
            artifact = retention._checked_child(artifacts, tuple(relative.split("/")), kind="file")
            if artifact.stat().st_size != entry["size"] or artifact_sha256(artifact) != entry["sha256"]:
                raise ValueError("Archive artifact size/hash mismatch")
            if relative == "source-identity.json" and json.loads(artifact.read_text(encoding="utf-8")) != native:
                raise ValueError("Archive source identity artifact mismatch")
        return receipt
    except retention._PathIssue as error:
        raise ValueError("Unsafe archive artifact path: " + error.reason) from error
