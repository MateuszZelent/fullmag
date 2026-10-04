"""Generate the P3a endpoint owner/write-policy matrix from the P0 inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "docs/plans/active/refactor_runtime/final/p0/inventory.json"
OUTPUT = ROOT / "docs/plans/active/refactor_runtime/final/p3a/06-endpoint-owner-policy.md"

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def owner_policy(path: str, method: str) -> tuple[str, str]:
    if path.startswith("/v2/platform"):
        return "platform", "global host read"
    if path in {
        "/v2/sessions/current/diagnostics/cpu",
        "/v2/sessions/current/diagnostics/gpu",
    }:
        return "platform-diagnostics", "global host telemetry"
    if path == "/v2/sessions/current/status":
        return "session-identity-source", "global session identity source"
    if path == "/v2/persistence/projects/{project_id}/runs" and method == "POST":
        return "project-run", "pinned ProjectId and immutable archive/RunSpec; durable intent write"
    if path == "/v2/persistence/projects/{project_id}/runs" and method == "GET":
        return "project-run", "pinned ProjectId; bounded durable run list read"
    if path == "/v2/persistence/projects/{project_id}/runs/{run_id}" and method == "GET":
        return "project-run", "pinned ProjectId/RunId; durable intent and task catalog read"
    if path == "/v2/persistence/projects/{project_id}/runs/{run_id}/materialization" and method == "POST":
        return "project-run", "pinned ProjectId/RunId and immutable CAS study; durable task catalog write"
    if path == "/v2/persistence/imports/inspections" and method == "POST":
        return "project-archive-inspection", "runtime-free inspection of supplied archive bytes"
    if path.startswith("/v2/persistence/projects"):
        return "project-document", "runtime-free bytes write/read"
    if path == "/v2/sessions" or path.startswith("/v2/sessions/") and "/current" not in path:
        return "session-catalog", "global session lifecycle"
    if "/current/persistence" in path:
        return "session-persistence", "context-bound read/write"
    if "/current/events" in path:
        return "realtime-policy", "context-bound read/write; invalidation-only stream"
    if "/current/model" in path:
        return "authoring-model", "context-bound read/write"
    if "/current/simulation" in path:
        return "simulation-runtime", "context-bound read/write; queue admission fenced"
    if "/current/meshing" in path:
        return "preparation-meshing", "context-bound read/write"
    if "/current/data" in path:
        return "data-plane", "context-bound read-only payload"
    if "/current/analysis" in path:
        return "analysis", "context-bound read; command writes fenced"
    if "/current/visualization" in path:
        return "workspace-presentation", "context-bound read/write"
    if path == "/v2/sessions/current/persistence/imports" and method == "POST":
        return "session-persistence", "context-bound archive commit and current-session transition"
    if "/current" in path:
        return "current-session-adapter", "legacy current route; migration required"
    return "unclassified", "manual review required"


def load_status_overrides() -> dict[tuple[str, str], str]:
    """Read the explicit source-review ledger from the current matrix.

    The OpenAPI inventory is authoritative for endpoint identity, while the
    source-level status is an audited decision that cannot be inferred from a
    path name alone.  Keeping that decision in the generated matrix makes a
    subsequent refresh additive: new routes default to OPEN, and an existing
    SOURCE PASS is not silently downgraded by a generator that has not read
    the handler implementation.
    """
    if not OUTPUT.exists():
        return {}
    overrides: dict[tuple[str, str], str] = {}
    for line in OUTPUT.read_text(encoding="utf-8").splitlines():
        if not line.startswith("| ") or line.startswith("|---"):
            continue
        cells = [cell.strip() for cell in line.split("|")]
        if len(cells) < 9 or cells[1] not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            continue
        path = cells[2].strip("`")
        status = cells[-2]
        if status.startswith(("SOURCE PASS", "GLOBAL")):
            overrides[(cells[1], path)] = status
    return overrides


def context_status(
    path: str,
    method: str,
    overrides: dict[tuple[str, str], str],
) -> str:
    reviewed = overrides.get((method, path))
    if reviewed is not None:
        return reviewed
    if path == "/v2/persistence/projects/{project_id}/runs" and method == "POST":
        return "SOURCE PASS — explicit ProjectId and exact inputs; HTTP/runtime pending"
    if path == "/v2/persistence/projects/{project_id}/runs" and method == "GET":
        return "SOURCE PASS — bounded durable list and ProjectId filter; HTTP/runtime pending"
    if path == "/v2/persistence/projects/{project_id}/runs/{run_id}" and method == "GET":
        return "SOURCE PASS — durable ProjectId/RunId read model; HTTP/runtime pending"
    if path == "/v2/persistence/projects/{project_id}/runs/{run_id}/materialization" and method == "POST":
        return "SOURCE PASS — immutable CAS inputs and idempotent task identity; HTTP/runtime pending"
    if method == "PUT" and path in {
        "/v2/sessions/current/visualization/display",
        "/v2/sessions/current/visualization/state",
    }:
        return (
            "OPEN — transition fence and scoped facade method are present; "
            "stale-write regression authored but NOT RUN; no production caller "
            "or browser A→B proof"
        )
    if path == "/v2/sessions/current/events/ws" and method == "GET":
        return (
            "SOURCE PASS — backend pins and revalidates the stream context; "
            "client rejects mismatched session/epoch before forwarding; "
            "browser/replay proof pending"
        )
    if path == "/v2/persistence/imports/inspections" and method == "POST":
        return "GLOBAL — supplied archive bytes only; no active-session dependency"
    if path == "/v2/sessions/current/persistence/imports" and method == "POST":
        return (
            "SOURCE PASS — scoped import request, transition-fenced backend commit, "
            "and active imported-session identity check before local UI effects; "
            "browser/managed evidence pending"
        )
    pilot = (
        path in {
            "/v2/sessions/current/model/scene",
            "/v2/sessions/current/simulation/commands",
            "/v2/sessions/current/data/fdm-region-membership",
            "/v2/sessions/current/data/fdm-region-memberships",
            "/v2/sessions/current/persistence/exports",
            "/v2/sessions/current/persistence/imports/inspect",
            "/v2/sessions/current/persistence/imports/commit",
            "/v2/sessions/current/persistence/checkpoints",
            "/v2/sessions/current/persistence/recovery",
            "/v2/sessions/current/events/communication-policy",
        }
        or "/persistence/checkpoints/" in path
        or "/persistence/field-state" in path
        or path.endswith("/events/communication-policy")
    )
    if pilot:
        return "SOURCE PASS — context-bound pilot"
    if "/current" in path:
        return "OPEN — legacy current route; handler/client fence required"
    return "GLOBAL — no session fence"


def markdown(inventory: dict) -> str:
    endpoint_data = inventory["schema_abi"]["endpoint_mapping"]
    operations = endpoint_data["operations"]
    status_overrides = load_status_overrides()
    generated_openapi = ROOT / "apps/control-room/src/kernel/api/generated/openapi-v2.json"
    source_hash = (
        hashlib.sha256(generated_openapi.read_bytes()).hexdigest()
        if generated_openapi.is_file()
        else "unavailable"
    )
    lines = [
        "# P3a — macierz owner/write policy dla endpointów",
        "",
        "Ten plik jest generowany przez `scripts/audit_refactor_p3a.py` z",
        "`final/p0/inventory.json`. Obejmuje każdą operację OpenAPI i zapisuje",
        "właściciela, politykę odczytu/zapisu, handler oraz status migracji",
        "immutable request context. `SOURCE PASS` oznacza wyłącznie obecność",
        "source-level adaptera; nie jest dowodem browser/runtime ani release.",
        "Nie dowodzi pełnej migracji konsumentów: nagłówek `x-fullmag-session-scope`",
        "chroni oczekiwany cel wyłącznie wtedy, gdy klient przekazuje `sessionScopeKey`.",
        "Status `SOURCE PASS` jest jawnym wpisem review zachowanym przy odświeżeniu;",
        "nowe trasy pozostają `OPEN`, dopóki nie zostaną osobno zbadane.",
        "",
        f"- Operacje: **{len(operations)}** (OpenAPI inventory).",
        f"- Źródło wygenerowanego OpenAPI: `{source_hash}`.",
        "- Odświeżenie: `python scripts/audit_refactor_p3a.py --write`.",
        "",
        "## Reguły",
        "",
        "`/v2/sessions/current/...` nie jest niezależną tożsamością projektu.",
        "Każdy handler tej rodziny musi przypiąć `session_id`, `run_id` i epoch",
        "przed pierwszym wolnym `await`, sprawdzić je przed odczytem/zapisem oraz",
        "utrzymać transition fence przez synchroniczną publikację. Frontend musi",
        "używać `session_id + session_epoch` w resource/cache/decode identity.",
        "Operacje bez pilota pozostają `OPEN`, nawet gdy mają znalezionego",
        "handlera i literalnego konsumenta.",
        "",
        "## Macierz operacji",
        "",
        "| Metoda | Ścieżka | OperationId | Owner | Read/write policy | Handler | Context status |",
        "|---|---|---|---|---|---|---|",
    ]
    for operation in operations:
        path = operation["path"]
        method = operation["method"]
        owner, policy = owner_policy(path, method)
        handler = operation.get("handler") or "UNRESOLVED"
        handler_source = operation.get("handler_source") or "—"
        lines.append(
            "| "
            + " | ".join(
                [
                    method,
                    f"`{path}`",
                    f"`{operation.get('operation_id', '—')}`",
                    f"`{owner}`",
                    policy,
                    f"`{handler}` ({handler_source})",
                    context_status(path, method, status_overrides),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Brama odbioru",
            "",
            "Przed przejściem do managed runtime każdy wiersz `OPEN` dla ścieżki",
            "`current` musi mieć: właściciela w kodzie, jawne read/write policy,",
            "context capture/revalidation, klienta z kluczem sesyjnym, regresję",
            "stale-context oraz browser smoke A→B. `GLOBAL` pozostaje globalne tylko",
            "po potwierdzeniu, że payload nie zależy od sesji/projektu.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    output = markdown(inventory)
    if args.write:
        OUTPUT.write_text(output, encoding="utf-8")
    else:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        sys.stdout.write(output)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
