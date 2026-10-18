# Zależności obrazu FEM/GPU

Źródłem prawdy dla wersji i pinów jest [`docker/fem-gpu/Dockerfile`](fem-gpu/Dockerfile). Raporter [`scripts/docker_dependency_report.py`](../scripts/docker_dependency_report.py) odczytuje z Dockerfile instrukcje `ARG`, `ENV` oraz kontrole commitów w `RUN`; nie utrzymuje osobnej listy wersji.

Raport ma format `fullmag.docker_dependency_report.v1` i jawnie wskazuje zgodny kontrakt manifestu `fullmag.docker.fem-gpu-dependencies.v1`, który publikuje `docker/fem-gpu/write_dependency_versions.py` i waliduje `docker/all-in-one/Dockerfile.dev`:

- `source` zawiera ścieżkę Dockerfile, jego SHA-256 i wersję parsera;
- `declared` zachowuje kanoniczne pola `base_image`, `cuda`, `hypre`, `dependencies` oraz `tools`;
- `artifact_hashes` zawiera SHA-256 archiwów Node/Python odczytane z `ARG`;
- `pinning` opisuje siłę deklaracji;
- `installed_manifest`, gdy podany, musi mieć kanoniczny schemat i `actual.source_commits`; pozostaje dowodem operatora;
- `installed_comparison` pokazuje wyłącznie match/mismatch/missing pinów źródłowych i nie nadaje kwalifikacji;
- `latest` jest domyślnie `not-queried`, a `--check-updates` dodaje obserwacje stabilnych wydań.

Przykładowe użycie bez sieci:

```text
python3 scripts/docker_dependency_report.py \
  --dockerfile docker/fem-gpu/Dockerfile
```

Manifest faktycznie zbudowanego toolchainu przekazuje się bez konwersji, w formacie używanym przez istniejący writer:

```json
{
  "schema": "fullmag.docker.fem-gpu-dependencies.v1",
  "declared": {},
  "actual": {
    "source_commits": {
      "mfem": "<40-hex>",
      "libceed": "<40-hex>",
      "hypre": "<40-hex>",
      "petsc": "<40-hex>",
      "slepc": "<40-hex>"
    }
  },
  "latest": {"status": "not-queried"}
}
```

Raporter zachowuje ten manifest w `installed_manifest`; nie zamienia deklaracji na `actual`, nie nadaje statusu `qualified` i nie porównuje ślepo wariantów CPU/GPU.

`--check-updates` wykonuje wyłącznie bounded read-only odczyt oficjalnych endpointów upstream (GitHub, GitLab, Node.js lub oficjalny kanał Rust) i zapisuje dla każdego źródła `declared`, `latest_stable`, `status` oraz `comparison`. Wersje prerelease są odrzucane. CPython używa oficjalnego endpointu tagów GitHub, a puste listy wydań PETSc/SLEPc przechodzą na oficjalne endpointy repository tags z filtrem stabilnych semverów. pnpm i Umpire mają oficjalne endpointy GitHub. W kanale Rust wersja pakietu może zawierać po numerze stabilnym hash i datę; raport porównuje sam numer z prefiksem wersji. Każda odpowiedź jest ograniczona do 2 MB, a timeout do 30 s. Błąd lub niedostępność endpointu jest zapisany jako `unavailable`; nie zatrzymuje raportu i nie modyfikuje Dockerfile. CUDA pozostaje jawnie `not-queried`, ponieważ tag wymaga dopasowania toolkit/dystrybucja/architektura.

## Znaczenie pinów

| Zależność | Deklaracja w kanonicznym `declared` | Ograniczenie interpretacji |
| --- | --- | --- |
| CUDA | `base_image.reference`, opcjonalny digest, `cuda.version`/architektury | tag obrazu obejmuje toolkit, wariant i Ubuntu; brak digestu nie jest exact image pinem |
| MFEM | `dependencies.mfem.ref` + `commit` | commit jest sprawdzany podczas obrazu |
| CEED | `dependencies.libceed.ref` + `commit` | nazwa `libceed` zachowuje istniejący manifest |
| HYPRE | `dependencies.hypre.ref` + `commit` | pamięć i architektury są osobno w `hypre` |
| PETSc | `dependencies.petsc.ref` + `commit` | ref i source commit są raportowane osobno |
| SLEPc | `dependencies.slepc.ref` + `commit` | ref i source commit są raportowane osobno |
| Python | `tools.python` + `artifact_hashes.python` | wersja i SHA archiwum |
| Node | `tools.node` + `artifact_hashes.node` | osobny SHA dla amd64/arm64 |
| CMake | `tools.cmake` | wersja używana przez instalację pip |
| Rust | `tools.rust` | `nightly` jest kanałem, bez exact commit |

`latest` służy do obserwacji różnicy między pinem a bieżącym wydaniem. Nie aktualizuje zależności automatycznie, nie zmienia manifestu i nie zastępuje testów, manifestu obrazu ani kwalifikacji FEM/GPU.
