# P6-58 — exact saved map ↔ geometry binding

Data: 01.10.2026. Baza: `31a1f7fb4c049c1a8851ae6ca0a63d14af5cabb9`.
Status: przyrost integralności odczytu; P6 około **52%**, cały plan około
**49%**. Nie podnosi kwalifikacji natywnej, naukowej ani release.

## Wykonany zakres

Exact snapshot reader P6-56 dla źródła z native map P6-57 wymaga teraz
jednego geometry bindingu P6-54 w dokładnym historycznym owner/member.
Porównuje pełny pinned source, tensor artifact i accepted state oraz
producer descriptor/topology/support z geometrią. Brak, duplicate exact
binding i uszkodzony CAS/manifest/payload są błędem. Nie wybiera aktualnej
rewizji SolutionSet ani live ścieżki jako zastępstwa historycznej geometrii.

Mapa core periodic classes jest porównywana z zapisanym canonical MeshIR:
pełne node→class i class→representative arrays, transitive union z minimum
indeksu, kolejność klas według canonical node scan oraz compatibility
revision identyczna z native core. Ten FNV revision nie jest certyfikatem
kryptograficznym. Identyczna liczba klas bez zgodnej partycji jest odrzucana.
Nonperiodic geometry wymaga identity arrays i revision zero. MFEM true DOFs
pozostają osobną liczbą; nie konstruujemy MFEM restriction/prolongation.

Wartości źródłowego pola są zwalniane przed odczytem geometrii. Istniejące
limity CAS i map extents obowiązują przed cold O(n) workspace union-find.
Pełny odczyt mapy/geometrii nadal wymaga pamięci O(n); peak RAM niezmierzony.
Legacy source bez mapy zachowuje wcześniejszy odczyt receiptu/None.

Zmiany nie dodają CAS rootów, endpointów ani renderera. Geometria zachowuje
`representation_evidence = not_verified`. Zgodność partycji z planem nie
dowodzi live native coordinates/connectivity ani samego wykonania solvera.
Kontrakt: [ADR 0043](../../../../../adr/0043-native-local-node-index-map.md).

## Dowody i bramki

Production API source check: PASS, exit 0, receipt
`126ef2d4347747d2bd0129b3c33cfba9`, względnie
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/`.
Nie kompilowano ani nie uruchamiano unit tests.

Dodano źródła regresji dla odmiennej partycji przy tych samych counts,
niezgodnego revision, transitive minimum, kolejności/kierunku pairs,
extentów, invalid/self pairs oraz nonperiodic identity. To źródła regresji,
nie wynik ich wykonania. Niezależny review: brak P0/P1 i nowej usterki P2
w implementacji; potwierdzono exact owner, pełne class arrays i FNV parity.
Kontrola spójności repozytorium, zmienionych linków i diff check: PASS.

Build 190 (`c80236a8ce674d6e9709346363d86ea3`) jest zleceniem natywnego
P6-57 na `46636f3562d44afd74d3a6cd6f0585e2eab0c1a8`; queued nie kwalifikuje
native ABI. P6-58 nie zmienia C++ ani feature-gated native wrappera.

Aktualizacja P6-59: starszy build 189 running; build 190 cancelled jako
zastąpiony nowszym źródłem, build 191 queued. Szczegóły w
[P6-59](59-native-indexed-geometry-projection.md).

## Pozostałe prace

Managed native compilation/runtime, dowód live geometry/index association,
pełny CAS/FMS round-trip nowego mapped source, pomiary RAM, binary geometry
API i resource hooks, renderer z browser/WebGL oraz nauka/release pozostają
otwarte. Nie zwiększamy procentów przez sam dodatkowy source check.
