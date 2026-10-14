# P8-53CI — blokada realizacji exact layers w scoped mesherze

Data: 14.10.2026. Diagnoza tylko do odczytu, bez zmiany meshera.
Właściwy kontrakt: ADR-0027, sekcja Exact layers; canonical scientific owner:
`docs/physics/0102-airbox-mesh-grading-geometric.md`, sekcja Limitations,
i istniejący source-map tego dokumentu.

Python contracts job 115771172550: 4 FAIL / 35 PASS. Public box/DE fixtures
zadają 6 magnetic layers; mesher otrzymuje 7–9 exact z intervals. Lowering
zachowuje authored 6, a generator liczy wyłącznie nodes magnetic body,
więc to nie są konieczne dodatkowe granice zewnętrznego airboxa.
Geometry-only GEO extrusion tworzy CAD partycje, ale nie wymusza jednej
warstwy siatkowej w każdej partycji. Gmsh może dodać wewnętrzne płaszczyzny.
Guard słusznie odmawia; nie zmieniać sześciu na siedem–dziewięć w fixture.

Przyrost naprawczy musi spełnić równocześnie exact L/L+1 planes oraz
owner-volume fields i independent airbox grading. Samo przywrócenie starego
premeshed cap extrusion może zazielenić exact-count, lecz utracić niezależne
sizing fields; taki wynik nie zamyka wymagania. Wariant numElements=[1]
bez pełnego cofnięcia pól wymaga rzeczywistego porównania wszystkich bramek,
nie jest jeszcze zatwierdzonym rozwiązaniem ani wykonanym fixem.

Przed kodem uzupełnić canonical scientific note/source map zgodnie z
scientific-documentation-contract i physics-publication. Wymagany odbiór:
cztery public box/DE tests, scoped exact-layer tests, positive tet4,
nieprzecinanie plane boundaries, seam incidence, periodic translations,
body XY invariance i near-to-far air growth. Zachować requested versus
resolved targets i nie fałszować raportowanego derived cap.

Mesher fix, jego runtime proof i kwalifikacja pozostają **NOT VERIFIED**.
Diagnoza nie zastępuje implementacji; pełny plan pozostaje aktywny.
