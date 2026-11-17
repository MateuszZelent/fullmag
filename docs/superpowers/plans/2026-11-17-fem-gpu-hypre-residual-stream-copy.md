# FEM GPU — HYPRE residual stream copy Implementation Plan

> **For agentic workers:** implement with `executing-plans`; one bounded worker owns helper/patch/fixture, root owns integration, documentation, review and managed runtime.

**Goal:** Usunąć legacy-stream D2D z kopiowania RHS residuum AMG i zmierzyć efekt na identycznym SP4, bez zmiany fizyki.

**Architecture:** Wąski guarded CUDA fastpath w przypiętym HYPRE3.1.0. Obiekty, ABI i algorytm Poissona pozostają te same; nowy helper tylko zleca dokładną kopię na istniejącym strumieniu. GPU biblioteka jest aktualizowana w deps-stage grupy Q, z zachowaniem CPU prefix i starych wyników.

**Tech Stack:** HYPRE3.1.0, MFEM4.10, CUDA12.4, zarządzany Docker Compose Fullmag.

**Spec:** Poniższy kontrakt i kryteria tego dokumentu. Kontrakt: canonical contiguous device b/y, offset0, byteexact D2D na strumieniu HYPRE; inne layouty zachowują dotychczasową operację. Brak nowego Python/IR parametru.

## Global Constraints

- Strict FEM GPU/double bez fallbacku CPU; operator i stopping/residual1e-12/stride8 bez zmian.
- Zachować aktualne m110ps, mesh, zasoby2CPU/8GiB/4GiB/2GiB i pełne11ramek Zarr.
- Źródła W, walidacja/build tylko grupa Q po FF do zweryfikowanego commita; nie naruszać czterech foreigntracked zmian.
- Nie publikować nowych niepublicznych danych; zachować current/rollback i wszystkie wyniki.

## Review Focus

- Inne rozmiary/strides, mixed precision i offset nie mogą wejść w fastpath.
- Błąd CUDA nie może przejść do matvec lub naliczyć sukcesu.
- Kopia musi być na tym samym strumieniu co następny matvec; nie używać untracked stream/global policy change.
- Stary obraz bez symbolu nie kwalifikuje nowego patcha.
- Manifest/checksums/context inputs i CPU closure muszą pozostać zgodne z rzeczywistą biblioteką.

### Task1 — helper, patch i regresja urządzenia

Owner bounded worker: `docker/fem-gpu/patches/hypre-3.1.0-residual-stream-copy.{diff,hpp}`, `backends/fem/tests/hypre_residual_async_copy_fixture.hpp`.

- [ ] Dodać helper bez heap/fence i patch jednego callsite, na dokładnym źródle9dc9e18… .
- [ ] Dodać rzeczywiste regression fixture dla wyniku, count/bytes, alias/layout/offset i błędu submission.
- [ ] Root review callsite/source guard i kolejności, bez równoległej implementacji tych samych plików.

### Task2 — włączenie do zarządzanego obrazu i testów

Owner root: `docker/fem-gpu/Dockerfile`, `Dockerfile.dockerignore`, `scripts/test_bootstrap_docker_toolchain.py`, istniejący `demag_poisson_contract.cpp`, notatka/source-map0532.

- [ ] RED: nieobecne inputy/hit/checksum muszą powodować niepowodzenie odpowiedniego kontraktu.
- [ ] Pinned COPY/apply/checksums po starych deps-buildach, incremental GPU HYPRE make/install, manifest patch/digest.
- [ ] Testy źródłowe i dokumentacji; review oraz spójny commit fragmentu.
- [ ] Qclean FF do commita, managed toolchain/backend, exact native CPU/GPU gates i provenance.

### Task3 — identyczny SP4 i decyzja o dalszym graph replay

- [ ] Nowe jednoznaczne klucze prób, nowy sąsiedni .py/Zarr, identyczna fizyka i zasoby jak ukończona para17XI.
- [ ] Rzeczywisty bieg5ps bez CUPTI + nowy zakresCUPTI; pełne science i bitwise gate.
- [ ] Porównanie czasów z zachowanym, przypiętym baseline i liczby/kosztu memcpy; zakresy i narzut profilera oddzielne.
- [ ] W razie korzyści powtórzyć matchedpairs; graph w kolejnym etapie dopiero po compatibilityproof. Dokończyć całą integrację zadania i pierwotny cel, nie uznawać tego etapu za pełne1ns/MuMax.
