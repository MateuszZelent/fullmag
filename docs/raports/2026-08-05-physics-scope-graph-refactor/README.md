# Refaktoryzacja grafu zakresu modułów fizycznych

## Cel

Raport dokumentuje implementację kontraktu `PhysicsGraphIR` dla modułów STT,
SOT, SHE, transportu spinu, pola Oersteda i pól zewnętrznych. Graf rozróżnia
brak zapisanego modułu od modułu skonfigurowanego z zerowym napędem oraz
oddziela `applies_to` od `solve_domain`. Ten sam graf jest używany przez
authoring, `ProblemIR`, planner i Control Room dla FEM oraz FDM.

## Zakres wykonanej zmiany

- znormalizowany graf authoringu z deterministycznymi identyfikatorami,
  zależnościami, zakresem i stanem aktywacji;
- propagacja grafu w Python DSL i `ProblemIR` z zachowaniem starych payloadów
  rodzin fizycznych;
- walidacja planera oraz lane-specific semantic marker/mask identities;
- cienki zasób v2 `GET /v2/sessions/current/model/physics-graph`, wygenerowany
  kontrakt OpenAPI, typed API facade, resource hook i invalidation;
- rozmieszczenie węzłów Explorera wyłącznie z grafu, w tym gałęzie object,
  global, cross-object i unresolved;
- wspólna kompozycja inspektora zgodna z szablonem Visualization;
- fail-closed verifier `scripts/verify_physics_scope_graph_runtime.py`, który
  porównuje ID, scope, zależności i lane-specific marker/mask po dostarczeniu
  artefaktu runtime;
- jawna granica FEM solved-current → Oersted: obecny publiczny ABI pozostaje
  referencyjnym H1/P1 nodal midpoint, a przyszłe RT0/H(div) jest opisane jako
  kontrakt append-only, bez udawania implementacji.

## Status

Implementacja jest gotowa do review i integracji źródłowej po przejściu
opisanych testów. Nie jest to deklaracja produkcyjnej kwalifikacji fizyki.
FEM dynamiczny Oersted nadal ma status `development_executable` dla
ograniczonego CPU one-way steady slice; FEM GPU, FDM cross-backend parity,
RT0 end-to-end i browser smoke pozostają otwarte.

Szczegółowe dowody, ograniczenia i kolejne bramy znajdują się w
[`QUALIFICATION.md`](./QUALIFICATION.md).

Verifier grafu jest dowodem kontraktu porównania, nie dowodem uruchomienia
solvera. Dopóki managed FEM/FDM runtime nie zapisze wymaganego artefaktu z
scene revision i `executed_module_ids`, status runtime pozostaje otwarty.

## Zasady odtwarzalności

Ciężkie kompilacje FEM/MFEM/CUDA/HYPRE wykonuje się wyłącznie przez recepty
`just` repozytorium, z trwałym storage pod `/zfn2/mateuszz/git/fullmag`.
`/mnt/fullmag-zfn2-native` i `/tmp/fullmag-zfn2-build` są tylko widokami
montowania/warstwą roboczą. Artefakty z tego raportu nie zawierają drzew
builda.
