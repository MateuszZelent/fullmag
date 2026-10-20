"""Small artifact-bearing fixtures for interpreted Windows FEM admission tests."""
import hashlib
import json
from pathlib import Path


def native_fem_manifest(layout, attempt_id, requested_device="gpu", device="gpu"):
    build = Path(layout["build_root"])
    files = {}
    for name in ("fullmag.exe", "fullmag-api.exe", "fullmag_fem.dll", "audit.json", "MFEMConfig.cmake", "provider-receipt.json"):
        if name == "MFEMConfig.cmake":
            path = build / "fem-dependencies/installed/lib/cmake/mfem" / name
        elif name == "provider-receipt.json":
            path = build / "fem-dependencies" / name
        else:
            path = build / "fixture-runtime" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(("fixture, never executable: " + name).encode())
        files[name] = (str(path), hashlib.sha256(path.read_bytes()).hexdigest())
    return {
        "schema_version": 1, "state": "completed", "backend": "fem",
        "target_triple": "x86_64-pc-windows-msvc", "cuda": device == "gpu",
        "native_fem_attempt_id": attempt_id,
        "binary": files["fullmag.exe"][0], "binary_sha256": files["fullmag.exe"][1],
        "api_binary": files["fullmag-api.exe"][0], "api_binary_sha256": files["fullmag-api.exe"][1],
        "native_fem": {
            "device": device, "requested_device": requested_device, "strict_gpu": device == "gpu",
            "provider_config": files["MFEMConfig.cmake"][0], "provider_config_sha256": files["MFEMConfig.cmake"][1],
            "provider_receipt_path": files["provider-receipt.json"][0], "provider_receipt_sha256": files["provider-receipt.json"][1],
            "runtime_dll": files["fullmag_fem.dll"][0], "runtime_dll_sha256": files["fullmag_fem.dll"][1],
            "dependency_audit_path": files["audit.json"][0], "dependency_audit_sha256": files["audit.json"][1],
        },
    }


def manifest_bytes(layout, child_env):
    return (json.dumps(native_fem_manifest(
        layout, child_env["FULLMAG_NATIVE_FEM_ATTEMPT_ID"],
        child_env["FULLMAG_FEM_REQUESTED_DEVICE"],
    )) + "\n").encode()
