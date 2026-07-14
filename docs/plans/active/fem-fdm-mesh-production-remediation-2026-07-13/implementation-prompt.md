# Prompt wdrożeniowy: produkcyjna naprawa meshu FEM/FDM, regionów i PBC

Skopiuj poniższy tekst do nowej sesji wykonawczej.

---

Jesteś głównym inżynierem wdrażającym pełną naprawę produkcyjną backendu tworzenia meshu FEM/FDM oraz powiązanych regionów, PBC, API, Control Room, Explorerów i Inspectorów w repozytorium Fullmag.

## Zakres obowiązkowy

Zamknij wszystkie 60 findingów z audytu [README audytu](../../../reports/2026-07-13/fem-fdm-mesh-production-audit/README.md) i wykonaj odpowiadające im plany z katalogu [planów](./README.md). Zakres obejmuje 23 problemy P0, 35 P1 i 2 P2:

- FDM: `MESH-FDM-001..007`.
- FEM: `MESH-FEM-001..007`.
- Regiony: `MESH-REGION-001..017`.
- Lustrzane PBC FEM: `MESH-PBC-FEM-001..006`.
- PBC FDM: `MESH-PBC-FDM-001..007`.
- API/data plane: `MESH-API-001..004`.
- Control Room/UI/Explorer/Inspector/viewport: `MESH-UI-001..008`.
- Bramki produkcyjne: `MESH-GATE-001..004`.

Nie zawężaj zadania do jednego backendu, jednego urządzenia, samych testów jednostkowych ani samego UI. Audyt ma status `NO-GO`, dopóki każdy finding nie ma implementacji, testu i dowodu produkcyjnego.

## Źródła prawdy

Przed edycją przeczytaj:

1. `AGENTS.md` oraz właściwe `.agents/skills/*/SKILL.md`.
2. [Raport audytu](../../../reports/2026-07-13/fem-fdm-mesh-production-audit/README.md).
3. Wszystkie 60 plików planów w tym katalogu; nie zastępuj ich własną interpretacją.
4. Obowiązujące noty `docs/physics/`, ProblemIR, capability matrix i resource-first API v2.
5. Docelowy kontrakt `periodic_mesh_certificate.v6` opisany w `04_mesh_periodic_floquet_airbox.md`.

Najpierw wykonaj `git status --short`, sprawdź gałąź bazową i utwórz izolowany worktree. Istniejące częściowe commity lub checkboxy traktuj jako hipotezę do zweryfikowania, nie jako dowód ukończenia. W szczególności zweryfikuj bieżące blokery `MESH-FEM-003` (pełne przeniesienie `MeshBuildReport` przez eigen/frequency, artefakt, API i Inspector oraz regeneracja OpenAPI) i `MESH-FEM-004` (kompletność/rozłączność ról airboxu, zachowanie interfejsu w frozen mesh i trwały certyfikat).

## Nienegocjowalne zasady implementacji

- Stosuj TDD: najpierw regresja odtwarzająca konkretny finding, potem minimalna poprawka.
- Semantyka ma płynąć jednym łańcuchem: Python DSL/UI → ProblemIR → walidacja/normalizacja → planner/capability → runtime CPU/CUDA → artefakty/provenance → OpenAPI/data plane → facade/resource hooks → Explorer/Inspector/viewport.
- `ProblemIR` i `periodic_mesh_certificate.v6` są kanoniczne. Nie twórz równoległego kontraktu PBC ani backend-specific truth.
- Zachowuj osobno `requested intent` i `resolved execution`; `auto` nie może zniknąć.
- Wszystkie nieobsługiwane, niejednoznaczne lub niecertyfikowane przypadki mają kończyć się fail-closed ze stabilnym kodem i przyczyną możliwą do pokazania w UI.
- Każda zmiana fizyki lub numeryki wymaga aktualizacji publication-style note w `docs/physics/` przed kodem.
- Native FEM/MFEM/CUDA/hypre/libCEED buduj i uruchamiaj przez repozytoryjne, container-backed recipe `just`; hostowe `cargo/cmake` są wyłącznie diagnostyczne.
- Nie omijaj OpenAPI: schema → wygenerowane JSON/TS/client → facade → hook → konsument UI → test HTTP/WS.
- Nie uznawaj rozpoczętego kontenera, source inspection ani zielonego testu warstwowego za dowód produkcyjny.
- W `apps/control-room` zachowaj prefiks `fm-`, tokeny `--fm-*`, resource-first API, SSR-safe state i osobny Inspector dla każdego semantycznego węzła Explorera.
- Nie wykonuj drive-by refactorów. Każdy zmieniony wiersz musi wynikać z findingu.

## Wymagania dla lustrzanego PBC FEM

Dla każdej osi okresowej certyfikat musi dowodzić łącznie:

1. dokładnego okresu domeny (FDM: `L_i = N_i d_i`; FEM: jawny wektor translacji);
2. bijekcji węzłów ścian minus/plus po translacji, z zapisaną tolerancją;
3. bijekcji elementów ścianowych, zgodnej topologii, orientacji, normalnych, markerów i domen;
4. pełnych klas równoważności węzłów, krawędzi i narożników przy wielu osiach oraz dowodu komutowania translacji;
5. zgodności owner/region membership oraz elementowych pól materiałowych, w tym pól nodal i DG0 (`Ms`, `Aex` i innych używanych współczynników);
6. fingerprintu certyfikatu związanego z topology hash, mesh identity, region-marker mapą i resolved PBC;
7. unieważnienia i ponownej certyfikacji po imporcie, remeshu, adaptivity, auto-coarsening i transferze pól;
8. jawnej fazy Blocha dla problemów spektralnych oraz fazy zerowej dla statycznego PBC;
9. fizycznego testu M5: primitive cell kontra odpowiadająca supercell w opublikowanych tolerancjach.

Nie wolno syntetyzować normalnych, parować nearest-centroid bez dowodu vertex/topology, ignorować mixed magnetic/air seams ani zachować starego certyfikatu po zmianie topologii.

## Kolejność fal

Realizuj w tej kolejności, a w obrębie fali równolegle tylko przy braku współdzielonych plików:

1. **Fala 0 — legality i kontrakty:** FDM 001–007, FEM 001–002, PBC-FEM-002, PBC-FDM-001, REGION-001, REGION-004, REGION-008–011.
2. **Fala 1 — generatory i parity:** pozostałe FEM, PBC-FDM, PBC-FEM-003–006, REGION-002,003,005,007.
3. **Fala 2 — raporty, artefakty i identity:** FEM-003, PBC-FDM-006, API-001–004, REGION-006,012,015,016.
4. **Fala 3 — authoring i obserwowalność:** UI-001–008, REGION-013,014,017.
5. **Fala 4 — dowód promocyjny:** PBC-FEM-001 oraz GATE-001–004.

Po każdym findingu zaktualizuj checklistę `.superpowers/sdd/checklist.md`, właściwy plan i sekcję evidence. Nie zaznaczaj `[x]`, dopóki test i dowód nie są dostępne.

## Minimalny protokół dla każdego findingu

Dla każdego ID:

1. wskaż dokładny kod źródłowy i istniejącą ścieżkę wykonania;
2. dodaj test reprodukujący błąd (w tym przypadki graniczne, overflow, stale identity i fail-closed);
3. zaimplementuj najmniejszą pełną poprawkę zgodną z kontraktem;
4. propaguj zmianę przez wszystkie warstwy, których dotyczy finding;
5. dodaj test round-trip/provenance/API/UI, gdy finding przekracza granicę warstw;
6. uruchom właściwe testy lokalne, potem bramkę managed/container-backed;
7. wykonaj niezależny review diffu; popraw wszystkie blokery;
8. zapisz w planie: commit, komendę, wynik, artefakt/log i pozostałe ograniczenia.

## Bramki końcowe

Przed deklaracją ukończenia muszą być zielone i udokumentowane:

- wszystkie testy regresyjne 60 findingów oraz pełne właściwe pakiety Rust/Python;
- managed native FEM meshing/runtime przez odpowiednie recepty `just`;
- parity CPU vs CUDA `double` oraz kwalifikowane ścieżki CUDA `single` dla PBC, exchange, demag, T0/T1, multilayer i transferu pól;
- macierz PBC obejmująca corrupt faces, unpaired nodes/elements, mixed domains, orientation/normals, edge/corner closure, remesh, auto-coarsening, FP32, multilayer i M5 primitive/supercell;
- aktualny OpenAPI v2, wygenerowane typy/client i testy HTTP/WS invalidation/ETag;
- `pnpm --dir apps/control-room typecheck`, lint z `--max-warnings=0` i testy;
- browser smoke z widocznym canvasem, nieutraconym WebGL context i niezerowym drawing buffer, a także testy Explorer/Inspector/viewport;
- `MESH-GATE-003` bez environment override ukrywających failure oraz `MESH-GATE-004` bez architekturalnych/lintowych pozostałości;
- końcowa tabela 60/60 z odnośnikiem do planu, testu i artefaktu evidence.

Jeśli jakakolwiek bramka nie może zostać uruchomiona z powodu środowiska, nie oznaczaj zadania jako ukończonego. Zapisz dokładny blocker, komendę i log, napraw środowisko lub poproś o brakującą zgodę. Końcowa odpowiedź ma rozróżniać: `complete`, `partial` i `blocked`; nigdy nie nazywaj częściowej implementacji produkcyjnie gotową.

---
