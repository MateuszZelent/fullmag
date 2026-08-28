# Wydajność i certyfikacja mixed mesh FEM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Cel:** skrócić tworzenie kanonicznego mixed mesh `prism6 + pyramid5 + tet4` dla SP4 bez obniżenia jakości, usunąć regresję optymalizatora Netgen, przenieść kosztowną certyfikację topologii do deterministycznego Rust/Rayon oraz zapewnić bezpieczny cache-hit poniżej 2 s.

**Architektura:** Python pozostaje właścicielem authoringu, OCC i sterowania Gmsh; Gmsh pozostaje jedynym generatorem geometrii i siatki. Istniejący kontrakt certyfikatu w `fullmag-ir` zostaje wydzielony jako deterministyczny silnik obliczeniowy i równolegle liczy metryki per-cell oraz rekordy ścian. PyO3 przekazuje duże tablice przez typowane bufory NumPy, bez JSON-owego kopiowania całej siatki. Artefakt `.fullmag-mesh` v2 wiąże certyfikat z digestami członków ZIP, fingerprintem topologii, polityką authoringu i wersją algorytmu. Tylko wewnętrzny, content-addressed cache Fullmag może użyć szybkiej ścieżki; import, v1 i jawny audit zawsze wykonują pełną rekalkulację. `backends/fem` nadal jest właścicielem końcowego preflightu wykonawczego, MFEM, operatorów i kwalifikacji CPU/GPU.

**Stos:** Python 3, NumPy, Gmsh 4.15.2, Rust, Rayon, PyO3, `numpy` dla PyO3, C++/MFEM, ZIP/NPZ/JSON, SHA-256, `unittest`, `cargo test` oraz zarządzane recepty `just`.

## Global Constraints

- Każda zmiana zachowuje kanoniczne semantyki z `docs/physics/0105-fem-meshing-production-acceptance.md`, `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`, ADR-0021 i ADR-0027.
- Nie powstaje drugi mesher ani drugi solver FEM w Rust. Rust oblicza i weryfikuje językowo neutralny dowód artefaktu; `backends/fem` zachowuje runtime preflight i wszystkie operatory.
- Nie wolno wyłączać certyfikacji, zmniejszać liczby próbek, luzować tolerancji, akceptować fallbacku topologii ani ukrywać wyniku `degraded`.
- Nie wolno użyć skrótu cache dla artefaktu importowanego, v1, o niezgodnym authoring fingerprint, niezgodnej polityce, nieznanej wersji certyfikatora albo niezgodnym digescie.
- Równoległość musi być deterministyczna bitowo dla pól całkowitych i fingerprintu oraz stabilna w granicach istniejących tolerancji binary64 dla metryk zmiennoprzecinkowych. Redukcje float są wykonywane w ustalonej kolejności globalnych ordinals.
- Gmsh mixed pozostaje jednowątkowy do chwili przejścia osobnej macierzy deterministyczności dla `1, 2, 4, 8` wątków. Rayon może być wielowątkowy wcześniej, ponieważ jego wynik ma deterministyczny porządek.
- Zmiany dokumentacji numerycznej poprzedzają kod i używają `physics-publication` oraz `scientific-documentation-contract`. Zmiana polityki artefaktu/provenance aktualizuje ADR przez `adr-check`.
- Natywne twierdzenia FEM CPU/GPU są ważne wyłącznie po przejściu kontenerowych recept `just`. Hostowe testy Rust/Python są bramkami deweloperskimi, nie dowodem produkcyjnym.
- Worktree jest współdzielony i brudny. Implementacja dotyka wyłącznie plików wyszczególnionych w danym zadaniu, nie wykonuje `reset`, `stash`, `clean`, masowego formatowania, commita ani push bez osobnej zgody użytkownika.
- Bieżący storage managed runtime jest pełny. Nie wolno niczego usuwać automatycznie. Pełna kwalifikacja pozostaje `BLOCKED`, dopóki świeży preflight nie potwierdzi wymaganej wolnej przestrzeni.

---

## 1. Stan wejściowy i decyzja wykonawcza

**Rewizja bazowa:** `bc422d118f8bdc42290eb9d0ee3333a6a66b7add`.

**Data planu:** 2026-08-27.

**Zakres referencyjny:** canonical SP4 mixed, `layers=1`, magnet `prism6`, transition `pyramid5`, far air `tet4`, bbox airbox, Gmsh 4.15.2, strict certificate, bez fallbacku.

### 1.1 Potwierdzone fakty

| ID | Status | Dowód | Wniosek |
|---|---|---|---|
| PERF-001 | `CONFIRMED` | Świeży cold run potrzebował około 334 s do wygenerowania i pełnego certyfikowania siatki. | Nie wolno optymalizować jednego etapu bez oddzielnego pomiaru generate, repair, extraction i certificate. |
| PERF-002 | `CONFIRMED` | Wczytanie artefaktu 1,75 MB zajęło 52,346721 s dla 28 010 nodes, 132 760 cells i 33 350 facets. | Ponowne użycie meshu jest zdominowane przez walidację, nie I/O. |
| PERF-003 | `CONFIRMED` | `_deserialize_mesh` zużył około 40,07 s, `MeshData.__post_init__` około 40,02 s, a pełna rekalkulacja certificate evidence około 37,53 s. | Pełny audyt w Pythonie jest głównym warm-path bottleneckiem. |
| PERF-004 | `CONFIRMED` | `_mixed_mesh_conformity_counts` zużył około 25,65 s i pośrednio buduje nakładające się struktury adjacency. | Najpierw trzeba usunąć duplikację pracy, potem przenieść czysty kernel do Rust/Rayon. |
| QUAL-001 | `CONFIRMED` | Commit `65669fae870a62d908b0ebacf18b118bb1ef853b` zmienił wewnętrzny mixed repair z domyślnego Gmsh na `Netgen`. | Zmiana algorytmu meshowania była niepowiązana z deklarowanym zakresem commita i wymaga jawnej polityki oraz macierzy jakości. |
| QUAL-002 | `CONFIRMED` | Netgen wygenerował nakładające się lub non-manifold tetrahedra w canonical SP4 mixed, a certyfikat prawidłowo odrzucił mesh. | Certyfikatu nie wolno wyłączać; należy usunąć wadliwy wybór optymalizatora. |
| QUAL-003 | `CONFIRMED` | Artefakty z wcześniejszym/default repair oraz `Relocate3D` przeszły certificate dla tego przypadku. | Docelowy repair to `Relocate3D`, pod warunkiem przejścia pełnej macierzy N=10 i progów jakości. |
| ARCH-001 | `CONFIRMED` | Rust `crates/fullmag-ir/src/mesh_assets.rs` już ma rekalkulację mixed certificate i walidację względem `MeshIR`. | Nie należy pisać algorytmu od zera ani kopiować równań do nowego crate. |
| ARCH-002 | `CONFIRMED` | `backends/fem/core/fem_mesh.cpp` ma typed topology i order-2 Jacobian validation. | Rust nie przejmuje wykonawczego właściciela FEM. |
| INFRA-001 | `BLOCKED` | Root WSL jest blisko pełnego stanu, a `/mnt/fullmag-zfn2-native` osiągnął 100%. | Managed rebuild i macierz CPU/GPU wymagają odzyskania przestrzeni poza zakresem tego planu; brak miejsca nie jest dowodem błędu solvera. |

### 1.2 Werdykt

Nie należy przepisywać generowania Gmsh z Pythona do Rust. Python w tej ścieżce głównie wywołuje natywne OCC/Gmsh, więc sam rewrite warstwy sterującej nie usuwa kosztu native meshingu. Największy pewny zysk daje czteroczęściowa naprawa:

1. przywrócić poprawny i jawnie wersjonowany repair `Relocate3D`;
2. usunąć podwójną rekalkulację certificate podczas budowy jednego obiektu;
3. wykorzystać istniejący algorytm Rust i zrównoleglić jego niezależne kernelle przez Rayon;
4. nie wykonywać pełnego audytu ponownie dla niezmienionego artefaktu z wewnętrznego cache, lecz zweryfikować jego cryptographic binding i szybki native preflight.

### 1.3 Poza zakresem

- własny generator tetra/prism/pyramid w Rust;
- zastępowanie Gmsh inną biblioteką;
- zmiana równań, tolerancji fizycznych lub ProblemIR authoringu;
- obniżanie liczby elementów jako substytut optymalizacji;
- usuwanie certyfikacji dla przebiegu produkcyjnego;
- automatyczne kasowanie cache lub zarządzanych runtime'ów;
- zmiany Control Room niezwiązane bezpośrednio z publikacją istniejących timingów;
- kwalifikacja nowych klas geometrii przed przejściem canonical SP4 mixed.

---

## 2. Docelowy przepływ danych

```text
Python DSL / Study
    |
    v
canonical mesh-authoring document
    |
    +--> SHA-256 authoring/policy/cache key
    |         |
    |         +--> trusted cache hit
    |         |       |
    |         |       +--> ZIP hashes + receipt binding + native structural preflight
    |         |       +--> load <= 2 s
    |         |
    |         +--> cache miss
    |                 |
    |                 v
    |             OCC + Gmsh 4.15.2
    |                 |
    |                 v
    |             Relocate3D repair
    |                 |
    |                 v
    |             NumPy extraction
    |                 |
    |                 v
    |             Rust/Rayon certificate engine
    |                 |
    |                 v
    |             artifact v2 + bound certification receipt
    |                 |
    |                 v
    |             atomic cache publish
    |
    v
backends/fem native preflight
    |
    v
MFEM CPU/GPU execution
```

### 2.1 Właściciele odpowiedzialności

| Warstwa | Właściciel | Odpowiedzialność | Zakazane rozszerzenie |
|---|---|---|---|
| Authoring | `packages/fullmag-py/src/fullmag/world.py` | kanoniczny dokument żądanej geometrii, parametrów i polityki | nie zapisuje measured result jako requested intent |
| Orchestration | `packages/fullmag-py/src/fullmag/model/problem.py` | cache lookup, cache miss build, atomic publish, przekazanie assetu | nie implementuje metryk topologicznych |
| Geometry/mesh | `_gmsh_swept.py` i `_gmsh_airbox.py` | OCC/Gmsh, repair, extraction, oriented mesh | nie akceptuje nieważnego meshu |
| Reference oracle | `_gmsh_types.py` | czytelna implementacja Python do testów krzyżowych i awaryjnego pełnego audytu deweloperskiego | nie jest produkcyjną szybką ścieżką |
| Artifact certificate | `crates/fullmag-ir/src/mesh_assets.rs` | wspólny kontrakt, deterministyczna rekalkulacja evidence, walidacja | nie uruchamia MFEM ani solvera |
| Python native bridge | `crates/fullmag-py-core/src/lib.rs` | typowane bufory i wynik certificate/validation | nie serializuje całej siatki do JSON |
| Persistence | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | schema v2, member hashes, receipt binding, trust mode | nie traktuje SHA-256 jako podpisu autora |
| Runtime FEM | `backends/fem/core/fem_mesh.cpp` | finalny preflight topologii i Jacobianów przed operatorami | nie zastępuje przenośnego certificate artefaktu |

### 2.2 Tryby zaufania

| Tryb | Źródło | Obowiązkowe kontrole | Pełna rekalkulacja O(N faces) |
|---|---|---|---|
| `trusted_cache_fast` | wewnętrzny content-addressed cache, wpis utworzony atomowo przez bieżący Fullmag | schema, rozmiar i SHA każdego membera, authoring fingerprint, policy fingerprint, topology fingerprint, certificate payload digest, certifier version, Gmsh version, native structural preflight | nie, jeżeli każdy binding jest zgodny |
| `portable_full_audit` | jawne `StudyMeshHandle.load` lub `save_or_load` dla user path | wszystkie kontrole fast plus pełna native rekalkulacja certificate i marker validation | tak |
| `legacy_v1_full_audit` | `fullmag.mesh-artifact.v1` | obecny member digest, pełna rekalkulacja, marker validation; po sukcesie opcjonalna promocja do odrębnego cache v2 | tak |
| `imported_full_audit` | plik spoza cache lub artefakt o nieznanym producerze | pełny audit, fail-closed, bez zaufania do receipt | tak |
| `forced_audit` | diagnostyka i bramka release | pełna rekalkulacja niezależnie od pochodzenia | tak |

SHA-256 zapewnia integralność względem zapisanej wartości, ale bez klucza nie zapewnia autentyczności autora. Dokumentacja i nazwy pól używają określenia `binding` lub `digest`, nigdy `signature`.

---

## 3. Mierzalne kryteria sukcesu

### 3.1 Benchmark referencyjny

Każdy wynik używa tego samego canonical SP4 mixed z `tests/standard_problems/mumag/sp4/fem/problem.py`. Harness zapisuje pełny commit, dirty fingerprint, wersję Python, Gmsh, Rust certifier algorithm, CPU model, logical CPUs, Rayon threads, Gmsh threads, storage path, node/cell/facet counts, topology fingerprint i wszystkie quality metrics.

Cold run usuwa wyłącznie własny tymczasowy katalog benchmarku utworzony przez harness. Nie usuwa współdzielonego cache. Warm run używa dokładnie tego samego artefaktu v2 i tego samego cache key. Najpierw wykonuje się dwa warm-upy, potem mierzy:

- 5 niezależnych cold runs;
- 10 warm cache hits;
- 10 pełnych native audits tego samego artefaktu;
- 3 pełne Python-reference audits do porównania, ponieważ są kosztowne.

### 3.2 Bramki wydajności

| Gate | Warunek przejścia |
|---|---|
| PERF-G01 warm cache | p95 `total_s <= 2.0` i maksimum `<= 2.5 s` dla 10 pomiarów |
| PERF-G02 cold build | p95 `total_s <= 180.0` oraz mediana `<= 0.65 * frozen_baseline_median_s` |
| PERF-G03 native certificate | p95 `certificate_native_s <= 5.0` oraz speedup mediany `>= 7.5x` względem Python reference |
| PERF-G04 duplicate work | jeden cold build wywołuje pełną rekalkulację certificate dokładnie raz; fast cache hit nie wywołuje jej ani razu |
| PERF-G05 memory | peak RSS `<= max(2 GiB, 1.10 * frozen_baseline_peak_rss)` |
| PERF-G06 serialization | `artifact_verify_and_deserialize_s <= 1.5` na warm path |
| PERF-G07 determinism | fingerprint, count fields i certificate digest identyczne dla Rayon `1, 2, 4, 8` oraz 10 powtórzeń każdego ustawienia |

Jeżeli sprzęt zarządzanego runnera zmieni się względem frozen baseline, wynik zachowuje bramkę bezwzględną i publikuje osobno znormalizowany speedup. Nie wolno zmieniać progów po zobaczeniu wyników w tym samym PR.

### 3.3 Bramki jakości i topologii

Każdy cold run i każdy kandydat repair przechodzi:

- rodziny komórek dokładnie `prism6` w magnet, `pyramid5` w transition i `tet4` w far air;
- `requested_layers == realized_layers == 1` i dokładnie dwa magnetic layer planes;
- zero missing interface faces;
- zero non-manifold faces;
- zero same-side two-owner tet faces;
- zero overlapping duplicate cells;
- zero fallback i zero `degraded`;
- wszystkie order-2 Jacobian samples dodatnie ponad kanonicznym progiem;
- relative volume error `<= 1e-8`;
- `tetra_decomposition_scaled_jacobian.v1` p05 per family `>= 0.1` i każde minimum `> 0`;
- `gmsh.min_sicn.v1` p05 `>= 0.1` i minimum `> 0`, jeżeli producer i pełne per-element samples spełniają kontrakt metryki;
- marker coverage, shared interface ownership i global ordinals zgodne;
- ten sam topology fingerprint v3 dla powtórzeń tej samej konfiguracji.

Metryki planowane przez ADR-0027, które nie są jeszcze zaimplementowane, pozostają `not_qualified`. Ten plan nie może fałszywie promować `cell.max_edge.v1`, `adjacent_size_growth.v1`, pełnych airbox bands ani FMMQ v2. Ich implementację prowadzi plan parasolowy `2026-08-27-fem-meshing-production-remediation.md`.

### 3.4 Warunki natychmiastowego rollbacku

- choć jeden non-manifold, overlapping, inverted albo missing-interface element;
- zmiana requested intent, rodzin elementów, markerów lub exact layers;
- warm cache akceptuje zmodyfikowany member, receipt, policy albo authoring document;
- wynik certificate zależy od liczby wątków;
- brak natywnego certifiera zostaje cicho potraktowany jako produkcyjny sukces;
- cache zastępuje lub kasuje jawny user path;
- managed CPU albo GPU wykonuje fallback urządzenia;
- wydajność poprawia się przez zmniejszenie jakości lub liczby elementów bez osobnej zaakceptowanej zmiany fizycznej.

---

## 4. Relacja do istniejących dokumentów

Ten dokument jest planem skupionym na regresji Netgen, kosztach certyfikacji i bezpiecznym cache. Nie zastępuje:

- `docs/superpowers/plans/2026-08-27-fem-meshing-production-remediation.md` — pełna polityka produkcyjna i findings `FM-MESH-*`;
- `docs/audits/2026-08-27-fem-mesh-pipeline-audit.md` — rejestr stanu całego pipeline;
- `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` — decyzja o kanonicznej polityce i FMMQ v2;
- `docs/adr/0021-native-mixed-p1-fem-topology.md` — dozwolona topologia mixed-P1;
- `docs/superpowers/specs/2026-07-30-mesh-persistence-and-interchange-design.md` — istniejący kontrakt persistence.

| Finding parasolowy | Pokrycie w tym planie |
|---|---|
| `FM-MESH-002` common quality gate | zachowanie obecnego bounded certificate i brak regresji; pełne rozszerzenie metryk pozostaje w planie parasolowym |
| `FM-MESH-005` production receipt | receipt certyfikacji i benchmark performance; pełny receipt CPU/GPU/browser pozostaje w planie parasolowym |
| `FM-MESH-009` FMMQ identity | binding artifact/certificate przygotowuje fundament; FMMQ v2 nie jest dublowany |
| `FM-MESH-010` execution cache | pełna implementacja cache dla shared-domain mixed |
| `FM-MESH-011` determinism | deterministyczny Rust/Rayon i macierz Gmsh threads |
| `FM-MESH-014` observability | dokładne fazy i numeric timings |
| `FM-MESH-016` prism semantics | brak zmiany topologii; osobne testy zachowania rodzin i warstw |

---

## 5. Kolejność realizacji

Zadania 0–7 są sekwencyjne, ponieważ każde zamyka kontrakt wymagany przez następne. Zadanie 8 jest warunkową optymalizacją extraction uruchamianą na podstawie profilu po Zadaniu 7. Zadania 9–11 są integracyjne i kwalifikacyjne.

Nie wolno rozpoczynać cache fast path przed ukończeniem Rust parity i receipt tamper tests. Nie wolno promować capability przed świeżym managed receipt.


---

## Zadanie 0: Zamrozić benchmark i schemat dowodu przed zmianą zachowania

**Status początkowy:** `CONFIRMED` dla pojedynczych pomiarów, `NOT VERIFIED` dla rozkładu p50/p95.

**Pliki:**

- Create: `scripts/benchmark_fem_mixed_mesh_pipeline.py`
- Create: `scripts/test_benchmark_fem_mixed_mesh_pipeline.py`
- Read-only scenario: `tests/standard_problems/mumag/sp4/fem/problem.py`
- Read-only generator: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- Read-only persistence: `packages/fullmag-py/src/fullmag/meshing/persistence.py`
- Read-only source identity: `scripts/capture_source_snapshot_identity.py`
- Runtime output, never commit: `.fullmag/reports/fem-mixed-mesh-performance/evidence.v2.json`

### Zadanie 0.1 Kontrakt harnessu

- [ ] Utwórz `BenchmarkConfig` jako frozen dataclass z polami:
  - `scenario: str`, wymagane `"sp4_mixed"`;
  - `cold_runs: int`;
  - `warm_runs: int`;
  - `native_audit_runs: int`;
  - `python_audit_runs: int`;
  - `warmup_runs: int`;
  - `artifact_dir: Path`;
  - `output: Path`;
  - `repair_method_override: str | None`, dostępne wyłącznie w trybie qualification;
  - `rayon_threads: Sequence[int]`;
  - `gmsh_threads: Sequence[int]`.
- [ ] Utwórz `PhaseTimings` z numeric binary64 seconds dla:
  - `authoring_resolve_s`;
  - `cache_lookup_s`;
  - `occ_build_s`;
  - `gmsh_generate_s`;
  - `gmsh_repair_s`;
  - `gmsh_extract_s`;
  - `orientation_s`;
  - `certificate_python_s`;
  - `certificate_native_s`;
  - `artifact_serialize_s`;
  - `artifact_hash_verify_s`;
  - `artifact_deserialize_s`;
  - `native_preflight_s`;
  - `total_s`.
- [ ] Utwórz `run_benchmark(config: BenchmarkConfig) -> dict[str, object]` i `validate_evidence_document(document: Mapping[str, object]) -> None`.
- [ ] Zapisuj czas przez `time.perf_counter_ns()`, a sekundy wyliczaj dopiero przy serializacji. Nie parsuj tekstowych heartbeatów.
- [ ] Zapisuj `peak_rss_bytes`. Na Linux użyj `resource.getrusage` i jawnie przelicz `ru_maxrss` z KiB; na Windows zapisz `null` i `memory_status="not_measured"`, dopóki nie istnieje repozytoryjny helper. Brak pomiaru nie może przejść gate'u release.
- [ ] Source identity pobierz przez `scripts/capture_source_snapshot_identity.py`; nie implementuj drugiego algorytmu Git/dirty hashing w benchmarku.
- [ ] Dokument evidence ma dokładnie:

```json
{
  "schema": "fullmag.fem-mixed-mesh-performance.v2",
  "generated_at": "RFC3339 UTC",
  "source_identity": {
    "schema": "fullmag.source-snapshot.v2",
    "head_commit_full": "40 lowercase hex",
    "head_tree_sha256": "64 lowercase hex",
    "git_status_porcelain_v1": [],
    "dirty_path_content": [],
    "source_snapshot_dirty": false,
    "dirty_content_sha256": "64 lowercase hex",
    "source_snapshot_sha256": "64 lowercase hex"
  },
  "environment": {
    "python_version": "string",
    "gmsh_version": "4.15.2",
    "certifier_algorithm": "string",
    "platform": "string",
    "cpu_model": "string",
    "logical_cpus": 1
  },
  "scenario": {
    "id": "sp4_mixed",
    "requested_layers": 1,
    "repair_method": "string",
    "gmsh_threads": 1,
    "rayon_threads": 1,
    "python_audit_runs": 3
  },
  "mesh": {
    "nodes": 28010,
    "cells": 132760,
    "facets": 33350,
    "topology_fingerprint_v3": "64 lowercase hex"
  },
  "quality": {
    "requested_layers": 1,
    "realized_layers": 1,
    "non_manifold_faces": 0,
    "same_side_two_owner_faces": 0,
    "relative_volume_error": 0.0,
    "scaled_jacobian_p05_by_family": {
      "prism6": 0.0,
      "pyramid5": 0.0,
      "tet4": 0.0
    }
  },
  "runs": [],
  "summary": {},
  "gate": {
    "status": "baseline_recorded",
    "failures": []
  }
}
```

Wartości liczbowe w przykładzie określają typy, nie oczekiwane wyniki. Validator wymaga dodatnich countów, skończonych czasów, pełnych rodzin i zgodnego fingerprintu pomiędzy warm runs.

### Zadanie 0.2 RED

- [ ] Napisz testy, zanim powstanie implementacja:
  - `test_rejects_missing_phase_timing`;
  - `test_rejects_non_finite_timing`;
  - `test_rejects_mixed_topology_fingerprint_across_warm_runs`;
  - `test_computes_linear_interpolated_p95`;
  - `test_does_not_delete_shared_cache`;
  - `test_cold_workspace_is_scoped_below_requested_artifact_dir`;
  - `test_baseline_mode_never_claims_release_pass`.
- [ ] Uruchom:

```bash
python3 -m unittest discover -s scripts -p 'test_benchmark_fem_mixed_mesh_pipeline.py' -v
```

**Oczekiwany RED:** import lub brak symboli `BenchmarkConfig` i `validate_evidence_document`.

### Zadanie 0.3 GREEN

- [ ] Zaimplementuj parser CLI:

```text
--scenario sp4_mixed
--mode baseline|qualification
--cold-runs INTEGER
--warm-runs INTEGER
--native-audit-runs INTEGER
--python-audit-runs INTEGER
--warmup-runs INTEGER
--artifact-dir ABSOLUTE_PATH
--output ABSOLUTE_PATH
--repair-method default|Relocate3D|Netgen
--rayon-threads CSV_INTEGERS
--gmsh-threads CSV_INTEGERS
```

- [ ] Wymuś, aby `--repair-method` inny niż produkcyjny był legalny tylko z `--mode qualification`.
- [ ] Cold workspace twórz przez `tempfile.TemporaryDirectory(dir=artifact_dir)`. Usuń wyłącznie ten katalog po zamknięciu runu.
- [ ] Nie dotykaj `_fem_mesh_cache_dir` w baseline. Pierwszy baseline mierzy jawne generowanie i jawny save/load.
- [ ] Dodaj deterministic JSON serialization: `sort_keys=True`, `allow_nan=False`, UTF-8, końcowy newline.
- [ ] Uruchom ponownie unit tests i oczekuj wszystkich `OK`.

### Zadanie 0.4 Zamrożenie baseline

- [ ] Po odzyskaniu storage uruchom najpierw managed preflight:

```bash
just ensure-managed-fem-runtime
```

**Oczekiwane:** zgodny manifest source identity i exit 0. `No space left on device` oznacza `BLOCKED_INFRASTRUCTURE`, nie wynik benchmarku.

- [ ] Uruchom baseline:

```bash
python3 scripts/benchmark_fem_mixed_mesh_pipeline.py --scenario sp4_mixed --mode baseline --cold-runs 5 --warm-runs 10 --native-audit-runs 0 --python-audit-runs 3 --warmup-runs 2 --artifact-dir /tmp/fullmag-fem-mixed-mesh-benchmark --output .fullmag/reports/fem-mixed-mesh-performance/baseline.v2.json --repair-method Relocate3D --rayon-threads 1 --gmsh-threads 1
```

- [ ] Sprawdź, że summary zawiera p50, p95, max i peak RSS dla każdej fazy.
- [ ] Zablokuj dalsze optymalizacje, jeżeli fingerprint lub jakość różnią się między pięcioma cold runs. To najpierw problem deterministyczności lub meshera.
- [ ] Commit sugerowany dopiero po osobnej zgodzie użytkownika:

```bash
git add scripts/benchmark_fem_mixed_mesh_pipeline.py scripts/test_benchmark_fem_mixed_mesh_pipeline.py
git commit -m "test: freeze mixed mesh performance baseline"
```



---

## Zadanie 1: Naprawić regresję Netgen i jawnie wersjonować repair policy

**Status początkowy:** `CONFIRMED`.

**Pliki:**

- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Modify: `packages/fullmag-py/tests/test_mixed_element_meshing.py`
- Create: `scripts/qualify_fem_mixed_repair_policy.py`
- Create: `scripts/test_qualify_fem_mixed_repair_policy.py`
- Use: `scripts/benchmark_fem_mixed_mesh_pipeline.py`

### Zadanie 1.1 Dokumentacja przed kodem

- [ ] W `0106` dodaj podsekcję `Mixed tetrahedral repair policy`. Zapisz:
  - repair działa po wygenerowaniu mixed shared-domain;
  - produkcyjny algorithm ID to `fullmag.mixed-tet-repair.v1`;
  - metoda to `Relocate3D`, `niter=1`;
  - `Netgen` jest odrzucony dla bounded mixed-P1 z powodu potwierdzonej utraty conformity w canonical SP4;
  - repair nie może zmieniać rodzin, exact layers, markerów ani shared-interface ownership;
  - każda zmiana metody lub iteracji wymaga nowego algorithm ID, macierzy N=10 i managed receipt;
  - Gmsh threads pozostają 1 do osobnej kwalifikacji.
- [ ] Nie przedstawiaj `Relocate3D` jako uniwersalnie najlepszego optymalizatora tetra. Jest to wybrana polityka dla bounded Fullmag mixed-P1 po przejściu kontraktu.
- [ ] Zaktualizuj source map o stabilne symbole `_STRICT_MIXED_TET_REPAIR_POLICY` i `_repair_mixed_tetrahedra`.
- [ ] Uruchom:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json --repo-root .
```

**Oczekiwane:** validator exit 0, wszystkie anchors i symbole istnieją po GREEN.

### Zadanie 1.2 RED dla regresji

- [ ] W `test_mixed_element_meshing.py` zastąp test oczekujący Netgen testami:
  - `test_mixed_tetrahedra_repair_uses_versioned_relocate3d_policy`;
  - `test_mixed_tetrahedra_repair_uses_one_iteration`;
  - `test_strict_mixed_generation_does_not_expose_public_optimizer_override`;
  - `test_mixed_repair_policy_id_changes_when_method_or_iterations_change`.
- [ ] Dodaj fixture certificate failure dla wyniku Netgen, która zawiera dokładnie:
  - dwa same-side two-owner `tet4/tet4` faces;
  - dwa non-manifold faces w `far_air`;
  - oczekiwane odrzucenie przez `MeshValidationError`.
- [ ] Fixture ma być minimalną ręcznie zdefiniowaną topologią, nie wielomegabajtowym artefaktem.
- [ ] Uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mixed_element_meshing.py' -v
```

**Oczekiwany RED:** bieżący kod wywołuje `gmsh.model.mesh.optimize("Netgen", niter=1)`.

### Zadanie 1.3 GREEN w generatorze

- [ ] Dodaj w `_gmsh_swept.py`:

```python
@dataclass(frozen=True)
class _MixedTetRepairPolicy:
    algorithm_id: str
    method: str
    iterations: int


_STRICT_MIXED_TET_REPAIR_POLICY = _MixedTetRepairPolicy(
    algorithm_id="fullmag.mixed-tet-repair.v1",
    method="Relocate3D",
    iterations=1,
)
```

- [ ] Zmień sygnaturę na:

```python
def _repair_mixed_tetrahedra(
    gmsh: Any,
    *,
    policy: _MixedTetRepairPolicy = _STRICT_MIXED_TET_REPAIR_POLICY,
) -> None:
```

- [ ] Waliduj prywatny policy: niepusty algorithm ID, metoda dokładnie z `{"", "Relocate3D", "Netgen"}` i `iterations >= 1`. Produkcyjny call site nigdy nie przekazuje override.
- [ ] Wywołaj `gmsh.model.mesh.optimize(policy.method, niter=policy.iterations)`.
- [ ] Nie zmieniaj innych Gmsh options ani kolejności generation/extraction.
- [ ] Uruchom focused tests i cały plik `test_meshing.py`.

### Zadanie 1.4 Rzeczywista macierz kandydatów

- [ ] `qualify_fem_mixed_repair_policy.py` uruchamia każdy wariant w osobnym procesie, aby nie przenosić stanu Gmsh:
  - default `method=""`, `niter=1`;
  - `Relocate3D`, `niter=1`;
  - `Netgen`, `niter=1` jako oczekiwany negatywny regression control.
- [ ] Każdy wariant wykonuje 10 cold runs canonical SP4 i zapisuje osobny evidence JSON.
- [ ] Kandydat jest legalny tylko, gdy przechodzi wszystkie bramki jakości z sekcji 3.3. Czas rozstrzyga dopiero pomiędzy legalnymi kandydatami.
- [ ] `Relocate3D` musi przejść N=10. `Netgen` musi zostać odrzucony przez conformity gate przynajmniej w odtwarzającym runie lub zachowanym minimalnym fixture.
- [ ] Uruchom:

```bash
python3 scripts/qualify_fem_mixed_repair_policy.py --scenario sp4_mixed --runs 10 --methods default,Relocate3D,Netgen --gmsh-threads 1 --output .fullmag/reports/fem-mixed-mesh-performance/repair-policy.v2.json
```

- [ ] Jeżeli `Relocate3D` nie przejdzie N=10, nie wracaj automatycznie do default. Ustaw status `BLOCKED_MESHER_QUALITY`, dołącz failing topology fingerprint i zatrzymaj plan przed Zadaniem 5.
- [ ] Commit sugerowany po zgodzie:

```bash
git add docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py packages/fullmag-py/tests/test_mixed_element_meshing.py scripts/qualify_fem_mixed_repair_policy.py scripts/test_qualify_fem_mixed_repair_policy.py
git commit -m "fix: restore conforming mixed mesh repair"
```

---

## Zadanie 2: Usunąć podwójną certyfikację podczas budowy MeshData

**Status początkowy:** `CONFIRMED`.

**Pliki:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- Modify: `packages/fullmag-py/tests/test_mixed_element_meshing.py`
- Create: `packages/fullmag-py/tests/test_mixed_certificate_execution_counts.py`

### Zadanie 2.1 Invariant bezpieczeństwa

Publiczne utworzenie `MeshData` z certificate oraz każdy load artefaktu nadal wykonują pełną walidację. Skrót może zostać użyty tylko przez wewnętrzny producer, który:

1. utworzył strukturalnie zwalidowany mesh bez certificate;
2. policzył evidence dla dokładnie tego obiektu;
3. związał evidence z topology fingerprint v3;
4. przeszedł `validate_mixed_layer_topology_certificate`;
5. dołącza ten sam immutable certificate bez drugiej rekalkulacji.

### Zadanie 2.2 RED

- [ ] Dodaj testy z `unittest.mock.patch` na `_recompute_mixed_certificate_evidence`:
  - `test_certificate_producer_recomputes_evidence_once`;
  - `test_public_meshdata_constructor_recomputes_certificate`;
  - `test_artifact_deserialize_recomputes_certificate_in_full_audit_mode`;
  - `test_prevalidated_attach_rejects_different_topology_fingerprint`;
  - `test_prevalidated_attach_rejects_mutated_certificate_payload`.
- [ ] W pierwszym teście uruchom `_attach_mixed_layer_topology_certificate` i oczekuj count `1`.
- [ ] Bieżący RED ma count `2` lub więcej, ponieważ nowy `MeshData` uruchamia `__post_init__`.

### Zadanie 2.3 GREEN: jawny wewnętrzny token

- [ ] Dodaj private frozen dataclass:

```python
@dataclass(frozen=True)
class _PrevalidatedMixedCertificate:
    topology_fingerprint_v3: str
    certificate_payload_sha256: str
    evidence: Mapping[str, object]
```

- [ ] Dodaj module-private sentinel `_PREVALIDATED_MIXED_CERTIFICATE_TOKEN = object()`.
- [ ] Rozszerz wewnętrzną ścieżkę construction przez classmethod:

```python
@classmethod
def _from_prevalidated_mixed_certificate(
    cls,
    *,
    mesh_without_certificate: "MeshData",
    certificate: MixedLayerTopologyCertificate,
    validation: _PrevalidatedMixedCertificate,
    token: object,
) -> "MeshData":
```

- [ ] Classmethod akceptuje wyłącznie identity sentinel, ponownie liczy tani SHA certificate payload i porównuje zapisany topology fingerprint z już policzonym fingerprintem bazowego meshu. Nie uruchamia drugi raz `_recompute_mixed_certificate_evidence`.
- [ ] Nie dodawaj publicznego boolean `skip_validation`.
- [ ] `MeshData.__post_init__` zachowuje obecne domyślne zachowanie. `_deserialize_mesh` nie przekazuje tokenu.
- [ ] W `_attach_mixed_layer_topology_certificate`:
  1. utwórz i orientuj mesh bez certificate;
  2. wykonaj `validate_strict`;
  3. policz evidence dokładnie raz;
  4. zbuduj certificate i jego deterministic payload digest;
  5. wykonaj pełną walidację względem tego samego evidence;
  6. dołącz przez private classmethod.
- [ ] Dodaj jeden helper `_certificate_payload_sha256` używany później przez persistence v2. JSON: `sort_keys=True`, `separators=(",", ":")`, `allow_nan=False`.

### Zadanie 2.4 Reuse workspace w Python reference

- [ ] Dodaj private `_MixedTopologyWorkspace` zawierający:
  - canonical faces per cell ordinal;
  - `face_owners`;
  - cell-family ordinals;
  - cell signed/absolute volumes;
  - precomputed pyramid base classification;
  - magnetic layer coordinates.
- [ ] Zmień `_mixed_mesh_conformity_counts` i `_mixed_same_side_two_owner_face_count` tak, aby przyjmowały ten sam workspace i nie wywoływały ponownie `_mixed_face_adjacency`.
- [ ] Zachowaj wrappery bez argumentu workspace dla compatibility testów, ale wewnętrzna rekalkulacja tworzy workspace raz.
- [ ] Wynik przed i po zmianie musi być identyczny dla wszystkich istniejących fixtures.

### Zadanie 2.5 Weryfikacja

- [ ] Uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mixed_certificate_execution_counts.py' -v
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_mixed_element_meshing.py -v
```

- [ ] Uruchom 3-run microbenchmark Python reference. Warunek: count pełnej rekalkulacji `1` i mediana certificate Python mniejsza od frozen baseline o co najmniej 25%. Brak 25% nie blokuje Rust work, ale zostaje zapisany jako `python_workspace_speedup_not_reached`.
- [ ] Commit sugerowany po zgodzie:

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py packages/fullmag-py/tests/test_mixed_element_meshing.py packages/fullmag-py/tests/test_mixed_certificate_execution_counts.py
git commit -m "perf: eliminate duplicate mixed mesh certification"
```

---

## Zadanie 3: Wydzielić deterministyczny certificate engine w fullmag-ir i dodać Rayon

**Status początkowy:** `PARTIALLY CONFIRMED` — algorytm Rust istnieje, ale jest prywatny, walidacyjny i nie ma jawnej bramki wielowątkowej.

**Pliki:**

- Modify: `crates/fullmag-ir/Cargo.toml`
- Modify: `crates/fullmag-ir/src/mesh_assets.rs`
- Create: `crates/fullmag-ir/src/mixed_certificate.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Create: `crates/fullmag-ir/tests/mixed_certificate_parallel.rs`
- Use fixtures: `crates/fullmag-ir/tests/fixtures`

### Zadanie 3.1 RED: publiczny kontrakt obliczeniowy

- [ ] Najpierw dodaj test importujący:

```rust
use fullmag_ir::{
    compute_mixed_certificate_evidence,
    validate_mixed_layer_topology_certificate_against_mesh,
    MixedCertificateEvidenceV1,
};
```

- [ ] Testy:
  - `computes_python_golden_evidence`;
  - `rejects_non_manifold_face`;
  - `rejects_same_side_two_owner_face`;
  - `rejects_inverted_order_two_jacobian_sample`;
  - `is_deterministic_for_one_two_four_and_eight_threads`;
  - `keeps_global_ordinal_order_after_parallel_collection`;
  - `percentile_uses_binary64_linear_interpolation`;
  - `fixed_order_volume_sum_is_thread_count_independent`.
- [ ] RED ma nie kompilować z powodu braku publicznego `compute_mixed_certificate_evidence`.

### Zadanie 3.2 Jedna implementacja kontraktu

- [ ] Przenieś istniejące prywatne struktury i `recompute_mixed_certificate_evidence` z `mesh_assets.rs` do `mixed_certificate.rs` bez zmiany equations, node ordering, topology codes, tolerancji ani failure messages.
- [ ] Wyeksportuj:

```rust
pub fn compute_mixed_certificate_evidence(
    mesh: &MeshIR,
) -> Result<MixedCertificateEvidenceV1, MeshValidationError>;

pub fn validate_mixed_layer_topology_certificate_against_mesh(
    mesh: &MeshIR,
    certificate: &MixedLayerTopologyCertificateV1IR,
) -> Result<(), MeshValidationError>;
```

- [ ] `MixedCertificateEvidenceV1` ma serializowalne pola odpowiadające jeden-do-jednego Python evidence. Nie wprowadzaj drugiego zestawu nazw metryk.
- [ ] `mesh_assets.rs` re-eksportuje lub wywołuje nowy moduł; nie pozostawiaj kopii algorytmu.
- [ ] Dodaj `rayon = "1.10"` do `crates/fullmag-ir/Cargo.toml`.

### Zadanie 3.3 Deterministyczny plan równoległości

- [ ] Równolegle licz per-cell records przez `par_iter().enumerate()`:
  - canonical ordinal;
  - topology family;
  - signed i absolute volume;
  - order-2 Jacobian samples;
  - tetra-decomposition scaled Jacobian samples;
  - canonical face records.
- [ ] Każdy worker zwraca immutable `CellEvidenceRecord`. Nie zapisuje do współdzielonego `HashMap` i nie wykonuje atomowych sum float.
- [ ] Po `collect` posortuj records po global ordinal. Integer counts można redukować po tej tablicy.
- [ ] Face records sortuj deterministycznie po:
  1. sorted global node IDs;
  2. cell global ordinal;
  3. local face ordinal;
  4. topology code.
- [ ] Grupowanie ownerów wykonuj po sortowaniu. Nie polegaj na iteration order `HashMap`.
- [ ] Volume sums wykonuj w global ordinal order przez jeden fixed-order compensated sum. Wynik ma być niezależny od liczby threads.
- [ ] Percentyle sortują binary64 przez `total_cmp` i stosują kanoniczną interpolację `(n-1)p`.
- [ ] Plane clustering sortuje współrzędne i używa istniejącej `tau_plane`. Nie równoleglij union/cluster w sposób zmieniający kolejność.
- [ ] Release build nie loguje per-cell records. Telemetry zawiera tylko counts, fazy i threads.

### Zadanie 3.4 Tolerancje i parity

- [ ] Integer counts, topology fingerprint i element order są exact-match.
- [ ] Dimensionless metryki certificate używają istniejącego limitu `max(1e-12 relative, 16 * f64::EPSILON)`.
- [ ] Wielkości wymiarowe używają `1e-12 relative + 1e-30 absolute`.
- [ ] Nie modyfikuj tolerancji, aby przejść parity. Jeżeli Python i Rust różnią się ponad limit, znajdź różnicę w ordering, topology map albo formule.
- [ ] Zachowaj Python jako czytelny oracle. Po kwalifikacji produkcja wybierze native, ale test cross-language pozostaje obowiązkowy.

### Zadanie 3.5 Weryfikacja Rust

- [ ] Uruchom:

```bash
cargo test -p fullmag-ir --test mixed_certificate_parallel -- --nocapture
cargo test -p fullmag-ir mesh_assets -- --nocapture
```

Te hostowe testy nie budują MFEM i są dopuszczalne jako unit contract. Oczekiwane: exit 0, brak ignored tests w nowym pliku.

- [ ] Uruchom `rustfmt --edition 2021 --check crates/fullmag-ir/src/mesh_assets.rs crates/fullmag-ir/src/mixed_certificate.rs crates/fullmag-ir/src/lib.rs`; nie formatuj całego brudnego worktree.
- [ ] Commit sugerowany po zgodzie:

```bash
git add crates/fullmag-ir/Cargo.toml crates/fullmag-ir/src/mesh_assets.rs crates/fullmag-ir/src/mixed_certificate.rs crates/fullmag-ir/src/lib.rs crates/fullmag-ir/tests/mixed_certificate_parallel.rs
git commit -m "perf: parallelize mixed mesh certificate evidence"
```


---

## Zadanie 4: Dodać typowany most PyO3 bez serializacji całej siatki do JSON

**Status początkowy:** `CONFIRMED` — obecny `validate_mesh_ir` serializuje `MeshIR` do JSON, a brak `_fullmag_core` cicho zwraca `None`.

**Pliki:**

- Modify: `Cargo.toml`
- Modify: `crates/fullmag-py-core/Cargo.toml`
- Modify: `crates/fullmag-py-core/src/lib.rs`
- Create: `crates/fullmag-py-core/src/mixed_certificate.rs`
- Modify: `packages/fullmag-py/src/fullmag/_core.py`
- Create: `packages/fullmag-py/tests/test_native_mixed_certificate.py`
- Modify: `scripts/export_fem_gpu_runtime.sh`

### Zadanie 4.1 RED: bridge contract

- [ ] Dodaj testy Python:
  - `test_native_certificate_matches_python_reference`;
  - `test_native_certificate_rejects_non_contiguous_or_wrong_dtype_input`;
  - `test_native_certificate_rejects_unknown_topology_code`;
  - `test_native_certificate_rejects_out_of_range_csr_offsets`;
  - `test_native_certificate_releases_gil_during_compute`;
  - `test_strict_production_mode_rejects_missing_native_extension`;
  - `test_development_reference_mode_reports_not_production_qualified`.
- [ ] RED ma wykazać brak `certify_mixed_mesh_arrays` w module `_fullmag_core`.
- [ ] W Rust dodaj unit tests dla konwersji CSR, zanim PyO3 function zostanie zarejestrowana.

### Zadanie 4.2 Typowany wire contract

- [ ] Dodaj `numpy = "0.29"` do workspace dependencies i `numpy.workspace = true` w `fullmag-py-core`. Wersja jest zgodna z bieżącym `pyo3 = "0.29"`.
- [ ] Duże dane przekazuj jako:
  - `node_ids: int64[N]`;
  - `node_coordinates: float64[N, 3]`;
  - `cell_global_ordinals: int64[C]`;
  - `cell_topology_codes: uint8[C]`;
  - `cell_region_ids: int64[C]`;
  - `cell_offsets: int64[C + 1]`;
  - `cell_connectivity: int64[cell_offsets[C]]`;
  - `facet_global_ordinals: int64[F]`;
  - `facet_topology_codes: uint8[F]`;
  - `facet_marker_ids: int64[F]`;
  - `facet_offsets: int64[F + 1]`;
  - `facet_connectivity: int64[facet_offsets[F]]`.
- [ ] Topology codes są jednym kontraktem:
  - `1 = tet4`;
  - `2 = prism6`;
  - `3 = pyramid5`;
  - `4 = hex8`;
  - `11 = tri3`;
  - `12 = quad4`.
- [ ] Dodaj jeden test, który porównuje te kody z canonical mapping w `MeshIR`. Nie duplikuj magicznych liczb w więcej niż jednym module Rust.
- [ ] Małe metadata, oczekiwany certificate i wynik mogą być JSON-em. Connectivity i coordinates nie mogą przechodzić przez listy Pythona ani pełny `MeshIR` JSON.

### Zadanie 4.3 Dokładna funkcja PyO3

- [ ] Zarejestruj:

```rust
#[pyfunction]
#[pyo3(signature = (
    node_ids,
    node_coordinates,
    cell_global_ordinals,
    cell_topology_codes,
    cell_region_ids,
    cell_offsets,
    cell_connectivity,
    facet_global_ordinals,
    facet_topology_codes,
    facet_marker_ids,
    facet_offsets,
    facet_connectivity,
    metadata_json,
    certificate_json=None
))]
fn certify_mixed_mesh_arrays(
    py: Python<'_>,
    node_ids: PyReadonlyArray1<'_, i64>,
    node_coordinates: PyReadonlyArray2<'_, f64>,
    cell_global_ordinals: PyReadonlyArray1<'_, i64>,
    cell_topology_codes: PyReadonlyArray1<'_, u8>,
    cell_region_ids: PyReadonlyArray1<'_, i64>,
    cell_offsets: PyReadonlyArray1<'_, i64>,
    cell_connectivity: PyReadonlyArray1<'_, i64>,
    facet_global_ordinals: PyReadonlyArray1<'_, i64>,
    facet_topology_codes: PyReadonlyArray1<'_, u8>,
    facet_marker_ids: PyReadonlyArray1<'_, i64>,
    facet_offsets: PyReadonlyArray1<'_, i64>,
    facet_connectivity: PyReadonlyArray1<'_, i64>,
    metadata_json: &str,
    certificate_json: Option<&str>,
) -> PyResult<String>;
```

- [ ] Pod GIL sprawdź dtype, C-contiguity, shapes, CSR offsets, ordinals i node references, a następnie wykonaj dokładnie jedną kopię do typowanych `Vec`.
- [ ] Zwolnij GIL na czas `compute_mixed_certificate_evidence` i walidacji przez `py.detach` lub aktualny odpowiednik PyO3 0.29.
- [ ] Nie używaj `unsafe` do utrzymywania widoku NumPy poza GIL.
- [ ] Wynik JSON ma schema `fullmag.mixed-certificate-native-result.v1` i pola:
  - `evidence`;
  - `topology_fingerprint_v3`;
  - `certificate_payload_sha256`;
  - `algorithm_id`;
  - `rayon_threads`;
  - `elapsed_ns`;
  - `validated_claimed_certificate`.
- [ ] Dodaj odrębny fast-preflight, który współdzieli parser typed arrays, ale nie buduje face adjacency ani quality samples:

```rust
#[pyfunction]
fn preflight_mixed_mesh_arrays(
    py: Python<'_>,
    node_ids: PyReadonlyArray1<'_, i64>,
    node_coordinates: PyReadonlyArray2<'_, f64>,
    cell_global_ordinals: PyReadonlyArray1<'_, i64>,
    cell_topology_codes: PyReadonlyArray1<'_, u8>,
    cell_region_ids: PyReadonlyArray1<'_, i64>,
    cell_offsets: PyReadonlyArray1<'_, i64>,
    cell_connectivity: PyReadonlyArray1<'_, i64>,
    facet_global_ordinals: PyReadonlyArray1<'_, i64>,
    facet_topology_codes: PyReadonlyArray1<'_, u8>,
    facet_marker_ids: PyReadonlyArray1<'_, i64>,
    facet_offsets: PyReadonlyArray1<'_, i64>,
    facet_connectivity: PyReadonlyArray1<'_, i64>,
    expected_json: &str,
) -> PyResult<String>;
```

- [ ] Preflight zwraca counts, topology fingerprint v3 i elapsed ns. Test `test_fast_preflight_does_not_build_face_adjacency` instrumentuje certificate engine i wymaga zera pełnych evidence calls.

### Zadanie 4.4 Adapter Python i failure semantics

- [ ] W `_core.py` dodaj:

```python
def certify_mixed_mesh_arrays(
    *,
    mesh: "MeshData",
    metadata: Mapping[str, object],
    certificate: Mapping[str, object] | None,
    require_native: bool,
) -> NativeMixedCertificateResult | None:

def preflight_mixed_mesh_arrays(
    *,
    mesh: "MeshData",
    expected: Mapping[str, object],
    require_native: bool,
) -> NativeMixedPreflightResult | None:
```

- [ ] Adapter konwertuje istniejące block arrays do CSR przez NumPy, bez `tolist()` dla connectivity i coordinates.
- [ ] `require_native=True` i brak extension kończy się `RuntimeError("native mixed mesh certifier is required")`.
- [ ] `require_native=False` może zwrócić `None`, lecz caller musi jawnie uruchomić Python reference i ustawić `production_qualified=False` oraz `certifier_backend="python_reference"`.
- [ ] Managed strict mixed zawsze przekazuje `require_native=True`. Nie używaj zmiennej środowiskowej, która cicho wybiera Python.

### Zadanie 4.5 Build i parity

- [ ] `scripts/export_fem_gpu_runtime.sh` już buduje `-p fullmag-py-core`. Dodaj test exportu sprawdzający symbol `certify_mixed_mesh_arrays` w zainstalowanym `_fullmag_core.so`; nie dodawaj drugiego procesu build.
- [ ] Uruchom source tests:

```bash
cargo test -p fullmag-py-core --lib -- --nocapture
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_native_mixed_certificate.py' -v
```

- [ ] Na canonical artifact porównaj Python i Rust exact fields oraz tolerowane floats. Zapisz p50/p95 dla Rayon 1, 2, 4, 8.
- [ ] Gate: Rust p95 `<= 5.0 s`, speedup mediany `>= 7.5x`, fingerprint i certificate digest niezależne od threads.
- [ ] Commit sugerowany po zgodzie:

```bash
git add Cargo.toml crates/fullmag-py-core/Cargo.toml crates/fullmag-py-core/src/lib.rs crates/fullmag-py-core/src/mixed_certificate.rs packages/fullmag-py/src/fullmag/_core.py packages/fullmag-py/tests/test_native_mixed_certificate.py scripts/export_fem_gpu_runtime.sh
git commit -m "feat: expose native mixed mesh certification"
```

---

## Zadanie 5: Wprowadzić artifact v2 i kryptograficznie związany receipt

**Status początkowy:** `PARTIALLY CONFIRMED` — v1 sprawdza SHA członków ZIP, ale przy każdym load ponownie certyfikuje i nie ma trust-tier binding.

**Pliki:**

- Modify: `docs/superpowers/specs/2026-07-30-mesh-persistence-and-interchange-design.md`
- Modify: `docs/adr/0021-native-mixed-p1-fem-topology.md`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json`
- Modify: `packages/fullmag-py/src/fullmag/meshing/persistence.py`
- Create: `packages/fullmag-py/src/fullmag/meshing/_certification_receipt.py`
- Modify: `packages/fullmag-py/tests/test_mesh_persistence.py`
- Create: `packages/fullmag-py/tests/test_mesh_artifact_trust.py`

### Zadanie 5.1 ADR i spec przed formatem

- [ ] Doprecyzuj ADR-0021:
  - `fullmag-ir` jest właścicielem language-neutral certificate computation i artifact validation;
  - `backends/fem` jest właścicielem final execution preflight, element import, basis, operators i MFEM execution;
  - ta granica nie tworzy drugiego solvera.
- [ ] W persistence spec dodaj schema v2, tryby zaufania z sekcji 2.2, migrację v1 i rollback do full audit.
- [ ] W `0106` dodaj provenance certifiera, repair algorithm i zasady fast path. Nie zmieniaj equations ani tolerancji.
- [ ] Uruchom source-map validator po zaimplementowaniu symboli.

### Zadanie 5.2 Receipt schema

- [ ] Zachowaj frozen legacy `CertificationReceiptV1` bez semantic-manifest
  binding i dodaj frozen `CertificationReceiptV2` z dokładnym JSON:

```json
{
  "schema": "fullmag.mesh-certification-receipt.v2",
  "artifact_schema": "fullmag.mesh-artifact.v2",
  "topology_member": {
    "name": "topology.npz",
    "bytes": 1,
    "sha256": "64 lowercase hex"
  },
  "build_report_member": {
    "name": "build-report.json",
    "bytes": 1,
    "sha256": "64 lowercase hex"
  },
  "topology_fingerprint_v3": "64 lowercase hex",
  "semantic_manifest_sha256": "64 lowercase hex",
  "certificate": {
    "schema": "fullmag.mixed-layer-topology-certificate.v1",
    "payload_sha256": "64 lowercase hex",
    "algorithm_id": "fullmag.mixed-certificate.rust-rayon.v1"
  },
  "authoring": {
    "document_sha256": "64 lowercase hex",
    "resolved_policy_sha256": "64 lowercase hex"
  },
  "producer": {
    "source_snapshot_sha256": "64 lowercase hex",
    "gmsh_version": "4.15.2",
    "repair_algorithm_id": "fullmag.mixed-tet-repair.v1",
    "repair_method": "Relocate3D",
    "repair_iterations": 1,
    "gmsh_threads": 1,
    "certifier_backend": "rust_rayon",
    "certifier_threads": 1
  },
  "mesh_counts": {
    "nodes": 1,
    "cells": 1,
    "facets": 1
  }
}
```

- [ ] Receipt v2 nie zawiera timestampu w semantic payload, aby dwa identyczne buildy mogły mieć identyczny digest.
- [ ] `semantic_manifest_sha256` wiąże kanoniczną projekcję
  `region_markers`, `object_region_markers` i `boundary_map`; nie obejmuje
  timestampu, provenance ani member descriptors.
- [ ] `manifest.json` v2 zawiera SHA i bytes dla `topology.npz`, `build-report.json` oraz `certification-receipt.json`.
- [ ] Nie twórz cyklu digestów: receipt wiąże topology i build report; manifest wiąże receipt.
- [ ] Artifact v2 z legacy receipt v1 przechodzi wyłącznie public full audit i
  jest zawsze odrzucany przez trusted fast; nie wprowadzaj artifact v3.

### Zadanie 5.3 RED: tamper matrix

- [ ] Dodaj testy modyfikujące osobno:
  - jeden byte `topology.npz`;
  - connectivity przy ponownie policzonym ZIP CRC, ale bez zmiany receipt;
  - certificate payload;
  - authoring document hash;
  - resolved policy hash;
  - Gmsh version;
  - repair method;
  - certifier algorithm;
  - mesh counts;
  - build report;
  - receipt digest w manifest;
  - member length;
  - topology fingerprint.
  - `region_markers[].geometry_name`, `object_region_markers` i zamianę znaczeń
    w `boundary_map` przy zachowaniu tego samego zbioru markerów.
- [ ] Każda mutacja musi zakończyć się fail-closed w fast i full mode.
- [ ] Dodaj `test_v1_is_never_loaded_through_trusted_fast_path` i `test_unknown_future_schema_is_rejected`.

### Zadanie 5.4 Dwie rozłączne funkcje load

- [ ] Publiczna funkcja zachowuje pełny audit:

```python
def load_mesh_artifact(path: PathLike[str] | str) -> MeshData:
```

- [ ] Dodaj wyłącznie wewnętrzną funkcję:

```python
def _load_trusted_cached_mesh_artifact(
    path: Path,
    *,
    expected_authoring_sha256: str,
    expected_policy_sha256: str,
    expected_source_snapshot_sha256: str,
    expected_gmsh_version: str,
    expected_repair_algorithm_id: str,
    expected_certifier_algorithm_id: str,
) -> MeshData:
```

- [ ] Public API nie przyjmuje `skip_validation` ani `trusted=True`.
- [ ] Full audit:
  1. weryfikuje manifest members;
  2. deserializuje struktury;
  3. uruchamia native certificate, gdy extension jest dostępne;
  4. poza managed runtime używa pełnego Python reference wyłącznie przy braku extension i zapisuje `production_qualified=False`;
  5. uruchamia marker/IR validation;
  6. porównuje cały receipt.
- [ ] Managed strict oraz forced release audit wymagają native extension i nie mogą użyć Python fallback.
- [ ] Trusted fast:
  1. weryfikuje ZIP member names, bytes i SHA;
  2. weryfikuje wszystkie expected bindings;
  3. weryfikuje certificate payload SHA i topology fingerprint;
  4. uruchamia `preflight_mixed_mesh_arrays` bez budowania face adjacency;
  5. używa private prevalidated construction z Zadania 2.
- [ ] Jeżeli native preflight jest niedostępny, internal cache raportuje `bypassed_native_unavailable` i przechodzi do publicznego full audit; nie wykonuje fast trust.
- [ ] Structural preflight sprawdza shapes, finite coordinates, CSR offsets, node references, unique global ordinals, family arity, counts i certificate presence. Nie zastępuje pełnego audytu dla obcych plików.

### Zadanie 5.5 Kompatybilność

- [ ] Save domyślnie zapisuje v2.
- [ ] Load v1 działa wyłącznie przez full audit.
- [ ] Jawny user path nie jest automatycznie nadpisywany v2. Po udanym full audicie wyłącznie orchestration posiadające dokładny bieżący authoring, policy i source snapshot może skopiować logicznie ten sam mesh do wewnętrznego cache v2; źródłowy plik pozostaje bez zmian.
- [ ] Uszkodzony cache entry zostaje zignorowany i przebudowany pod lockiem, ale plik usera powoduje jawny błąd.
- [ ] Uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mesh_persistence.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mesh_artifact_trust.py' -v
```

- [ ] Commit sugerowany po zgodzie:

```bash
git add docs/superpowers/specs/2026-07-30-mesh-persistence-and-interchange-design.md docs/adr/0021-native-mixed-p1-fem-topology.md docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json packages/fullmag-py/src/fullmag/meshing/persistence.py packages/fullmag-py/src/fullmag/meshing/_certification_receipt.py packages/fullmag-py/tests/test_mesh_persistence.py packages/fullmag-py/tests/test_mesh_artifact_trust.py
git commit -m "feat: bind mixed mesh certification receipts"
```

---

## Zadanie 6: Dodać atomowy content-addressed cache dla shared-domain mixed mesh

**Status początkowy:** `CONFIRMED` — istniejący cache obejmuje per-geometry meshes, a `study_universe` generuje shared-domain ponownie.

**Pliki:**

- Modify: `packages/fullmag-py/pyproject.toml`
- Modify: `packages/fullmag-py/uv.lock`
- Create: `packages/fullmag-py/src/fullmag/meshing/_artifact_cache.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Create: `packages/fullmag-py/tests/test_shared_domain_mesh_cache.py`
- Modify: `packages/fullmag-py/tests/test_api.py`

### Zadanie 6.1 RED i kontrakt cache key

- [ ] Przed utworzeniem `_artifact_cache.py` napisz testy wymienione w sekcji 6.4 i uruchom je. Oczekiwany RED: brak modułu `fullmag.meshing._artifact_cache`, brak `load_or_build_shared_domain_mesh` i brak cache hit report.
- [ ] Dopiero po potwierdzeniu RED zbuduj canonical JSON przez `sort_keys=True`, compact separators i `allow_nan=False`.
- [ ] Key document ma schema `fullmag.shared-domain-mesh-cache-key.v1` i zawiera:
  - pełny `_current_mesh_authoring_document()`;
  - content SHA każdego importowanego geometry file;
  - normalized resolved mesh policy;
  - Gmsh version;
  - repair algorithm ID, method i iterations;
  - Gmsh threads;
  - certifier algorithm ID;
  - artifact schema;
  - topology fingerprint algorithm ID;
  - kanoniczny `source_snapshot_sha256` z `fullmag.source-snapshot.v2`.
- [ ] Cache key to lowercase SHA-256 canonical JSON.
- [ ] Nie używaj mtime, absolutnej ścieżki imported geometry ani losowego session ID jako semantycznej części key. Ścieżka może być diagnostyką poza hash.
- [ ] Ścieżka:

```text
<existing-fem-mesh-cache-dir>/shared-domain-v2/<first-two-hex>/<full-key>.fullmag-mesh
```

### Zadanie 6.2 Lock i atomic publish

- [ ] Dodaj `filelock>=3.16,<4` do `packages/fullmag-py/pyproject.toml` i odśwież `uv.lock` przez repozytoryjny workflow.
- [ ] Lock path to `<full-key>.lock` w tym samym shardzie. Lock timeout ma jawny default 600 s i raportuje owner path oraz waited time.
- [ ] Po uzyskaniu locka zawsze wykonaj drugi lookup; inny proces mógł już opublikować entry.
- [ ] Buduj do unikalnego pliku `.<full-key>.<pid>.<random>.tmp` w tym samym filesystemie.
- [ ] Po save:
  1. otwórz tmp przez full audit;
  2. `fsync` plik;
  3. `os.replace(tmp, final)`;
  4. `fsync` katalog na platformach, które to wspierają;
  5. otwórz final przez trusted fast path.
- [ ] W `finally` usuń wyłącznie tmp utworzony przez bieżący proces. Nie kasuj final, lock innego procesu ani całego cache dir.
- [ ] Nie implementuj eviction w tym zadaniu. Retencja jest osobną decyzją ze zgodą użytkownika.

### Zadanie 6.3 Orchestration

- [ ] Dodaj:

```python
def load_or_build_shared_domain_mesh(
    *,
    authoring_document: Mapping[str, object],
    resolved_policy: Mapping[str, object],
    source_snapshot_sha256: str,
    build: Callable[[], MeshData],
    cache_dir: Path,
) -> tuple[MeshData, SharedDomainMeshCacheReport]:
```

- [ ] `SharedDomainMeshCacheReport` ma:
  - `key`;
  - `status: hit | miss_built | miss_waited_then_hit | corrupt_rebuilt | bypassed`;
  - `lookup_elapsed_ns`;
  - `wait_elapsed_ns`;
  - `build_elapsed_ns`;
  - `load_elapsed_ns`;
  - `artifact_path`;
  - `validation_mode`.
- [ ] W `build_geometry_assets_for_request` otocz wyłącznie shared-domain `study_universe`. Nie zmieniaj semantyki explicit `StudyMeshHandle.save/load/save_or_load`.
- [ ] Cache jest włączony domyślnie dla auto-generated shared-domain. Jawny diagnostyczny bypass może istnieć wyłącznie jako CLI/runtime option zapisany w provenance, nie jako różnica fizycznego authoringu.
- [ ] Jeżeli caller nie dostarcza zweryfikowanego `source_snapshot_sha256`, ustaw `cache_status="bypassed_source_identity_unavailable"` i buduj bez publikacji cache; nie twórz słabszego key.

### Zadanie 6.4 GREEN, concurrency i invalidation

- [ ] Testy:
  - pierwszy call buduje raz i publikuje v2;
  - drugi call nie wywołuje Gmsh buildera;
  - dwa procesy dla tego samego key wywołują builder dokładnie raz;
  - różny geometry content zmienia key;
  - różny resolved policy zmienia key;
  - różny Gmsh/repair/certifier/artifact algorithm zmienia key;
  - różny `source_snapshot_sha256` zmienia key; konserwatywnie obejmuje to także dirty zmiany poza mesherem;
  - corrupted internal entry jest rebuilt;
  - corrupted explicit user artifact jest błędem;
  - exception buildera nie publikuje final entry;
  - cache hit zachowuje dokładny topology fingerprint i certificate digest.
- [ ] Uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_shared_domain_mesh_cache.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_api.py' -v
```

- [ ] Warm microbenchmark musi wykazać zero calli do Gmsh i zero pełnych certificate recomputations.
- [ ] Commit sugerowany po zgodzie:

```bash
git add packages/fullmag-py/pyproject.toml packages/fullmag-py/uv.lock packages/fullmag-py/src/fullmag/meshing/_artifact_cache.py packages/fullmag-py/src/fullmag/model/problem.py packages/fullmag-py/src/fullmag/world.py packages/fullmag-py/tests/test_shared_domain_mesh_cache.py packages/fullmag-py/tests/test_api.py
git commit -m "feat: cache certified shared-domain meshes"
```

---

## Zadanie 7: Dodać mierzalne fazy pipeline i provenance wydajności

**Status początkowy:** `PARTIALLY CONFIRMED` — heartbeat publikuje tekstowy elapsed, ale build report nie ma pełnych numeric timings.

**Pliki:**

- Modify: `packages/fullmag-py/src/fullmag/_progress.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/persistence.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Create: `packages/fullmag-py/tests/test_mesh_pipeline_timings.py`

### Zadanie 7.1 RED

- [ ] Przed dodaniem timingów utwórz fake clock i testy z sekcji 7.3. Uruchom je i potwierdź RED z powodu braku `MeshPipelineTimings` oraz pól report.
- [ ] Nie zmieniaj heartbeatów ani build report przed tym RED.

### Zadanie 7.2 GREEN: kontrakt timingów

- [ ] Dodaj frozen `MeshPipelineTimings` z polami `int | None` w nanosekundach:
  - `authoring_resolve_ns`;
  - `cache_lookup_ns`;
  - `cache_wait_ns`;
  - `occ_build_ns`;
  - `gmsh_generate_ns`;
  - `gmsh_repair_ns`;
  - `gmsh_extract_ns`;
  - `orientation_ns`;
  - `strict_validation_ns`;
  - `certificate_native_ns`;
  - `certificate_python_ns`;
  - `artifact_serialize_ns`;
  - `artifact_write_ns`;
  - `artifact_hash_verify_ns`;
  - `artifact_deserialize_ns`;
  - `native_preflight_ns`;
  - `total_ns`.
- [ ] Każde pole jest non-negative albo `None`; `total_ns` musi być nie mniejsze niż najdłuższa zawarta faza.
- [ ] Dodaj do `SharedDomainBuildReport`:
  - `timings`;
  - `cache_status`;
  - `cache_key`;
  - `gmsh_version`;
  - `gmsh_threads`;
  - `repair_algorithm_id`;
  - `repair_method`;
  - `certifier_algorithm_id`;
  - `certifier_backend`;
  - `certifier_threads`;
  - `production_qualified`.

### Zadanie 7.3 Instrumentacja

- [ ] Użyj jednego helpera context manager opartego na `perf_counter_ns`. Faza zapisuje wynik także po exception i oznacza `status="failed"`.
- [ ] Gmsh generation i repair muszą być osobnymi fazami.
- [ ] Extraction kończy się po utworzeniu typed NumPy arrays, przed orientation/certificate.
- [ ] Full audit i fast load mają osobne timing fields; brak fazy zapisuje `None`, nie zero.
- [ ] Heartbeat pozostaje częsty podczas Gmsh/extraction/certificate, ale nie wymyśla ETA. Event zawiera numeric `elapsed_ns` i `phase_id`.
- [ ] Nie emituj per-cell progress z Rayon. To zwiększa contention.

### Zadanie 7.4 Weryfikacja

- [ ] Dodaj fake clock i testy:
  - dokładne przypisanie każdej fazy;
  - brak podwójnego doliczania nested scopes;
  - failed phase zachowuje elapsed i error status;
  - cache hit nie ma Gmsh timings;
  - cache miss ma build timings;
  - JSON round-trip zachowuje integer nanoseconds;
  - stary build report bez timings nadal się czyta jako `None`.
- [ ] Uruchom:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mesh_pipeline_timings.py' -v
```

- [ ] Zaktualizuj benchmark z Zadania 0, aby konsumował te pola, zamiast własnych wrapperów tam, gdzie report jest dostępny.
- [ ] Commit sugerowany po zgodzie:

```bash
git add packages/fullmag-py/src/fullmag/_progress.py packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py packages/fullmag-py/src/fullmag/meshing/persistence.py packages/fullmag-py/src/fullmag/model/problem.py packages/fullmag-py/tests/test_mesh_pipeline_timings.py
git commit -m "feat: report mixed mesh pipeline timings"
```


---

## Zadanie 8: Optymalizować extraction tylko wtedy, gdy świeży profil tego wymaga

**Status początkowy:** `NOT VERIFIED` dla udziału extraction w aktualnym 334 s cold run.

**Pliki:**

Poniższe pliki są modyfikowane wyłącznie wtedy, gdy decision gate w sekcji Zadanie 8.1 wybierze optymalizację extraction.

- Modify only if gate selects work: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- Modify only if gate selects work: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Modify only if gate selects work: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Create only if gate selects work: `packages/fullmag-py/tests/test_gmsh_mixed_extraction_performance.py`
- Use: `scripts/benchmark_fem_mixed_mesh_pipeline.py`

### Zadanie 8.1 Obowiązkowy decision gate

- [ ] Po Zadaniu 7 wykonaj 5 cold runs i oblicz:

```text
extraction_share = (gmsh_extract_ns + orientation_ns) / total_ns
```

- [ ] Jeżeli `extraction_share <= 0.10` i PERF-G02 już przechodzi, nie zmieniaj extraction code. Zapisz w evidence:

```json
{
  "decision": "optimization_not_required",
  "reason": "extraction_share_at_or_below_10_percent_and_cold_gate_passed"
}
```

- [ ] Jeżeli `extraction_share > 0.10` albo PERF-G02 nie przechodzi, wykonaj kroki 8.2–8.4.
- [ ] Nie optymalizuj na podstawie line profiler uruchomionego na innym topology family albo bez airboxa.

### Zadanie 8.2 RED dla bulk extraction

- [ ] Zamroź exact arrays przed zmianą:
  - node tags i coordinates;
  - cell global ordinals;
  - family block order;
  - connectivity;
  - region IDs;
  - facet ordinals, connectivity i markers;
  - topology fingerprint;
  - mixed certificate.
- [ ] Test porównuje byte-identical integer arrays i tolerance-exact coordinates.
- [ ] Dodaj instrumentation counter dla liczby wywołań:
  - `gmsh.model.mesh.getNodes`;
  - `gmsh.model.mesh.getElements`;
  - `gmsh.model.mesh.getElementsByType`.
- [ ] RED ustala bieżący call count oraz bieżące p50 extraction.

### Zadanie 8.3 GREEN

- [ ] W `_extract_airbox_mesh_data` pobierz `getNodes()` raz i zbuduj dense node-tag lookup wektorowo:
  - jeżeli tags są zwarte, użyj tablicy indeksów;
  - jeżeli zakres tags przekracza `4 * N`, użyj sort/search przez `np.argsort` i `np.searchsorted`;
  - nie wykonuj Python dictionary lookup per node.
- [ ] Pobierz element blocks per dimension/required entity możliwie jednym wywołaniem, a następnie filtruj przez NumPy. Nie wołaj `getElements` ponownie tylko po tags potrzebne certificate ordering.
- [ ] W `_gmsh_cell_parts_in_extraction_order` przyjmij już pobrane blocks. Nie pobieraj ponownie elementów.
- [ ] Connectivity reshape wykonuj przez znaną arity family, bez Python loop per element.
- [ ] Zbuduj CSR dla PyO3 bez pośrednich nested lists.
- [ ] Preserve `prism6 -> pyramid5 -> tet4` canonical ordering i global ordinals. Nie sortuj po Gmsh entity tag, jeżeli zmienia to obecny kontrakt.
- [ ] Użyj tej samej bulk ścieżki w `_extract_swept_mesh_data` tylko wtedy, gdy jego testy pokazują identyczny contract. Nie refaktoruj niezwiązanego regular tet path.

### Zadanie 8.4 Gate

- [ ] Uruchom exact-array tests i cały `test_mixed_element_meshing.py`.
- [ ] Wykonaj 10 extraction-only measurements na zamrożonym Gmsh modelu w jednym procesie oraz 5 pełnych cold runs w osobnych procesach.
- [ ] Akceptuj zmianę tylko, gdy:
  - extraction p95 poprawia się o co najmniej 30%;
  - total cold median poprawia się o co najmniej 5%;
  - peak RSS nie wzrasta o więcej niż 10%;
  - fingerprint, ordinals, markers i certificate są zgodne.
- [ ] Jeżeli total gain jest mniejszy niż 5%, wycofaj extraction diff i zachowaj evidence `local_speedup_not_end_to_end_significant`.
- [ ] Commit sugerowany wyłącznie, gdy gate przechodzi:

```bash
git add packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py packages/fullmag-py/tests/test_gmsh_mixed_extraction_performance.py
git commit -m "perf: vectorize mixed mesh extraction"
```

---

## Zadanie 9: Zakwalifikować stałą liczbę wątków Gmsh bez utraty determinizmu

**Status początkowy:** `NOT VERIFIED`. Produkcyjny baseline pozostaje `gmsh_threads=1`.

**Pliki:**

- Modify: `scripts/qualify_fem_mixed_repair_policy.py`
- Modify: `scripts/test_qualify_fem_mixed_repair_policy.py`
- Modify only after passing gate: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- Modify only after passing gate: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Modify only after passing gate: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json`

### Zadanie 9.1 RED

- [ ] Najpierw dodaj testy decyzji: `test_rejects_nondeterministic_thread_candidate`, `test_rejects_quality_regression_even_when_faster`, `test_keeps_one_thread_below_twenty_percent_gain`, `test_selects_fixed_fastest_qualified_thread_count` i `test_thread_count_changes_cache_key`.
- [ ] Uruchom `python3 -m unittest discover -s scripts -p 'test_qualify_fem_mixed_repair_policy.py' -v`. Oczekiwany RED: brak thread-matrix decision engine.

### Zadanie 9.2 Macierz

- [ ] Dla produkcyjnego `Relocate3D` uruchom `gmsh_threads in {1, 2, 4, 8}`.
- [ ] Każda konfiguracja wykonuje 10 cold runs w osobnych procesach.
- [ ] Dla każdej konfiguracji wymagaj:
  - identycznego fingerprintu pomiędzy jej 10 powtórzeniami;
  - identycznych exact layers, family/region/facet counts i marker coverage;
  - wszystkich bramek jakości z sekcji 3.3;
  - braku fallbacku;
  - peak RSS w limicie.
- [ ] Fingerprint nie musi być taki sam pomiędzy różnymi stałymi thread counts, ale różnica jest odrębnym resolved execution i musi zmieniać cache key.
- [ ] Dynamiczne `threads=os.cpu_count()` jest zabronione, ponieważ zmieniałoby realizację między hostami.

### Zadanie 9.3 GREEN i decyzja

- [ ] Pozostaw 1 thread, jeżeli żaden kandydat nie daje jednocześnie:
  - co najmniej 20% poprawy p95 `gmsh_generate_s + gmsh_repair_s`;
  - deterministyczności N=10;
  - pełnej jakości;
  - nie większego peak RSS niż `1.25x` wariantu 1-thread.
- [ ] Jeżeli kandydat przejdzie, wybierz najszybszą stałą liczbę z najmniejszym peak RSS przy różnicy czasu mniejszej niż 5%.
- [ ] Zmień algorithm ID generatora/repair, cache key i dokumentację. Nie zmieniaj samego `fullmag.mixed-tet-repair.v1` bez nowej wersji.
- [ ] Ponów pełną macierz repair policy po zmianie threads.
- [ ] Uruchom:

```bash
python3 scripts/qualify_fem_mixed_repair_policy.py --scenario sp4_mixed --runs 10 --methods Relocate3D --gmsh-threads 1,2,4,8 --output .fullmag/reports/fem-mixed-mesh-performance/gmsh-thread-matrix.v2.json
```

- [ ] Wynik `keep_single_thread` jest pełnoprawnym sukcesem tego zadania, jeżeli kryteria dla większej liczby wątków nie przechodzą. Nie nazywaj go brakiem optymalizacji.

---

## Zadanie 10: Dodać bramkę wydajności i wykonać pełną kwalifikację managed

**Status początkowy:** `BLOCKED_INFRASTRUCTURE` do czasu odzyskania storage.

**Pliki:**

- Modify: `justfile`
- Modify: `scripts/benchmark_fem_mixed_mesh_pipeline.py`
- Modify: `scripts/test_benchmark_fem_mixed_mesh_pipeline.py`
- Modify: `scripts/run_fem_sp4_mixed_matrix.py`
- Modify: `scripts/verify_fem_mixed_prism_airbox_runtime.py`
- Runtime output, never commit: `.fullmag/reports/fem-mixed-mesh-performance/evidence.v2.json`

### Zadanie 10.1 Storage i source identity preflight

- [ ] Przed rebuildem sprawdź świeżo:
  - filesystem i wolne bytes dla `/zfn2/mateuszz/git/fullmag/build-volumes`;
  - mount `/mnt/fullmag-zfn2-native`;
  - aktywne buildy i kontenery;
  - managed runtime manifest;
  - source snapshot.
- [ ] Oblicz `required_free_bytes = ceil(1.25 * (release_target_bytes + runtime_bundle_bytes + validation_unpack_bytes))` z ostatniego kompletnego wariantu i bieżącego read-only inventory. Jeżeli któregoś składnika nie da się zmierzyć, preflight ma zwrócić `BLOCKED_STORAGE_CAPACITY_UNKNOWN`, a nie zgadywać stały próg.
- [ ] Brak miejsca raportuje `BLOCKED_INFRASTRUCTURE_STORAGE` i kończy się przed buildem.
- [ ] Ten plan nie autoryzuje kasowania. Odzyskanie miejsca jest osobnym, jawnie zatwierdzonym działaniem po inventory i active-process check.
- [ ] Naprawa bitu executable jest legalna tylko, gdy `git ls-files -s scripts/export_fem_gpu_runtime.sh` potwierdza mode `100755`, a checkout ma inny bit. Nie zmieniaj zawartości skryptu pod pretekstem mode repair.

### Zadanie 10.2 RED

- [ ] Dodaj testy: `test_performance_gate_rejects_warm_p95`, `test_performance_gate_rejects_quality_failure`, `test_performance_gate_rejects_source_mismatch`, `test_smoke_never_promotes_release` i `test_storage_blocker_is_not_algorithm_failure`.
- [ ] Uruchom `python3 -m unittest discover -s scripts -p 'test_benchmark_fem_mixed_mesh_pipeline.py' -v` i potwierdź RED dla brakującego qualification gate.
- [ ] Uruchom `just --dry-run verify-fem-mixed-mesh-performance` i potwierdź RED, że recepta jeszcze nie istnieje.

### Zadanie 10.3 GREEN: nowa recepta

- [ ] Dodaj `verify-fem-mixed-mesh-performance` do `justfile`. Recepta:
  1. wywołuje `just ensure-managed-fem-runtime`;
  2. sprawdza source identity manifestu;
  3. uruchamia benchmark qualification;
  4. waliduje evidence schema;
  5. odrzuca każdą bramkę PERF-G01..G07 i quality gate;
  6. zapisuje status `passed` tylko po wszystkich krokach.
- [ ] Domyślna recepta używa 5 cold, 10 warm, 10 native audit, 3 Python audit oraz dwóch warm-upów.
- [ ] Smoke może użyć 1 cold, 2 warm i 1 native audit, ale zapisuje `qualification_level="smoke"` i nigdy nie promuje release.
- [ ] Nie dodawaj synthetic sleep ani mock meshu do recepty produkcyjnej.

### Zadanie 10.4 Sekwencja managed

- [ ] Po przywróceniu storage:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-fem-mixed-p1-native-contract
just verify-fem-mesh-runner-abi-contract
just verify-fem-mixed-prism-airbox-runtime
just verify-fem-sp4-mixed-matrix
just verify-fem-meshing-production
just verify-fem-mixed-mesh-performance
```

- [ ] `verify-fem-mixed-prism-airbox-runtime` musi przejść CPU i GPU bez silent fallbacku.
- [ ] `verify-fem-sp4-mixed-matrix` zachowuje double precision i porównuje topologię, energie oraz składowe magnetyzacji zgodnie z istniejącym kontraktem.
- [ ] Performance evidence i runtime evidence wiążą ten sam:
  - source identity;
  - topology fingerprint;
  - certificate payload digest;
  - artifact schema;
  - Gmsh/repair/certifier versions.
- [ ] Żaden skipped GPU test nie jest `passed`.

### Zadanie 10.5 Werdykt gate

- [ ] `passed` wymaga wszystkich PERF-G01..G07 oraz jakości.
- [ ] `performance_failed` zachowuje ważny mesh, ale blokuje promocję optymalizacji.
- [ ] `quality_failed` blokuje solver i wymaga rollbacku.
- [ ] `infrastructure_blocked` nie zmienia statusu algorytmu na fail ani pass.
- [ ] `source_identity_mismatch` wymaga rebuilda; nie wolno użyć starszego runtime.
- [ ] Commit sugerowany po zgodzie:

```bash
git add justfile scripts/benchmark_fem_mixed_mesh_pipeline.py scripts/test_benchmark_fem_mixed_mesh_pipeline.py scripts/run_fem_sp4_mixed_matrix.py scripts/verify_fem_mixed_prism_airbox_runtime.py
git commit -m "test: gate mixed mesh performance in managed runtime"
```

---

## Zadanie 11: Domknąć dokumentację, compatibility i rollout

**Status początkowy:** `NOT VERIFIED`.

**Pliki:**

- Modify: `docs/audits/2026-08-27-fem-mesh-pipeline-audit.md`
- Modify: `docs/superpowers/plans/2026-08-27-fem-meshing-production-remediation.md`
- Modify: `docs/physics/0105-fem-meshing-production-acceptance.md`
- Modify: `docs/physics/0105-fem-meshing-production-acceptance.source-map.json`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- Modify: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json`
- Modify if architecture wording changed: `docs/adr/0021-native-mixed-p1-fem-topology.md`
- Modify if cache/provenance decision changed: `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`

### Zadanie 11.1 Aktualizacja statusów bez overclaim

- [ ] `FM-MESH-010` można oznaczyć `CONFIRMED` dopiero po concurrency, invalidation i warm gate.
- [ ] `FM-MESH-011` można oznaczyć `CONFIRMED` dla Rust/Rayon po thread matrix; Gmsh ma osobny status.
- [ ] `FM-MESH-014` można oznaczyć `CONFIRMED` dla numeric timings po round-trip build report.
- [ ] `FM-MESH-005` pozostaje częściowe, dopóki pełny managed CPU/GPU/browser receipt z planu parasolowego nie przejdzie.
- [ ] `FM-MESH-009` pozostaje częściowe, dopóki FMMQ v2 z ADR-0027 nie jest wdrożone.
- [ ] Nie zmieniaj statusów capability CPU/GPU na podstawie hostowych testów.

### Zadanie 11.2 Dokumentacja operacyjna

- [ ] Opisz:
  - różnicę cold build, full audit i trusted cache hit;
  - dlaczego certyfikacja pozostaje wymagana;
  - dlaczego SHA binding nie jest podpisem;
  - jak wymusić full audit;
  - jak rozpoznać cache miss, corrupt rebuild i source mismatch;
  - jak odczytać fazy timingów;
  - dlaczego Gmsh i Rayon mają osobne thread policies;
  - jak v1 jest migrowane bez nadpisania user file;
  - jakie działania są bezpiecznym rollbackiem.
- [ ] Publiczne przykłady pozostają stage-first `fm.study("sp4").stages`. Nie dodawaj `fm.Problem`.
- [ ] Source index mapuje claims do:
  - `_repair_mixed_tetrahedra`;
  - `compute_mixed_certificate_evidence`;
  - `certify_mixed_mesh_arrays`;
  - `_load_trusted_cached_mesh_artifact`;
  - `load_or_build_shared_domain_mesh`;
  - `validate_mesh_topology` w native FEM.

### Zadanie 11.3 Dokumentacyjne i repozytoryjne gate'y

- [ ] Uruchom:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0105-fem-meshing-production-acceptance.source-map.json --repo-root .
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

- [ ] Uruchom strict Sphinx i rendered HTML validation przez canonical docs workflow repozytorium.
- [ ] Uruchom placeholder scan:

```bash
rg -n "[T]ODO|[T]BD|to be documen[t]ed|for brevit[y]|implementation omit[t]ed" docs/physics/0105-fem-meshing-production-acceptance.md docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md docs/adr/0021-native-mixed-p1-fem-topology.md docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md
```

**Oczekiwane:** brak wyników.

### Zadanie 11.4 Rollout

- [ ] Faza A: zapisywać artifact v2, ale pełny audit pozostaje wymuszony. Zbierać parity i timings.
- [ ] Faza B: włączyć trusted fast path wyłącznie dla internal cache po przejściu tamper matrix i managed performance gate.
- [ ] Faza C: domyślnie użyć internal cache dla shared-domain mixed.
- [ ] Każda faza ma prosty rollback:
  - A → zapis v1 tylko, bez utraty możliwości load v2;
  - B → wymusić full audit dla cache;
  - C → bypass internal cache i przebudować, bez zmiany user path.
- [ ] Nie usuwaj readera v1 w tym rollout.
- [ ] Commit dokumentacyjny sugerowany po zgodzie:

```bash
git add docs/audits/2026-08-27-fem-mesh-pipeline-audit.md docs/superpowers/plans/2026-08-27-fem-meshing-production-remediation.md docs/physics/0105-fem-meshing-production-acceptance.md docs/physics/0105-fem-meshing-production-acceptance.source-map.json docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json docs/adr/0021-native-mixed-p1-fem-topology.md docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md
git commit -m "docs: qualify mixed mesh performance pipeline"
```

---

## 6. Pełna kolejność testów

### 6.1 Szybka pętla podczas implementacji

1. Focused Python unit dla aktualnego zadania.
2. Focused Rust unit dla aktualnego modułu.
3. Python/Rust golden parity na małych fixtures.
4. Jeden realny SP4 smoke bez managed solvera, jeżeli zadanie dotyczy wyłącznie meshera.
5. `git diff --check` dla własnego diffu.

### 6.2 Bramka przed integracją

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mixed_element_meshing.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_native_mixed_certificate.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mesh_artifact_trust.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_shared_domain_mesh_cache.py' -v
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_mesh_pipeline_timings.py' -v
cargo test -p fullmag-ir --test mixed_certificate_parallel -- --nocapture
cargo test -p fullmag-py-core --lib -- --nocapture
```

### 6.3 Bramka produkcyjna

Managed sekwencja z Zadania 10 jest jedynym dowodem CPU/GPU. Jeżeli storage, runtime manifest, CUDA, MFEM lub source identity blokują wykonanie, raport kończy się `BLOCKED` z dokładnym błędem. Nie zastępuj jej lżejszym testem.

---

## 7. Macierz ryzyk i zabezpieczeń

| Ryzyko | Prawdopodobieństwo | Skutek | Zabezpieczenie | Gate |
|---|---|---|---|---|
| Rayon zmienia kolejność redukcji float | średnie | różne certificate digests | per-ordinal collect, sort, fixed-order compensated sum | PERF-G07 |
| Typed bridge kopiuje dane kilka razy | średnie | brak oczekiwanego speedupu | jedna kopia CSR, brak full JSON/list, profiler allocation | PERF-G03/G05 |
| Fast path ufa przenośnemu plikowi | wysokie bez rozdziału API | akceptacja tampered mesh | public full load i private trusted-cache load | tamper matrix |
| Receipt zostaje nazwany signature | średnie | fałszywe twierdzenie bezpieczeństwa | nazwy digest/binding i ADR | docs validator/review |
| Cache key pomija wersję algorytmu | średnie | stale mesh po zmianie kodu | pełny key document i invalidation tests | cache tests |
| Concurrent writers publikują partial ZIP | średnie | sporadyczny corrupt load | per-key lock, full audit tmp, fsync, os.replace | multiprocessing test |
| Netgen wraca w niepowiązanej zmianie | średnie | non-manifold topology | versioned policy, exact test, negative fixture | repair policy test |
| Gmsh multithreading zmienia wynik | wysokie | brak reprodukowalności | fixed 1 thread do N=10 qualification | Task 9 |
| Python fallback jest uznany za produkcyjny | średnie | brak rzeczywistej kwalifikacji | `require_native=True` i provenance flag | bridge tests |
| Cache ukrywa regresję cold path | średnie | użytkownik nie widzi wolnego builda | osobne cold, full audit i warm gates | benchmark schema |
| Storage kończy się podczas rebuilda | wysokie obecnie | przerwany export, mylący wynik | 12 GiB preflight, brak auto-cleanup | managed preflight |
| Scope koliduje z planem parasolowym | średnie | dwa formaty/polityki | jawna traceability i brak duplikacji FMMQ v2 | docs review |

---

## 8. Definition of Done

Plan jest wdrożony dopiero, gdy wszystkie poniższe warunki są spełnione:

- [ ] Netgen nie jest produkcyjnym mixed repair; `Relocate3D` ma versioned policy i N=10 quality evidence.
- [ ] Canonical SP4 mixed ma zero non-manifold, overlap, inversion, same-side two-owner i missing-interface failures.
- [ ] Exact layers, rodziny, markery, volumes i quality thresholds są zachowane.
- [ ] Producer liczy pełny certificate raz.
- [ ] Rust i Python mają golden parity.
- [ ] Rust/Rayon daje identyczny fingerprint i digest dla 1, 2, 4, 8 threads.
- [ ] Managed strict path wymaga native certifiera.
- [ ] Artifact v2 przechodzi pełną tamper matrix.
- [ ] v1 nadal ładuje się przez full audit.
- [ ] Public/user artifact nigdy nie używa niejawnego fast trust.
- [ ] Shared-domain cache ma pełny key, per-key lock, atomic publish i concurrency tests.
- [ ] Warm hit nie uruchamia Gmsh ani full certificate recomputation.
- [ ] PERF-G01 warm p95 `<= 2.0 s` i max `<= 2.5 s`.
- [ ] PERF-G02 cold p95 `<= 180 s` i mediana `<= 0.65x` baseline.
- [ ] PERF-G03 native certificate p95 `<= 5 s` i speedup `>= 7.5x`.
- [ ] Peak RSS przechodzi PERF-G05.
- [ ] Numeric timings i provenance są zapisane w build report i evidence.
- [ ] Managed FEM CPU i GPU przechodzą bez fallbacku na tym samym topology fingerprint/certificate digest.
- [ ] Documentation validators, source maps, strict Sphinx i rendered HTML przechodzą.
- [ ] Audit i plan parasolowy mają uczciwe statusy `CONFIRMED`, `PARTIALLY CONFIRMED`, `NOT VERIFIED` albo `BLOCKED`.
- [ ] `git diff --check` jest czysty, a unrelated dirty files pozostają nietknięte.

Jeżeli choć jeden warunek jakości, zaufania albo managed runtime nie przejdzie, implementacja nie jest kompletna nawet wtedy, gdy benchmark jest szybszy.

---

## 9. Oczekiwany efekt i priorytet ekonomiczny

Kolejność zysku jest celowo następująca:

1. **Naprawa jakości:** zatrzymuje niewiarygodne wyniki i przywraca conforming mesh.
2. **Eliminacja podwójnej pracy:** ma niski koszt implementacyjny i poprawia cold/full-audit bez zmiany języka.
3. **Rust/Rayon certificate:** usuwa główny zmierzony warm-path hotspot.
4. **Bound receipt + internal cache:** usuwa powtarzanie pracy, co daje największy efekt dla codziennego uruchamiania.
5. **Bulk extraction:** jest wykonywane tylko, jeżeli po profilowaniu nadal ma znaczący udział.
6. **Gmsh threads:** są ostatnie, ponieważ mają najwyższe ryzyko utraty determinizmu i jakości.

Oczekiwany produktowy rezultat to ponowne uruchomienie niezmienionego SP4 mixed w czasie interaktywnym, pełny audit w kilku sekundach i cold build krótszy od trzech minut, bez poświęcania scientific validity.

---

## 10. Źródła

- `docs/physics/0105-fem-meshing-production-acceptance.md` — normatywne metryki, sampling i tolerancje.
- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md` — bounded mixed-P1 i certificate.
- `docs/adr/0021-native-mixed-p1-fem-topology.md` — topologia i native FEM ownership.
- `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md` — polityka i FMMQ v2.
- `docs/audits/2026-08-27-fem-mesh-pipeline-audit.md` — findings `FM-MESH-*`.
- `docs/superpowers/plans/2026-08-27-fem-meshing-production-remediation.md` — plan parasolowy.
- [Gmsh 4.15.2 reference manual — `gmsh/model/mesh/optimize`](https://gmsh.info/doc/texinfo/gmsh.html): official API rozróżnia default tetra optimizer, Netgen i Relocate3D; wybór Fullmag wynika z własnej macierzy jakości, nie z samej dostępności metody.
- [PyO3 0.29 — `Python::detach`](https://docs.rs/pyo3/0.29.2/pyo3/marker/struct.Python.html#method.detach) — oficjalny kontrakt zwolnienia interpretera na czas długiego kernela Rust.
- [rust-numpy 0.29](https://docs.rs/numpy/0.29.0/numpy/) — typowane `PyReadonlyArray` zgodne z PyO3 0.29.
