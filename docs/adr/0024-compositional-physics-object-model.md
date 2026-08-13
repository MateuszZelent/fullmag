# ADR 0024 — Kompozycyjny model obiektów fizycznych

**Status:** accepted

**Date:** 2026-08-13

**Decision makers:** core team

## Context

Publiczny model rozdziela dziś obiekty na magnetyczne `magnets[]` i
niemagnetyczne `auxiliary_geometries[]`. Python `geometry()` zwraca
`MagnetHandle`, a antena wymaga osobnego `antenna_object()`. Taki układ wiąże
geometrię z jedną rodziną fizyki, utrudnia równorzędne modelowanie
przewodników HM i sprzyja pokazywaniu pustych rodzin current/spin/torque w UI.

Fullmag wymaga jednego Python DSL, jednego `ProblemIR`, jednego graphu fizyki
i jednego drzewa Control Room dla FEM oraz FDM. Istniejący kontrakt
`physics_graph.v1` ustala już, że brak modułu nie jest tym samym co moduł z
zerowym wymuszeniem.

## Decision

Wprowadzamy jeden kanoniczny `PhysicsObject` oraz kolekcję `objects[]`.

Każdy obiekt ma:

- niezmienne `object_id` dla referencji i proweniencji;
- unikalne, zmienialne `name` dla authoringu;
- opcjonalne `label`;
- podstawowy `type`: `geometry`, `ferromagnet`, `conductor` albo `antenna`;
- referencję do geometrii, regionów i przypisań materiałowych.

`type` jest archetypem authoringu i prezentacji. Nie tworzy, nie aktywuje i
nie wybiera operatora. Fizyka istnieje wyłącznie jako jawnie dodany moduł
obiektu, regionu, interfejsu albo zakresu globalnego.

Elektroda jest nazwanym warunkiem brzegowym modułu current transport na
powierzchni; nie jest typem bryły. Interfejs jest osobnym, pojedynczym bytem
łączącym dwie zorientowane strony i nie należy wyłącznie do jednego obiektu.

Python otrzymuje kanoniczne `study.object(...) -> PhysicsObjectHandle` oraz
kompozycyjne akcesory modułów. `geometry()` i `antenna_object()` pozostają
czasowymi adapterami odczytu/migracji, ale canonical script exporter ich nie
emituje.

## Consequences

Korzyści:

- HM, FM, anteny i neutralne bryły są równorzędnymi obiektami sceny;
- ferromagnetyk może jednocześnie uczestniczyć w transporcie bez wielokrotnego
  typowania;
- rename nie zrywa graphu, checkpointów ani interfejsów;
- Explorer pokazuje tylko faktycznie zapisane moduły;
- FEM i FDM dzielą semantykę, a różnią się maskami i markerami;
- UI nie potrzebuje pustych kolekcji ani heurystyk po nazwie/pozycji.

Koszty:

- publiczna wersja `ProblemIR` wymaga jawnej migracji;
- Python, SceneDocument, Rust IR, planner, API i UI muszą przejść w jednej
  kontrolowanej sekwencji;
- kompatybilność legacy wymaga czasowych adapterów i golden fixtures;
- istniejące odwołania oparte na nazwach muszą zostać obniżone do stabilnych
  ID przed wykonaniem.

## Implementation obligations

1. Zachować notę `docs/physics/0995-physics-module-scope-and-activation.md`
   jako właściciela semantyki obecności i aktywacji.
2. Wersjonować `PhysicsObjectIR` i migrację `magnets[]` oraz
   `auxiliary_geometries[]` do `objects[]`.
3. Zapewnić bezstratny Python/UI canonical round-trip.
4. Materializować `object_id`/`region_id`/surface/interface jako maski FDM i
   markery FEM bez użycia `type` do wyboru operatora.
5. Publikować requested intent, resolved execution, rewizje i raport migracji
   w proweniencji.
6. Utrzymać OpenAPI-first zasoby v2, generowane typy, centralny klient i
   resource hooks.
7. Nie usuwać adapterów legacy przed pełnym golden round-tripem i ogłoszonym
   oknem deprecacji.

## Migration and rollback

Czytnik starego IR tworzy obiekty deterministycznie: `magnets[]` stają się
`ferromagnet`, anteny `antenna`, a pozostałe auxiliary geometries `geometry`.
Moduły są mapowane wyłącznie przez jednoznaczne referencje. Niejednoznaczność
daje `unresolved` i blokuje wykonanie zamiast zgadywania.

Do chwili zakończenia migracji rollback polega na pozostawieniu starego
publicznego writera jako jawnego eksportera kompatybilności. Nie wolno
utrzymywać dwóch równorzędnych edytowalnych modeli w jednej scenie. Gdy nowy
writer stanie się kanoniczny, stary eksport może działać wyłącznie dla modeli
reprezentowalnych bezstratnie.

## Tests and validation

- Python/IR golden round-trip każdego typu i kombinacji modułów;
- rename przy niezmiennym `object_id`;
- migracja legacy oraz fail-closed dla referencji niejednoznacznych;
- brak transportu w planie/runtime FEM i FDM, gdy modułu nie dodano;
- zachowanie modułu z zerowym wymuszeniem;
- parity OpenAPI, generowanych typów, klienta i SceneDocument;
- Explorer/Inspector browser smoke dla FEM oraz FDM;
- provenance identity i brak ukrytego fallbacku.

Szczegółowy kontrakt znajduje się w
`docs/superpowers/specs/2026-08-13-compositional-physics-object-authoring-design.md`.
