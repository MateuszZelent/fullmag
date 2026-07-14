# Prompt wdrożeniowy — produkcyjne naprawy FEM/FDM mesh

Pracujesz w repozytorium Fullmag. Wdroż pełny zakres audytu FEM/FDM meshingu, regionów, PBC oraz Control Room. Nie zawężaj zadania do pojedynczego backendu ani do testów jednostkowych.

## Źródło prawdy i zakres

1. Przeczytaj `AGENTS.md`, raport `docs/reports/2026-07-13/fem-fdm-mesh-production-audit/README.md` oraz wszystkie plany w `docs/plans/active/fem-fdm-mesh-production-remediation-2026-07-13/`.
2. Zrealizuj dokładnie wszystkie 60 findingów z raportu: 23 P0, 35 P1 i 2 P2.
3. Zakres obejmuje cały łańcuch: Python DSL → ProblemIR → planner → runtime/native FEM/FDM CPU/GPU → artefakty/provenance → OpenAPI/resource-first API → Control Room Explorer/Inspector/viewport.
4. Uwzględnij regiony: identity topologii, membership, marker certificates, owner transforms, overlap policy, independent realization revisions, cache partitioning i lifecycle remeshu.
5. Uwzględnij lustrzane PBC mesh: jawne face/node bijections, normal orientation, edge/corner closure, mixed magnetic/airbox domain, stale certificate detection oraz parity dla osi aktywnych i otwartych w FEM/FDM.

## Zasady implementacji

- Najpierw rozpoznanie i plan, potem RED tests, następnie minimalny GREEN patch i dowód regresji.
- Nie używaj centroid-nearest matching, obcinania connectivity, ukrytych fallbacków ani synthetic revisions.
- `realized` i `preview` muszą mieć różne statusy; aktualna topologia, generation ID, scene/region revisions i certificate fingerprints muszą być jawne.
- Requested intent i resolved execution reality muszą być zachowane w planie, runtime, artefakcie i UI.
- Unsupported path ma kończyć się stabilnym, opisowym reason code; nie wolno udawać wsparcia.
- Frontend v2 używa wyłącznie typed API/resource hooks, generated OpenAPI types, centralnego command/invalidation registry i własnych Inspectorów dla każdego semantycznego węzła.
- Każda zmiana UI wymaga typecheck, lint bez warningów, testów i browser smoke; każda zmiana native FEM/MFEM/CUDA wymaga repozytoryjnego, container-backed `just` gate.
- Nie modyfikuj niezwiązanych zmian w dirty worktree. Pracuj w izolowanym worktree/branchu.

## Kolejność fal

### Wave 0 — kontrakty i legalność

Domknij strict MeshIR validation, Gmsh element dispatch, FDM grid/origin/translation/certificate, per-magnet resolution, region realization revisions, marker/generation identity oraz capability matrix. Dodaj physics/spec/ADR notes przed zmianami semantyki.

### Wave 1 — FEM shared-domain i mirrored PBC

Napraw import i walidację elementów, airbox marker certificate, operation/adaptivity semantics, atomic remesh lifecycle, persisted v6 certificate, jawne node/face pairs, bijections, orientation i closure. API ma publikować certyfikowane diagnostyki, unpaired counts i stale status.

### Wave 2 — FDM PBC i multilayer

Zaimplementuj per-axis open/periodic transfer, FP64 parity, kwalifikację FP32 CUDA, multilayer in-plane seams/self/shifted demag, T0/T1 semantics, image budgets oraz persisted transfer provenance. Capability gating ma odblokowywać wyłącznie zweryfikowane lanes.

### Wave 3 — API, data plane i Control Room

Przenieś identity/revisions/fingerprints przez OpenAPI i artefakty. Dodaj resource-first hooks, ETag/invalidation po revision, canonical UI → Python round-trip PBC, capability-driven mesh editor, periodic overlay oraz Inspector statusy `valid|invalid|stale|unavailable` dla wszystkich workflowów. Nie mieszaj realized membership z analytic preview.

### Wave 4 — produkcyjne gates

Dodaj i uruchom manifesty obejmujące native contract, managed runtime, CUDA/FDM matrix, corrupt fixtures, remesh, periodic-antidot reproducibility, API hygiene, architecture hygiene, browser/WebGL smoke i screenshot/metrics evidence. Top-level gate ma failować, jeśli brakuje dowolnego stage albo fingerprintu artefaktu.

## Weryfikacja i raportowanie

Uruchamiaj testy proporcjonalnie do zmiany, a na końcu wszystkie właściwe gates z `justfile`; dla FEM/MFEM/CUDA nie zastępuj managed recipes hostowym buildem. Zapisuj stdout, exit code, revision, toolchain, topology/grid/certificate fingerprints i ścieżki artefaktów.

Dla każdego findingu uaktualnij osobny plik planu: status, zmienione pliki, test RED/GREEN, wynik managed/browser gate, znane ograniczenia i commit. Nie zaznaczaj findingu jako zamkniętego bez dowodu end-to-end.

## Kryterium zakończenia

Zadanie jest zakończone wyłącznie przy 60/60 findingów z dowodem implementacji, testów, artefaktów i odpowiednich gates. Jeśli jakikolwiek finding, UI Inspector, region identity, mirrored PBC lane, managed runtime lub browser proof pozostaje otwarty, raportuj `NO-GO` i listę blokad zamiast deklarować sukces.
