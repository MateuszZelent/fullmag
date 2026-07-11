from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from build_fd_solver_masterplan_full_pack import (
    load_manifest,
    ordered_full_pack_documents,
    render_full_pack,
)


ROOT = Path("docs/plans/active/fd_sovler_masterplan")
IMPLEMENTATION_STATES = {"absent", "contract_only", "source_visible", "executable"}
VALIDATION_STATES = {
    "unvalidated",
    "algebra_validated",
    "physics_validated",
    "production_qualified",
}
SCOPE_FIELDS = (
    "study_product",
    "device",
    "precision",
    "wavevector_scope",
    "demag_scope",
    "scope_variant",
)


def manifest_entries(manifest: dict[str, object]) -> list[dict[str, object]]:
    raw = manifest.get("documents")
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise ValueError("manifest documents must be an array of objects")
    return raw


def load_json_file(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_manifest_string(manifest: dict[str, object], key: str) -> tuple[str | None, list[str]]:
    value = manifest.get(key)
    if isinstance(value, str) and value:
        return value, []
    return None, [f"manifest {key} must be a string"]


def documentation_path(root: Path, relative: str, label: str) -> tuple[Path | None, list[str]]:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        return None, [f"{label} path escapes documentation root: {relative}"]
    candidate = (root / path).resolve()
    if root.resolve() not in candidate.parents:
        return None, [f"{label} path escapes documentation root: {relative}"]
    return candidate, []


def check_manifest(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    entries = manifest_entries(manifest)
    full_pack = manifest.get("full_pack")
    if not isinstance(full_pack, str):
        errors.append("manifest full_pack must be a string")
        full_pack = None

    declared = {entry.get("path") for entry in entries if isinstance(entry.get("path"), str)}
    allowed = set(declared)
    if full_pack is not None:
        allowed.add(full_pack)
    active_markdown = {path.name for path in root.glob("*.md")}
    for name in sorted(active_markdown - allowed):
        errors.append(f"unclassified active Markdown file: {name}")

    seen_orders: set[int] = set()
    for entry in entries:
        relative = entry.get("path")
        order = entry.get("order")
        if not isinstance(relative, str):
            errors.append("manifest entry lacks string path")
            continue
        relative_path = Path(relative)
        if not isinstance(order, int):
            errors.append(f"manifest entry lacks integer order: {relative}")
        elif order in seen_orders:
            errors.append(f"duplicate documentation order: {order}")
        else:
            seen_orders.add(order)
        if relative_path.parts and relative_path.parts[0] == "old":
            errors.append(f"historical path declared active: {relative}")
        if relative_path.is_absolute() or ".." in relative_path.parts:
            errors.append(f"manifest path escapes documentation root: {relative}")
            continue
        if not (root / relative_path).is_file():
            errors.append(f"manifest path does not exist: {relative}")
        if entry.get("include_in_full_pack") is True and not relative.endswith(".md"):
            errors.append(f"non-Markdown full-pack input: {relative}")

    for key in ("readiness_matrix", "readiness_scope_catalog"):
        relative, key_errors = require_manifest_string(manifest, key)
        errors.extend(key_errors)
        if relative is not None:
            path, path_errors = documentation_path(root, relative, f"manifest {key}")
            errors.extend(path_errors)
            if path is not None and not path.is_file():
                errors.append(f"manifest {key} path does not exist: {relative}")

    return errors


def check_normative_text(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    undefined_gamma = re.compile(r"(?<![A-Za-z0-9_])-\s*gamma(?![A-Za-z0-9_])")
    bad_gauge_pairing = re.compile(
        r"(poisson_(?:robin|dirichlet)[^,;\n|`]*mean_zero_augmented)"
        r"|"
        r"(mean_zero_augmented[^,;\n|`]*poisson_(?:robin|dirichlet))"
    )
    for entry in manifest_entries(manifest):
        if entry.get("role") != "normative":
            continue
        relative = entry.get("path")
        if not isinstance(relative, str) or not relative.endswith(".md"):
            continue
        text = (root / relative).read_text(encoding="utf-8")
        for token in ("TODO", "TBD"):
            if re.search(rf"\b{token}\b", text):
                errors.append(f"normative placeholder {token}: {relative}")
        for number, line in enumerate(text.splitlines(), start=1):
            if undefined_gamma.search(line):
                errors.append(f"undefined gamma: {relative}:{number}")
            if bad_gauge_pairing.search(line):
                errors.append(f"coercive BC paired with mean-zero gauge: {relative}:{number}")
    return errors


def load_readiness_payloads(
    root: Path, manifest: dict[str, object]
) -> tuple[dict[str, object] | None, dict[str, object] | None, str | None, list[str]]:
    errors: list[str] = []
    matrix_relative, matrix_errors = require_manifest_string(manifest, "readiness_matrix")
    catalog_relative, catalog_errors = require_manifest_string(manifest, "readiness_scope_catalog")
    errors.extend(matrix_errors)
    errors.extend(catalog_errors)
    if matrix_relative is None or catalog_relative is None:
        return None, None, None, errors

    matrix_path, matrix_path_errors = documentation_path(root, matrix_relative, "readiness matrix")
    catalog_path, catalog_path_errors = documentation_path(
        root, catalog_relative, "readiness scope catalog"
    )
    errors.extend(matrix_path_errors)
    errors.extend(catalog_path_errors)
    if matrix_path is None or catalog_path is None:
        return None, None, None, errors

    matrix_raw = load_json_file(matrix_path)
    catalog_raw = load_json_file(catalog_path)
    if not isinstance(matrix_raw, dict):
        errors.append("readiness matrix must be a JSON object")
        matrix_raw = None
    if not isinstance(catalog_raw, dict):
        errors.append("readiness scope catalog must be a JSON object")
        catalog_raw = None
    return matrix_raw, catalog_raw, sha256_file(catalog_path), errors


def check_scope_binding(
    cell: dict[str, object],
    field: str,
    binding: object,
    catalog: dict[str, object],
    expected_uri: str,
    expected_sha256: str,
    errors: list[str],
    cell_label: str,
) -> None:
    if binding is None:
        return
    if not isinstance(binding, dict):
        errors.append(f"{field} in readiness cell {cell_label} must be null or an object")
        return
    for key in ("scope_id", "scope_catalog_uri", "scope_catalog_sha256"):
        if not isinstance(binding.get(key), str) or not binding.get(key):
            errors.append(f"{field} in readiness cell {cell_label} lacks {key}")
    if binding.get("schema") != "readiness_scope_binding.v1":
        errors.append(f"{field} in readiness cell {cell_label} has invalid schema")
    if binding.get("scope_schema") != "frequency_domain_readiness_scope.v1":
        errors.append(f"{field} in readiness cell {cell_label} has invalid scope_schema")
    if binding.get("kind") != "direct":
        errors.append(f"{field} in readiness cell {cell_label} has invalid kind")
    scope_id = binding.get("scope_id")
    if binding.get("scope_catalog_uri") != expected_uri:
        errors.append(f"{field} in readiness cell {cell_label} has wrong scope_catalog_uri")
    if binding.get("scope_catalog_sha256") != expected_sha256:
        errors.append(f"{field} in readiness cell {cell_label} has wrong scope_catalog_sha256")
    scopes = catalog.get("scopes")
    if not isinstance(scopes, dict):
        errors.append("scope catalog scopes must be an object")
        return
    entry = scopes.get(scope_id) if isinstance(scope_id, str) else None
    if not isinstance(entry, dict):
        errors.append(f"{field} in readiness cell {cell_label} does not resolve: {scope_id}")
        return
    if entry.get("scope_id") != scope_id:
        errors.append(f"scope catalog entry scope_id mismatch: {scope_id}")
    expected_claim_kind = field
    if entry.get("claim_kind") != expected_claim_kind:
        errors.append(f"scope catalog entry claim_kind mismatch: {scope_id}")
    for key in SCOPE_FIELDS:
        if key not in cell:
            continue
        if key not in entry:
            errors.append(
                f"scope catalog entry {scope_id} lacks canonical field {key} "
                f"required by cell {cell_label}"
            )
        elif cell.get(key) != entry.get(key):
            errors.append(f"scope catalog entry {scope_id} differs from cell {cell_label} field {key}")


def check_readiness(root: Path, manifest: dict[str, object]) -> list[str]:
    errors: list[str] = []
    matrix, catalog, digest, load_errors = load_readiness_payloads(root, manifest)
    errors.extend(load_errors)
    if matrix is None or catalog is None or digest is None:
        return errors

    expected_sha256 = f"sha256:{digest}"
    expected_uri = f"urn:fullmag:frequency-domain:readiness-scope-catalog:{digest}"
    reference = matrix.get("scope_catalog_reference")
    if not isinstance(reference, dict):
        errors.append("readiness matrix scope_catalog_reference must be an object")
    else:
        if reference.get("scope_catalog_sha256") != expected_sha256:
            errors.append("readiness scope catalog sha256 does not match exact bytes")
        if reference.get("scope_catalog_uri") != expected_uri:
            errors.append("readiness scope catalog URI does not match exact bytes")

    cells = matrix.get("cells")
    if not isinstance(cells, list):
        return errors + ["readiness matrix cells must be an array"]
    for index, cell in enumerate(cells):
        cell_label = str(index)
        if not isinstance(cell, dict):
            errors.append(f"readiness cell {index} must be an object")
            continue
        if isinstance(cell.get("cell_id"), str):
            cell_label = cell["cell_id"]  # type: ignore[index]
        if cell.get("implementation_state") not in IMPLEMENTATION_STATES:
            errors.append(f"invalid implementation_state in readiness cell {cell_label}")
        validation_state = cell.get("validation_state")
        if validation_state not in VALIDATION_STATES:
            errors.append(f"invalid validation_state in readiness cell {cell_label}")
        validated_scope = cell.get("validated_scope")
        executable_scope = cell.get("executable_scope")
        for field in ("validated_scope", "executable_scope"):
            if field not in cell:
                errors.append(f"readiness cell lacks {field}: {cell_label}")
        if validation_state == "unvalidated" and validated_scope is not None:
            errors.append(f"unvalidated readiness cell has validated_scope: {cell_label}")
        if validation_state != "unvalidated" and not isinstance(validated_scope, dict):
            errors.append(f"validated readiness cell lacks validated_scope object: {cell_label}")
        check_scope_binding(
            cell,
            "validated_scope",
            validated_scope,
            catalog,
            expected_uri,
            expected_sha256,
            errors,
            cell_label,
        )
        check_scope_binding(
            cell,
            "executable_scope",
            executable_scope,
            catalog,
            expected_uri,
            expected_sha256,
            errors,
            cell_label,
        )

    scopes = catalog.get("scopes")
    if isinstance(scopes, dict):
        for key, raw_entry in scopes.items():
            if not isinstance(raw_entry, dict):
                errors.append(f"scope catalog entry must be an object: {key}")
                continue
            if raw_entry.get("scope_id") != key:
                errors.append(f"scope catalog key does not match scope_id: {key}")
            if raw_entry.get("claim_kind") not in {"validated_scope", "executable_scope"}:
                errors.append(f"scope catalog entry has invalid claim_kind: {key}")
                continue
            if not all(
                isinstance(raw_entry.get(field), str) and raw_entry.get(field)
                for field in SCOPE_FIELDS
                if field != "precision"
            ):
                errors.append(f"scope catalog entry lacks canonical identity fields: {key}")

    return errors


def check_audit_findings(root: Path) -> list[str]:
    audit = (root / "19_eigensolve_frequency_driven_physics_numerics_audit.md").read_text(
        encoding="utf-8"
    )
    return [
        f"missing audit finding F-{index:02d}"
        for index in range(1, 23)
        if f"F-{index:02d}" not in audit
    ]


def check_full_pack(root: Path, manifest: dict[str, object]) -> list[str]:
    output_name = manifest.get("full_pack")
    if not isinstance(output_name, str):
        return ["manifest full_pack must be a string"]
    expected = render_full_pack(root, ordered_full_pack_documents(root, manifest))
    output = root / output_name
    if not output.is_file() or output.read_text(encoding="utf-8") != expected:
        return ["generated full pack differs from manifest inputs"]
    return []


def main() -> int:
    manifest = load_manifest(ROOT)
    errors = (
        check_manifest(ROOT, manifest)
        + check_normative_text(ROOT, manifest)
        + check_readiness(ROOT, manifest)
        + check_audit_findings(ROOT)
        + check_full_pack(ROOT, manifest)
    )
    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
