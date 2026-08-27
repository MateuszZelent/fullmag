# Managed FEM Build Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przyspieszyć lokalne przebudowy managed FEM przez minimalny kontekst Docker, checksumową świeżość Cargo i selektywną invalidację natywnych artefaktów.

**Architecture:** `local-d` wybiera domyślnie istniejący tryb reuse, a `canonical` pozostaje czysty. Cargo nightly rozpoznaje zmiany Rust po sumie kontrolnej; osobny fingerprint wejść CMake/CUDA czyści tylko crate’y sys, gdy zmienia się natywny backend lub obraz zależności.

**Tech Stack:** Bash, Python 3/pytest, Cargo nightly, Docker Compose, `just`.

## Global Constraints

- Natywny FEM/MFEM/CUDA/hypre/libCEED jest budowany wyłącznie przez kontenerowe recepty `just`.
- Profil `canonical` bez override'u zachowuje pełny clean build.
- Profil `local-d` bez override'u wybiera reuse, ale nie może opublikować starej binarki pod nową tożsamością źródła.
- Jawne `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0|1` zawsze wygrywa.
- Runtime manifest, source identity, source provenance i walidacja archiwum pozostają fail-closed.
- Aktywna symulacja i używany runtime nie mogą zostać zatrzymane ani wyczyszczone.
- Nie wykonujemy commitów w bieżącym wspólnym, brudnym drzewie.

---

### Task 1: Minimalny kontekst Docker

**Files:**
- Create: `.dockerignore`
- Create: `scripts/test_managed_fem_docker_context.py`

**Interfaces:**
- Produces: root build context zawierający tylko `docker/**`.
- Protects: wszystkie Dockerfile wskazane przez `build.context: .` przed dodaniem lokalnego `COPY`/`ADD` bez aktualizacji kontraktu.

- [ ] **Step 1: Napisz test RED**

  Test ma odczytać `compose.yaml` i `compose.windows.yaml`, zebrać ścieżki
  `dockerfile:` należące do bloków z `context: .`, a następnie wymagać:

  ```python
  assert dockerignore.splitlines() == ["**", "!docker/", "!docker/**"]
  assert all("--from=" in line for line in copy_or_add_lines)
  ```

- [ ] **Step 2: Potwierdź RED**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_managed_fem_docker_context.py
  ```

  Expected: FAIL, ponieważ `.dockerignore` nie istnieje.

- [ ] **Step 3: Dodaj minimalny `.dockerignore`**

  Dokładna treść:

  ```dockerignore
  **
  !docker/
  !docker/**
  ```

- [ ] **Step 4: Potwierdź GREEN**

  Uruchom ponownie test z kroku 2. Expected: PASS.

### Task 2: Profilowa polityka clean/reuse

**Files:**
- Create: `scripts/lib/managed_fem_build_policy.sh`
- Create: `scripts/test_managed_fem_build_policy.py`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Modify: `justfile:5164`
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Produces: `resolve_managed_fem_build_policy`.
- Sets: exported `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0|1`.
- Consumes: `FULLMAG_NATIVE_STORAGE_PROFILE=canonical|local-d` i opcjonalny jawny override reuse.

- [ ] **Step 1: Napisz testy RED helpera i receptury**

  Uruchamiaj helper w prawdziwym Bash subprocessie. Wymagaj:

  ```python
  assert resolve(profile="canonical", reuse=None) == "0"
  assert resolve(profile="local-d", reuse=None) == "1"
  assert resolve(profile="local-d", reuse="0") == "0"
  assert resolve(profile="canonical", reuse="1") == "1"
  ```

  Dodaj przypadki błędnego profilu, pustego override'u i wartości `2`, które
  muszą zwrócić kod `2`. Test justfile ma odrzucić stały tekst
  `FULLMAG_FEM_RUNTIME_REUSE_BUILD=0 just rebuild-fem-runtime` i wymagać
  przekazania rozwiązanej wartości.

- [ ] **Step 2: Potwierdź RED**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_managed_fem_build_policy.py scripts/test_export_fem_gpu_runtime_copy_helpers.py -k 'build_policy or ensure_managed_runtime_rebuilds'
  ```

  Expected: FAIL z powodu brakującego helpera i stałego `reuse=0`.

- [ ] **Step 3: Zaimplementuj helper i podłącz oba wejścia**

  Funkcja ma rozróżnić zmienną nieustawioną od pustej, wybrać wartość według
  profilu, sprawdzić zamknięte zbiory profili i wartości, a następnie
  `export FULLMAG_FEM_RUNTIME_REUSE_BUILD`.

  `ensure-managed-fem-runtime` ma wywołać helper przed capture identity i użyć:

  ```bash
  FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1 \
  FULLMAG_FEM_RUNTIME_REUSE_BUILD="$FULLMAG_FEM_RUNTIME_REUSE_BUILD" \
  just rebuild-fem-runtime
  ```

  Eksporter ma wywołać ten sam helper po rozwiązaniu storage profile zamiast
  nadawać stałe `:=0`.

- [ ] **Step 4: Potwierdź GREEN**

  Uruchom ponownie komendę z kroku 2. Expected: PASS.

### Task 3: Checksum freshness i natywny fingerprint

**Files:**
- Create: `scripts/managed_fem_native_build_inputs.v1.txt`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Modify: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Produces: hostowy `FULLMAG_NATIVE_BUILD_SOURCE_SHA256`.
- Persists: `/workspace/target/.fullmag-managed-fem-native-build-v1` dopiero po udanym buildzie.
- Invalidates: tylko `fullmag-fem-sys` i `fullmag-fdm-sys`, gdy fingerprint natywny się zmieni.

- [ ] **Step 1: Napisz testy RED eksportera**

  Wymagaj, aby exporter:

  ```python
  assert "-Z checksum-freshness" in exporter
  assert "managed_fem_native_build_inputs.v1.txt" in exporter
  assert "cargo +nightly clean -p fullmag-fem-sys -p fullmag-fdm-sys" in exporter
  assert ".fullmag-managed-fem-native-build-v1" in exporter
  ```

  Sprawdź kolejność indeksów: zapis stempla musi wystąpić po zakończonym
  `cargo ... build`, a nie przed nim. Wymagaj też, aby fingerprint zawierał
  digest źródła, ID obrazu, architektury CUDA i NVTX.

- [ ] **Step 2: Potwierdź RED**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py -k 'checksum or native_build_fingerprint'
  ```

  Expected: FAIL, ponieważ exporter nie używa checksum freshness ani stempla.

- [ ] **Step 3: Dodaj manifest i hostowy digest**

  Manifest ma zawierać dokładnie:

  ```text
  Cargo.lock
  Cargo.toml
  backends/fdm
  backends/fem
  crates/fullmag-fdm-sys
  crates/fullmag-fem-sys
  native
  ```

  Użyj istniejącego `hash_managed_fem_runtime_sources.py` z tym manifestem i
  `--allow-dirty`. Wyciągnij `source_inputs_sha256`, sprawdź format 64 znaków
  hex i przekaż go do kontenera.

- [ ] **Step 4: Dodaj fingerprint i selektywne czyszczenie**

  Fingerprint ma połączyć wersjonowany prefiks, source digest, Docker image ID,
  CUDA architectures i NVTX. Przy `reuse=1` i różnym/brakującym stemplu wyczyść
  tylko oba crate’y sys. Przy zgodnym stemplu pozostaw natywne artefakty. Przy
  `reuse=0` zachowaj obecne `cargo clean --workspace --release`.

  Każdy release build uruchom przez:

  ```bash
  cargo +nightly -Z checksum-freshness build ... --release
  ```

  Po sukcesie zapisz fingerprint do pliku tymczasowego i atomowo wykonaj `mv`
  na ścieżkę stempla.

- [ ] **Step 5: Potwierdź GREEN**

  Uruchom ponownie komendę z kroku 2. Expected: PASS.

### Task 4: Regresja mtime i końcowa weryfikacja bez ingerencji w runtime

**Files:**
- Modify: `scripts/test_managed_fem_build_policy.py`
- No production source changes expected.

**Interfaces:**
- Proves: Cargo nightly przebudowuje zmieniony plik Rust o starym `mtime` w tym samym target directory.

- [ ] **Step 1: Dodaj test regresyjny Cargo**

  W katalogu `tmp_path` utwórz minimalny crate binarny, zbuduj tekst `first`,
  zmień źródło na równodługi tekst `other`, ustaw jego `mtime` na czas starszy
  niż pierwszy build i uruchom ponownie Cargo z `-Z checksum-freshness` oraz
  tym samym `CARGO_TARGET_DIR`. Uruchom binarkę i wymagaj `other`.

- [ ] **Step 2: Uruchom cały skupiony pakiet**

  Run:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q \
    scripts/test_managed_fem_docker_context.py \
    scripts/test_managed_fem_build_policy.py \
    scripts/test_managed_fem_native_storage.py \
    scripts/test_managed_fem_runtime_target_mount.py \
    scripts/test_restore_persistent_fem_runtime.py \
    scripts/test_export_fem_gpu_runtime_copy_helpers.py \
    scripts/test_capture_source_snapshot_identity.py \
    scripts/test_runtime_source_change_policy.py \
    scripts/test_hash_managed_fem_runtime_sources.py
  ```

  Expected: wszystkie testy PASS.

- [ ] **Step 3: Weryfikacje statyczne**

  Run:

  ```bash
  bash -n scripts/lib/managed_fem_build_policy.sh
  bash -n scripts/export_fem_gpu_runtime.sh
  git diff --check
  ```

  Expected: kod wyjścia `0` dla każdej komendy.

- [ ] **Step 4: Odłóż pełny managed rebuild**

  Nie uruchamiaj `just rebuild-fem-runtime`, dopóki proces dokładnej symulacji
  bimerona używa managed runtime. Po jej zakończeniu bramka runtime to:

  ```bash
  FULLMAG_NATIVE_STORAGE_PROFILE=local-d just ensure-managed-fem-runtime
  ```

  Drugi identyczny przebieg po kontrolowanej zmianie Rust ma pokazać reuse,
  checksum freshness i brak pełnego `cargo clean --workspace --release`.
