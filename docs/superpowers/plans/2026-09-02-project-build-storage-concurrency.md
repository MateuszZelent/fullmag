# Zarządzanie buildami projektu i równoległością — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przenieść nowe buildy, cache, runtime’y, logi i wyniki do jednego jawnego katalogu storage obok repozytorium oraz zapewnić bezkolizyjną pracę równoległych sesji Windows i Linux.

**Architecture:** Wspólny moduł Python ze standardowej biblioteki definiuje kontrakt ścieżek, marker storage, identyfikatory worktree/build oraz atomowy allocator. Launchery PowerShell, just i Make używają tego samego kontraktu, ale zachowują platformowe wymagania: Docker Desktop dla FEM na Windows oraz ext4-backed managed storage dla Linux FEM. Każdy build ma własny cargo-target, native, staging, manifest i lease; współdzielone pozostają wyłącznie jawnie bezpieczne cache.

**Tech Stack:** Python 3.12 standard library, PowerShell 5+/7, Bash, flock/msvcrt, Docker Compose, just, Make, pytest.

## Global Constraints

- Domyślny Windows storage root: C:\git\fullmag\storage.
- Domyślny Linux storage root: /zfn2/mateuszz/git/fullmag/storage.
- Jawne FULLMAG_PROJECT_STORAGE_ROOT ma pierwszeństwo, musi być absolutne i przejść marker/path-guard.
- Repozytorium C:\git\fullmag\fullmag nie jest storage rootem i nie zawiera Cargo targetów, cache ani dużych wyników.
- Każdy aktywny build ma osobny build_N, cargo-target i native.
- C:\fullmag-build, C:\fullmag-cache i C:\fullmag-tmp pozostają legacy; ten plan nie usuwa ani nie przenosi ich automatycznie.
- C:\git\fullmag\storage jest poza worktree, więc wpis ../storage w .gitignore jest nieskuteczny i nie zostanie dodany.
- Windows FEM CPU/GPU nadal używa scripts/windows/run_fullmag_fem.ps1, Docker Desktop Linux engine i bind mountów; nie używa wsl.exe jako fallbacku.
- Linux FEM nadal wymaga managed/container-backed just route i odrzuca bezpośredni build na CIFS.
- Żaden nowy build nie używa rootu dysku, checkoutu, wspólnego płaskiego target ani zwykłego /tmp jako trwałego rootu.
- Publikacja runtime’u odbywa się dopiero po walidacji i atomowej wymianie current; poprzedni runtime pozostaje dostępny.
- Prune i migracja są domyślnie read-only/dry-run; aktywne procesy, kontenery, lease’y i runtime current są chronione.
- Wspólny dirty checkout nie może być resetowany, stashowany, stage’owany ani commitowany bez osobnej autoryzacji użytkownika.
- Nie zmieniać fizyki, mesha, solvera, ProblemIR ani wyników naukowych; zakres dotyczy wyłącznie storage, provenance i koordynacji buildów.

---

## Mapa plików i granice odpowiedzialności

- Create scripts/fullmag_storage.py: jedyny kontrakt layoutu, marker, identyfikatory, allocator lease/status, odczyt inventory i bezpieczne operacje publish.
- Create scripts/test_fullmag_storage.py: testy jednostkowe i procesowe modułu Python, w tym współbieżna alokacja.
- Create scripts/test_fullmag_storage_contract.py: testy obecności resolvera w launcherach i zgodności nazw środowiskowych.
- Modify scripts/windows/run_fullmag.ps1: native FDM Windows; pobiera layout i per-build paths z modułu.
- Modify scripts/windows/run_fullmag_fem.ps1, scripts/windows/run_fullmag_wsl.ps1, scripts/windows/run_fullmag_docker.ps1: Windows FEM aliases używają jednego resolvera, per-build bind mountów i manifestu.
- Modify scripts/windows/setup_fullmag.ps1: tworzy tylko storage/cache i narzędzia w nowym root; odrzuca stare flat roots.
- Modify compose.windows.yaml: bind mounty otrzymują podkatalogi zaakceptowanego storage/builda, bez named volumes dla build/cache.
- Modify scripts/lib/managed_fem_build_policy.sh i scripts/lib/managed_fem_native_storage.sh: Linux resolver otrzymuje nowy project storage root, zachowując ext4/mount provenance.
- Modify scripts/lib/managed_fem_runtime_storage.sh, scripts/export_fem_gpu_runtime.sh, scripts/restore_persistent_fem_runtime.sh: runtime’y i ich locki są publikowane w nowym storage bez utraty obecnej atomowości.
- Modify Makefile i justfile: recepty przekazują resolverem wyznaczony build root; ad-hoc duże /tmp/fullmag-* zostają zastąpione albo jawnie oznaczone jako krótkotrwałe stagingi.
- Create scripts/inventory_fullmag_storage.py i scripts/test_fullmag_storage_inventory.py: read-only raport nowego i legacy storage.
- Create scripts/prune_fullmag_storage.py i scripts/test_prune_fullmag_storage.py: dry-run, containment guard i jawny tryb apply.
- Create docs/adr/0030-project-storage-and-build-concurrency.md: decyzja architektoniczna o granicy storage i równoległości.
- Modify AGENTS.md, docs/guides/windows-first-development.md, docs/superpowers/specs/2026-07-29-persistent-external-builds-design.md: reguły operacyjne, instrukcja użycia i zgodność starszej specyfikacji.

---

### Task 1: Wspólny kontrakt layoutu i atomowy allocator

**Files:**
- Create: scripts/fullmag_storage.py
- Create: scripts/test_fullmag_storage.py
- Create: scripts/test_fullmag_storage_contract.py

**Interfaces:**
- resolve_layout(repo_root: Path, explicit_storage_root: Path | None = None, platform: str | None = None) -> StorageLayout
- ensure_layout(layout: StorageLayout) -> None
- worktree_id(worktree_root: Path) -> str
- allocate_build(layout: StorageLayout, worktree_root: Path, metadata: Mapping[str, object]) -> BuildLease
- update_build_status(lease: BuildLease, status: str, error: str | None = None) -> None
- CLI resolve --repo-root PATH [--storage-root PATH] --platform windows|linux --json
- CLI allocate --repo-root PATH [--storage-root PATH] --metadata-json PATH --json
- CLI status --build-root PATH --status allocated|completed|failed|cancelled|abandoned [--error TEXT]

Test module setup:

~~~python
from pathlib import Path
import multiprocessing as mp
from typing import Mapping

import pytest

from fullmag_storage import (
    BuildLease,
    StorageError,
    allocate_build,
    ensure_layout,
    resolve_layout,
    update_build_status,
)
~~~

- [ ] Step 1: Write failing tests for path resolution, marker and identifiers.

~~~python
def test_default_layout_uses_project_parent_and_storage(tmp_path: Path) -> None:
    repo = tmp_path / "project" / "fullmag"
    repo.mkdir(parents=True)

    layout = resolve_layout(repo, platform="windows")

    assert layout.project_root == repo.parent.resolve()
    assert layout.storage_root == (repo.parent / "storage").resolve()
    assert layout.builds_root == layout.storage_root / "builds"
    assert layout.cache_root == layout.storage_root / "cache"


def test_layout_rejects_checkout_and_drive_root(tmp_path: Path) -> None:
    repo = tmp_path / "project" / "fullmag"
    repo.mkdir(parents=True)

    with pytest.raises(StorageError, match="checkout"):
        resolve_layout(repo, explicit_storage_root=repo)

    with pytest.raises(StorageError, match="root"):
        resolve_layout(repo, explicit_storage_root=Path(repo.anchor))


def test_marker_mismatch_fails_closed(tmp_path: Path) -> None:
    repo = tmp_path / "project" / "fullmag"
    repo.mkdir(parents=True)
    layout = resolve_layout(repo)
    ensure_layout(layout)
    marker = layout.storage_root / ".fullmag-storage.json"
    marker.write_text('{"schema_version": 1, "project_id": "other"}\n', encoding="utf-8")

    with pytest.raises(StorageError, match="marker"):
        ensure_layout(layout)
~~~

- [ ] Step 2: Run the focused tests and verify the new contract fails before implementation.

Run: python -m pytest -q scripts/test_fullmag_storage.py::test_default_layout_uses_project_parent_and_storage scripts/test_fullmag_storage.py::test_layout_rejects_checkout_and_drive_root scripts/test_fullmag_storage.py::test_marker_mismatch_fails_closed

Expected: pytest exits non-zero because scripts/fullmag_storage.py and its public types/functions do not yet exist.

- [ ] Step 3: Implement the minimal standard-library contract.

Use immutable dataclasses with these fields:

~~~python
@dataclass(frozen=True)
class StorageLayout:
    project_id: str
    project_root: Path
    repo_root: Path
    storage_root: Path
    builds_root: Path
    cache_root: Path
    runtimes_root: Path
    runs_root: Path
    locks_root: Path
    index_root: Path


@dataclass(frozen=True)
class BuildLease:
    project_id: str
    worktree_id: str
    build_id: str
    build_root: Path
    cargo_target: Path
    native_root: Path
    staging_root: Path
    logs_root: Path
    manifest_path: Path
    status_path: Path
    lease_path: Path
~~~

Resolver najpierw respektuje jawny explicit_storage_root, potem przez git rev-parse --path-format=absolute --git-common-dir ustala wspólny katalog Git, z niego główny checkout i jego nadrzędny project root. Dla obecnego repo daje to C:\git\fullmag, więc default storage root to C:\git\fullmag\storage. Brak bezpiecznej identyfikacji kończy się StorageError, bez fallbacku do rootu dysku lub checkoutu. Resolver tworzy dokładnie builds, cache, runtimes, runs, locks i index, a marker .fullmag-storage.json zapisuje schema_version, project_id, project_root, repo_root, platform i created_at_utc. Marker innego projektu kończy się StorageError.

Allocator blokuje locks/<project-id>.allocation.lock przez msvcrt na Windows i fcntl.flock na Linux, wybiera następny numeryczny build_N pod UTC date/worktree-id, tworzy cargo-target, native, staging i logs, a następnie atomowo zapisuje manifest.json, status.json i lease.json. Nie wolno wybierać katalogu przez niezabezpieczone ls/find.

- [ ] Step 4: Add allocator and status tests before wiring launchers.

~~~python
def test_two_allocators_same_worktree_get_distinct_builds(tmp_path: Path) -> None:
    repo = tmp_path / "project" / "fullmag"
    repo.mkdir(parents=True)
    metadata = {"backend": "fdm", "device": "gpu", "precision": "double", "command": ["fullmag"]}
    results = run_parallel_allocations(repo, metadata, count=2)

    assert {item.build_id for item in results} == {"build_001", "build_002"}
    assert results[0].cargo_target != results[1].cargo_target
    assert all(item.manifest_path.is_file() for item in results)
    assert all(item.status_path.is_file() for item in results)


def test_different_worktrees_do_not_share_mutable_build_directories(tmp_path: Path) -> None:
    repo_a = tmp_path / "project" / "fullmag-a"
    repo_b = tmp_path / "project" / "fullmag-b"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)

    a = allocate_for_test(repo_a)
    b = allocate_for_test(repo_b)

    assert a.worktree_id != b.worktree_id
    assert a.cargo_target != b.cargo_target
    assert a.native_root != b.native_root
~~~

run_parallel_allocations jest testowym helperem uruchamiającym dwa procesy Pythona przeciwko temu samemu temporary project; nie może osłabiać produkcyjnego locka.

Helpery testowe muszą mieć następującą implementację:

~~~python
def allocate_for_test(repo: Path) -> BuildLease:
    layout = resolve_layout(repo)
    ensure_layout(layout)
    return allocate_build(
        layout,
        repo,
        {"backend": "fdm", "device": "gpu", "precision": "double", "command": ["fullmag"]},
    )


def _allocate_worker(repo: Path, metadata: Mapping[str, object]) -> BuildLease:
    layout = resolve_layout(repo)
    ensure_layout(layout)
    return allocate_build(layout, repo, metadata)


def run_parallel_allocations(
    repo: Path, metadata: Mapping[str, object], count: int
) -> list[BuildLease]:
    with mp.get_context("spawn").Pool(count) as pool:
        return pool.starmap(_allocate_worker, [(repo, metadata)] * count)
~~~

- [ ] Step 5: Run allocator tests and CLI smoke.

Run: python -m pytest -q scripts/test_fullmag_storage.py scripts/test_fullmag_storage_contract.py

Expected: exit code 0; CLI resolve --json zwraca storage_root, builds_root, cache_root, runtimes_root, runs_root, locks_root i index_root.

---

### Task 2: Native Windows FDM i setup używają storage

**Files:**
- Modify: scripts/windows/run_fullmag.ps1
- Modify: scripts/windows/setup_fullmag.ps1
- Modify: scripts/test_windows_fullmag_launcher_contract.py
- Modify: scripts/test_fullmag_storage_contract.py

**Interfaces:**
- Launcher invokes python scripts/fullmag_storage.py with resolve, repo-root, platform windows and json options, then invokes allocate with the metadata file and json output.
- FULLMAG_PROJECT_STORAGE_ROOT is the only supported default-root override.
- FULLMAG_WINDOWS_BUILD_ROOT, FULLMAG_WINDOWS_CACHE_ROOT, FULLMAG_WINDOWS_TEMP_ROOT, FULLMAG_WINDOWS_TARGET_DIR and FULLMAG_FDM_NATIVE_BUILD_ROOT are rejected for normal new builds unless they resolve inside the allocated build and are explicitly marked diagnostic.

- [ ] Step 1: Add failing source-contract assertions.

~~~python
def test_native_windows_launcher_uses_project_storage_resolver() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8")

    assert "scripts\\fullmag_storage.py" in launcher
    assert "FULLMAG_PROJECT_STORAGE_ROOT" in launcher
    assert "allocate" in launcher
    assert '"fullmag-build\\$WorkspaceNamespace"' not in launcher
    assert '"fullmag-cache\\$WorkspaceNamespace"' not in launcher


def test_windows_setup_does_not_default_to_drive_root_flat_directories() -> None:
    setup = SETUP.read_text(encoding="utf-8")

    assert 'Join-Path $RepoDriveRoot "fullmag-cache"' not in setup
    assert 'Join-Path $RepoDriveRoot "fullmag-build"' not in setup
    assert 'Join-Path $RepoDriveRoot "fullmag-tmp"' not in setup
    assert "FULLMAG_PROJECT_STORAGE_ROOT" in setup
~~~

- [ ] Step 2: Run assertions and verify failure against current launchers.

Run: python -m pytest -q scripts/test_windows_fullmag_launcher_contract.py::test_native_windows_launcher_uses_project_storage_resolver scripts/test_windows_fullmag_launcher_contract.py::test_windows_setup_does_not_default_to_drive_root_flat_directories

Expected: FAIL because current launchers still derive fullmag-cache, fullmag-build and fullmag-tmp from the drive root.

- [ ] Step 3: Wire resolver and per-build output paths.

After resolving layout, set tool caches below storage/cache/windows/<tool>/<key>. For BuildMode=true, call the allocator and map:

~~~text
$BuildRoot          = <lease.build_root>
$TargetRoot         = <lease.cargo_target>
$nativeFdmBuildRoot = <lease.native_root>
$TempRoot           = <lease.staging_root>/tmp
$ManifestPath       = <lease.manifest_path>
~~~

For BuildMode=false, read the validated runtime pointer under storage/runtimes/current/fdm/<device> and never create a new mutable target. All CARGO_TARGET_DIR, CMake native output, CUDA cache, Python bytecode, pnpm/npm/pip/uv cache, TEMP/TMP and Playwright paths must be descendants of the resolved storage root. Existing source-identity and no-CPU-fallback checks remain unchanged.

If a legacy flat-root variable is set for a new build, stop with an actionable error naming FULLMAG_PROJECT_STORAGE_ROOT; do not silently reuse old data.

The PowerShell integration must pass the resolver JSON through ConvertFrom-Json and export only these values to child processes:

~~~powershell
$layout = $storageJson | ConvertFrom-Json
$env:FULLMAG_PROJECT_STORAGE_ROOT = $layout.storage_root
$env:FULLMAG_BUILD_ROOT = $lease.build_root
$env:FULLMAG_CARGO_TARGET_ROOT = $lease.cargo_target
$env:FULLMAG_FDM_NATIVE_BUILD_ROOT = $lease.native_root
$env:TEMP = Join-Path $lease.staging_root "tmp"
$env:TMP = $env:TEMP
~~~

- [ ] Step 4: Update setup to create only new cache/tool directories and print the selected path.

The setup script creates storage/cache/windows and prints:

~~~text
Fullmag project storage: C:\git\fullmag\storage
Legacy roots are read-only migration inputs: C:\fullmag-build, C:\fullmag-cache, C:\fullmag-tmp
~~~

It must not create the three legacy directories.

- [ ] Step 5: Run parser and focused Windows checks.

Run: python -m pytest -q scripts/test_windows_fullmag_launcher_contract.py scripts/test_fullmag_storage_contract.py

Run: powershell -NoLogo -NoProfile -Command "$null=[System.Management.Automation.Language.Parser]::ParseFile('scripts/windows/run_fullmag.ps1',[ref]$null,[ref]$null); if($null){exit 1}; 'PASS'"

Expected: exit code 0; parser emits PASS; no contract test accepts a drive-root flat default.

---

### Task 3: Windows FEM Docker Desktop route uses per-build bind mounts

**Files:**
- Modify: scripts/windows/run_fullmag_fem.ps1
- Modify: scripts/windows/run_fullmag_wsl.ps1
- Modify: scripts/windows/run_fullmag_docker.ps1
- Modify: compose.windows.yaml
- Modify: scripts/test_windows_fullmag_launcher_contract.py

**Interfaces:**
- All three PowerShell entrypoints resolve the same StorageLayout and use one per-invocation BuildLease.
- Compose variables remain FULLMAG_WINDOWS_REPO, FULLMAG_WINDOWS_BUILD_ROOT, FULLMAG_WINDOWS_CACHE_ROOT, FULLMAG_WINDOWS_TEMP_ROOT and related names, but values come from the accepted storage tree.
- Container paths remain /workspace, /workspace/.fullmag-build, /workspace/.fullmag-cache and /tmp/fullmag-windows; only host bind sources change.

- [ ] Step 1: Add failing tests for shared resolver and absence of legacy defaults.

~~~python
def test_windows_fem_aliases_share_storage_contract() -> None:
    for path in (LEGACY_FEM_LAUNCHER, FEM_LAUNCHER, DOCKER_LAUNCHER):
        launcher = path.read_text(encoding="utf-8")
        assert "FULLMAG_PROJECT_STORAGE_ROOT" in launcher
        assert "fullmag_storage.py" in launcher or "run_fullmag_fem.ps1" in launcher
        assert '"fullmag-build\\$WorkspaceNamespace"' not in launcher
        assert '"fullmag-cache\\$WorkspaceNamespace"' not in launcher
        assert '"fullmag-tmp\\$WorkspaceNamespace"' not in launcher


def test_windows_compose_keeps_only_external_bind_mounts() -> None:
    compose = WINDOWS_COMPOSE.read_text(encoding="utf-8")
    assert "type: bind" in compose
    assert "FULLMAG_WINDOWS_BUILD_ROOT" in compose
    assert "FULLMAG_WINDOWS_CACHE_ROOT" in compose
    assert "FULLMAG_WINDOWS_TEMP_ROOT" in compose
    assert "named" not in compose.lower()
~~~

- [ ] Step 2: Run tests and verify the old default contract fails.

Run: python -m pytest -q scripts/test_windows_fullmag_launcher_contract.py::test_windows_fem_aliases_share_storage_contract

Expected: FAIL because run_fullmag_wsl.ps1 and its compatibility alias still construct drive-root directories.

- [ ] Step 3: Route FEM build and state paths through the allocator.

run_fullmag_wsl.ps1 allocates before Docker build, maps lease native and cargo-target into the container, and keeps the existing FullmagWindowsFEMBuild mutex only for publication of the validated runtime. The long simulation still starts after releasing that mutex. State and manifest copies live under lease/runtime storage, not in a new repository-local build tree.

The run command continues to pass explicit FULLMAG_FEM_EXECUTION, FULLMAG_RELAX_DEVICE, FULLMAG_FEM_MFEM_DEVICE, FULLMAG_FEM_REQUIRE_GPU, FULLMAG_FEM_REQUIRE_CEED and FULLMAG_FDM_EXECUTION; no CPU fallback is introduced.

The Docker argument construction must use the allocated host directories in this shape:

~~~powershell
$env:FULLMAG_WINDOWS_BUILD_ROOT = To-ComposePath $lease.build_root
$env:FULLMAG_WINDOWS_CACHE_ROOT = To-ComposePath $layout.cache_root
$env:FULLMAG_WINDOWS_TEMP_ROOT = To-ComposePath $lease.staging_root
$env:FULLMAG_WINDOWS_STATE_ROOT = To-ComposePath $lease.build_root
~~~

- [ ] Step 4: Update Compose host-side path validation and test it.

The launcher exports only resolved absolute paths below one validated storage root. Compose keeps bind mounts for build/cache and does not use the repo bind mount as compiler output. Preserve Docker Desktop Linux engine, GPU visibility, source identity, image identity and runtime manifest checks.

- [ ] Step 5: Run PowerShell parser and Compose contract tests.

Run: python -m pytest -q scripts/test_windows_fullmag_launcher_contract.py

Run: powershell -NoLogo -NoProfile -Command "$files=@('scripts/windows/run_fullmag_fem.ps1','scripts/windows/run_fullmag_wsl.ps1','scripts/windows/run_fullmag_docker.ps1'); foreach($f in $files){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $f),[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}};'PASS'"

Expected: exit code 0 and PASS; all FEM aliases retain Docker Desktop/no-WSL behavior.

---

### Task 4: Linux managed build and runtime routes use the same logical layout

**Files:**
- Modify: scripts/lib/managed_fem_build_policy.sh
- Modify: scripts/lib/managed_fem_native_storage.sh
- Modify: scripts/lib/managed_fem_runtime_storage.sh
- Modify: scripts/export_fem_gpu_runtime.sh
- Modify: scripts/restore_persistent_fem_runtime.sh
- Modify: scripts/test_managed_fem_build_policy.py
- Modify: scripts/test_managed_fem_native_storage.py
- Modify: scripts/test_managed_fem_runtime_storage.py

**Interfaces:**
- resolve_managed_fem_project_storage exports FULLMAG_PROJECT_STORAGE_ROOT, FULLMAG_PROJECT_ID and FULLMAG_WORKTREE_ID.
- resolve_managed_fem_native_storage_profile continues returning the ext4-backed image/mount profile; backing images are infrastructure and are not automatically moved in this change.
- managed_fem_runtime_lock_path and existing atomic rebind/materialize functions remain the sole runtime publication owners.

- [ ] Step 1: Add failing tests for Linux default and ext4 exception.

The test module defines these paths before the tests:

~~~python
ROOT = Path(__file__).resolve().parents[1]
BUILD_POLICY = ROOT / "scripts/lib/managed_fem_build_policy.sh"
RUNTIME_STORAGE = ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
~~~

~~~python
def test_managed_policy_mentions_project_storage_root() -> None:
    body = BUILD_POLICY.read_text(encoding="utf-8")
    assert "FULLMAG_PROJECT_STORAGE_ROOT" in body
    assert "storage" in body
    assert "FULLMAG_NATIVE_BUILD_STORAGE_ROOT" in body


def test_runtime_storage_does_not_replace_ext4_provenance_guard() -> None:
    body = RUNTIME_STORAGE.read_text(encoding="utf-8")
    assert "findmnt" in body
    assert "CIFS" in body or "cifs" in body
    assert "validate_managed_fem_runtime_storage_target" in body
~~~

- [ ] Step 2: Run focused shell-policy tests before implementation.

Run: python -m pytest -q scripts/test_managed_fem_build_policy.py scripts/test_managed_fem_native_storage.py scripts/test_managed_fem_runtime_storage.py

Expected: the new project-storage assertion fails while existing ext4/symlink tests remain the baseline.

- [ ] Step 3: Integrate the shared resolver at the managed recipe boundary.

Before a managed build or runtime export, call:

~~~bash
storage_json="$(python3 scripts/fullmag_storage.py resolve --repo-root "$PWD" --platform linux --json)"
export FULLMAG_PROJECT_STORAGE_ROOT="$(printf '%s' "$storage_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["storage_root"])')"
~~~

Use the resolved storage for build-attempt metadata, reports and run records. Keep /zfn2/mateuszz/git/fullmag/build-volumes/*.ext4 and /mnt/fullmag-zfn2-native as explicitly validated managed infrastructure until a separate image migration; never label /tmp or CIFS as the durable root. A missing required mount fails before any large compile starts.

- [ ] Step 4: Preserve runtime publication semantics under storage/runtimes.

Exporters create a candidate in runtimes/<backend>/<device>/<hash>.staging, validate binary closure and manifest, acquire the existing publication lock, atomically publish the hash-addressed directory and switch current. Restore logic reads only validated manifests and keeps the previous current runtime after failed extraction or rebind. Existing symlink materialization for filesystems that reject symlinks remains intact.

- [ ] Step 5: Run shell syntax and focused managed-storage tests.

Run: bash -n scripts/lib/managed_fem_build_policy.sh scripts/lib/managed_fem_native_storage.sh scripts/lib/managed_fem_runtime_storage.sh scripts/export_fem_gpu_runtime.sh scripts/restore_persistent_fem_runtime.sh

Run: python -m pytest -q scripts/test_managed_fem_build_policy.py scripts/test_managed_fem_native_storage.py scripts/test_managed_fem_runtime_storage.py

Expected: exit code 0; existing CIFS, symlink, collision and atomic-rebind guards still pass.

---

### Task 5: Makefile i justfile nie tworzą dużych ad-hoc build roots

**Files:**
- Modify: Makefile
- Modify: justfile
- Modify: scripts/test_fullmag_storage_contract.py

**Interfaces:**
- FULLMAG_PROJECT_STORAGE_ROOT identifies project storage.
- FULLMAG_BUILD_ROOT identifies one allocated build attempt, never a shared project directory.
- FULLMAG_CARGO_TARGET_ROOT is derived from FULLMAG_BUILD_ROOT/cargo-target or an explicitly passed per-build directory.
- Managed just recipes remain the owner of container invocation; host cargo, cmake and hand-written Docker commands are diagnostics only.

- [ ] Step 1: Inventory every hard-coded large temporary path and classify it.

Run: rg -n '/tmp/fullmag-|target/debug|native/build|\\.fullmag/target|FULLMAG_CARGO_TARGET_ROOT|FULLMAG_BUILD_ROOT' -- Makefile justfile scripts

Record each match as per-build mutable output, shared safe cache, short-lived test staging or legacy diagnostic. Per-build mutable output and large test artifacts move below the resolver; only short-lived staging may remain in /tmp and must use mktemp -d with cleanup.

- [ ] Step 2: Add a source-contract test for authoritative recipes.

~~~python
def test_make_and_just_authoritative_routes_require_resolved_build_root() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")

    assert "FULLMAG_PROJECT_STORAGE_ROOT" in makefile or "FULLMAG_BUILD_ROOT" in makefile
    assert "FULLMAG_CARGO_TARGET_ROOT" in makefile
    assert "ensure-managed-fem-runtime" in justfile
    assert "FULLMAG_BUILD_ROOT" in justfile or "fullmag_storage.py" in justfile
~~~

- [ ] Step 3: Replace mutable target defaults with resolver-provided paths.

Makefile stops defaulting FULLMAG_CARGO_TARGET_ROOT to /tmp/fullmag-zfn2-build/cargo-targets. A managed caller supplies the allocated path; direct invocation without it exits with a message naming the resolver command. justfile passes the same variables into Make, Docker and managed FEM recipes while retaining separate per-recipe paths for independent tasks.

The Makefile guard is:

~~~make
ifeq ($(strip $(FULLMAG_CARGO_TARGET_ROOT)),)
$(error FULLMAG_CARGO_TARGET_ROOT is required; resolve a per-build path with scripts/fullmag_storage.py)
endif
FULLMAG_CARGO_TARGET_DIR ?= $(FULLMAG_CARGO_TARGET_ROOT)
~~~

- [ ] Step 4: Run recipe and contract checks without starting a heavy build.

Run: python -m pytest -q scripts/test_fullmag_storage_contract.py scripts/test_windows_fullmag_launcher_contract.py

Run: just --dry-run ensure-managed-fem-runtime if installed just supports --dry-run; otherwise run just --show ensure-managed-fem-runtime.

Expected: exit code 0; printed commands contain resolver/per-build variables and no new shared mutable target.

---

### Task 6: Manifest, lease, runtime publication and run provenance

**Files:**
- Modify: scripts/fullmag_storage.py
- Modify: scripts/windows/run_fullmag.ps1
- Modify: scripts/windows/run_fullmag_wsl.ps1
- Modify: scripts/export_fem_gpu_runtime.sh
- Modify: scripts/restore_persistent_fem_runtime.sh
- Modify: scripts/test_fullmag_storage.py
- Modify: scripts/test_managed_fem_runtime_storage.py

**Interfaces:**
- manifest.json contains schema_version, project_id, worktree_id, build_id, storage_root, project_root, repo_root, platform, host, source_commit, source_snapshot_sha256, backend, device, precision, features, command, tool_versions, cargo_target, native, cache, logs, started_at_utc, finished_at_utc, status, binary_sha256 and runtime_manifest_sha256 when published.
- status.json is atomically rewritten and uses only allocated, completed, failed, cancelled or abandoned.
- lease.json records PID, host, process start UTC, platform, worktree, source snapshot and command.
- publish_runtime(layout: StorageLayout, lease: BuildLease, backend: str, device: str, candidate_root: Path) -> Path returns only a validated hash-addressed runtime path; it never returns a staging path.

Test fixtures create a completed lease with a small executable payload and a manifest containing its SHA-256, create an old valid runtime below the temporary storage root, and read/write the current pointer through the public publication helpers. The test wrappers publish_runtime_for_test and publish_invalid_runtime_for_test call the production function with those fixtures; they do not mock the lock or containment checks.

- [ ] Step 1: Add failing tests for state transitions and publish rollback.

~~~python
def test_failed_build_cannot_be_published_as_current(tmp_path: Path) -> None:
    lease = allocate_for_test(tmp_path / "project" / "fullmag")
    update_build_status(lease, "failed", error="compiler exit 1")

    with pytest.raises(StorageError, match="failed"):
        publish_runtime_for_test(lease)


def test_publish_failure_keeps_previous_current_runtime(tmp_path: Path) -> None:
    old_runtime = create_valid_runtime(tmp_path / "storage/runtimes/fdm/gpu/old")
    install_current_pointer(tmp_path / "storage", old_runtime)

    with pytest.raises(StorageError):
        publish_invalid_runtime_for_test(tmp_path / "storage", "new")

    assert read_current_pointer(tmp_path / "storage") == old_runtime
~~~

- [ ] Step 2: Implement atomic status and publication.

Write JSON to a same-directory temporary file, flush it and replace with os.replace. Publication validates candidate manifest, binary hashes, source identity, backend/device/platform and storage containment before acquiring publication.lock. The current pointer is replaced only after the final hash-addressed directory is complete; on any exception the old pointer remains untouched.

The public publication signature is publish_runtime(layout: StorageLayout, lease: BuildLease, backend: str, device: str, candidate_root: Path) -> Path. The returned path must be storage/runtimes/<backend>/<device>/<content-hash>; passing a failed lease or a candidate outside storage raises StorageError before any pointer replacement.

- [ ] Step 3: Wire existing launcher manifests to the new fields.

Retain current source identity, image identity, requested/resolved device and no-fallback fields. Add project/worktree/build/storage identity and paths. A build=False invocation verifies manifest and binary hashes before execution and never interprets a legacy manifest as a current build.

- [ ] Step 4: Run provenance and publication tests.

Run: python -m pytest -q scripts/test_fullmag_storage.py scripts/test_managed_fem_runtime_storage.py

Expected: exit code 0; failed/abandoned candidates cannot become current, and an injected publish failure leaves the old runtime resolvable.

---

### Task 7: Read-only inventory, migration boundary and safe prune

**Files:**
- Create: scripts/inventory_fullmag_storage.py
- Create: scripts/test_fullmag_storage_inventory.py
- Create: scripts/prune_fullmag_storage.py
- Create: scripts/test_prune_fullmag_storage.py
- Modify: scripts/prune_managed_fem_runtimes.sh

**Interfaces:**
- inventory_fullmag_storage.py --storage-root PATH --legacy-root PATH --legacy-root PATH --json never writes to inspected roots.
- prune_fullmag_storage.py --storage-root PATH --json is always dry-run unless --apply is supplied together with FULLMAG_RUNTIME_DRY_RUN=0 and an explicit category.
- Inventory record contains absolute path, category, bytes, mtime UTC, manifest status, lease state, active-process/container evidence and reason for protection/candidacy.
- inventory_storage(storage_root: Path, legacy_roots: Sequence[Path]) -> list[dict[str, object]]
- prune_candidates(storage_root: Path, categories: Sequence[str], apply: bool = False, targets: Sequence[Path] | None = None) -> list[dict[str, object]]

- [ ] Step 1: Add tests proving dry-run and containment guards.

The test wrappers are direct calls:

~~~python
def inventory_for_test(storage_root: Path, legacy_roots: list[Path]) -> list[dict[str, object]]:
    return inventory_storage(storage_root, legacy_roots)


def prune_for_test(storage_root: Path, targets: list[Path]) -> list[dict[str, object]]:
    return prune_candidates(storage_root, ["failed"], apply=False, targets=targets)
~~~

~~~python
def test_inventory_reports_legacy_roots_without_modifying_them(tmp_path: Path) -> None:
    legacy = tmp_path / "fullmag-build"
    (legacy / "old-build").mkdir(parents=True)
    (legacy / "old-build" / "log.txt").write_text("legacy", encoding="utf-8")
    before = (legacy / "old-build" / "log.txt").read_bytes()

    report = inventory_for_test(tmp_path / "storage", [legacy])

    assert report[0]["path"] == str(legacy / "old-build")
    assert (legacy / "old-build" / "log.txt").read_bytes() == before


def test_prune_rejects_path_outside_storage(tmp_path: Path) -> None:
    with pytest.raises(StorageError, match="storage root"):
        prune_for_test(tmp_path / "storage", [tmp_path / "outside"])
~~~

- [ ] Step 2: Implement inventory and dry-run only.

Inventory includes C:\fullmag-build, C:\fullmag-cache and C:\fullmag-tmp when present, but does not stop active FDM, Docker or BuildKit. Docker probing is best-effort evidence; daemon timeout is recorded as docker_status=unavailable, never interpreted as absence of active containers.

- [ ] Step 3: Add migration metadata without moving active data.

Migration candidates are only inactive legacy directories. A future explicit migration may copy them to storage/builds/legacy/<date>/<legacy-id>, preserve old manifest/log and write migration.json; the first implementation only prints this mapping. Active FDM evidence, active Docker/BuildKit resources and runtime current are protected by status/lease checks.

- [ ] Step 4: Align managed runtime prune with the exact dry-run variable.

Keep the existing exact guard FULLMAG_RUNTIME_DRY_RUN=1 for managed FEM runtime prune. Resolve the target first, verify it is below the accepted root and refuse a broad drive-root wildcard. No deletion is performed in this task.

- [ ] Step 5: Run inventory/prune tests and a real read-only report.

Run: python -m pytest -q scripts/test_fullmag_storage_inventory.py scripts/test_prune_fullmag_storage.py scripts/test_prune_managed_fem_runtimes.py

Run: python scripts/inventory_fullmag_storage.py --storage-root 'C:\git\fullmag\storage' --legacy-root 'C:\fullmag-build' --legacy-root 'C:\fullmag-cache' --legacy-root 'C:\fullmag-tmp' --json

Expected: exit code 0; JSON is printed; no file under any legacy root is changed or removed.

---

### Task 8: Dokumentacja i decyzja architektoniczna

**Files:**
- Create: docs/adr/0030-project-storage-and-build-concurrency.md
- Modify: AGENTS.md
- Modify: docs/guides/windows-first-development.md
- Modify: docs/superpowers/specs/2026-07-29-persistent-external-builds-design.md

**Interfaces:**
- Dokumentacja używa C:\git\fullmag\storage i /zfn2/mateuszz/git/fullmag/storage jako publicznych project storage roots.
- Stare flat roots są nazwane legacy, nie są przedstawiane jako aktualny default i nie są kasowane.
- Dokumentacja rozróżnia project root, repo root, storage root, build attempt, cache, runtime i run artifacts.

- [ ] Step 1: Write ADR 0030 with the accepted decision.

ADR states: one storage root per project; per-worktree/per-build mutable outputs; shared safe caches; atomic manifests/leases/current publication; explicit FULLMAG_PROJECT_STORAGE_ROOT; no ineffective ../storage .gitignore rule; no automatic legacy deletion; Windows Docker Desktop and Linux ext4 constraints remain separate.

- [ ] Step 2: Replace stale AGENTS and Windows guide rules.

Update rules that currently describe drive-root fullmag-cache, fullmag-build and fullmag-tmp. Add exact default path, resolver precedence, legacy rejection, reset protection, parallel-build rule and:

~~~powershell
$env:FULLMAG_PROJECT_STORAGE_ROOT = 'C:\git\fullmag\storage'
python .\scripts\fullmag_storage.py resolve --repo-root 'C:\git\fullmag\fullmag' --platform windows --json
~~~

~~~bash
FULLMAG_PROJECT_STORAGE_ROOT=/zfn2/mateuszz/git/fullmag/storage \
python3 scripts/fullmag_storage.py resolve --repo-root "$PWD" --platform linux --json
~~~

- [ ] Step 3: Reconcile older persistent-runtime specification.

Preserve its ext4, symlink, manifest and atomic publication requirements, but state that new project storage is the public attempt/cache/runtime boundary and existing backing images remain an explicitly managed infrastructure migration boundary.

- [ ] Step 4: Run documentation/source consistency checks.

Run: rg -n 'C:\\fullmag-(build|cache|tmp)|<drive>:\\fullmag-(build|cache|tmp)|FULLMAG_PROJECT_STORAGE_ROOT|C:\\git\\fullmag\\storage|/zfn2/mateuszz/git/fullmag/storage' -- AGENTS.md docs/guides docs/adr docs/superpowers/specs

Expected: current operational text points to the new storage root; legacy paths occur only in migration/history warnings.

---

### Task 9: Final qualification without destructive cleanup

**Files:**
- Modify: scripts/test_fullmag_storage_contract.py
- Modify: scripts/test_windows_fullmag_launcher_contract.py
- Modify: scripts/test_managed_fem_build_policy.py

- [ ] Step 1: Run all focused Python contracts.

Run: python -m pytest -q scripts/test_fullmag_storage.py scripts/test_fullmag_storage_contract.py scripts/test_windows_fullmag_launcher_contract.py scripts/test_managed_fem_build_policy.py scripts/test_managed_fem_native_storage.py scripts/test_managed_fem_runtime_storage.py scripts/test_prune_managed_fem_runtimes.py

Expected: exit code 0; all listed contract suites pass.

- [ ] Step 2: Parse every changed PowerShell file.

Run: powershell -NoLogo -NoProfile -Command "$files=@('scripts/windows/run_fullmag.ps1','scripts/windows/run_fullmag_fem.ps1','scripts/windows/run_fullmag_wsl.ps1','scripts/windows/run_fullmag_docker.ps1','scripts/windows/setup_fullmag.ps1'); foreach($f in $files){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $f),[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}};'PowerShell parse PASS'"

Expected: PowerShell parse PASS and exit code 0.

- [ ] Step 3: Run shell syntax checks and recipe inspection.

Run: bash -n scripts/lib/managed_fem_build_policy.sh scripts/lib/managed_fem_native_storage.sh scripts/lib/managed_fem_runtime_storage.sh scripts/export_fem_gpu_runtime.sh scripts/restore_persistent_fem_runtime.sh scripts/prune_managed_fem_runtimes.sh

Run: just --show ensure-managed-fem-runtime

Expected: exit code 0; no changed authoritative route writes a new mutable target to checkout, drive root or unqualified /tmp.

- [ ] Step 4: Perform a read-only storage and process audit before any runtime smoke.

Run inventory, inspect active processes and Docker state, and record Docker daemon unavailability separately if it times out. Do not stop active FDM, FEM, Docker or BuildKit processes during this qualification.

- [ ] Step 5: Only after explicit authorization, run one minimal build/runtime smoke.

Use the repository-managed Windows launcher for FDM and scripts/windows/run_fullmag_fem.ps1 for FEM. Verify manifest, build_N, cargo-target, native, storage containment, requested/resolved device and exit code. Do not perform migration or deletion in the smoke.

## Completion gate

The work is complete only when two concurrent allocations produce distinct build directories, different worktrees never share mutable targets, Windows and Linux launchers resolve the same logical layout, legacy roots are rejected for new builds, failed candidates cannot become current, dry-run inventory is read-only, and all focused contracts/parser checks pass. Existing legacy data remains untouched until a separate, explicitly approved migration and cleanup operation.
