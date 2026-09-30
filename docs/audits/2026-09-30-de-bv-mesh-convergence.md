# Kontrola siatki DE/BV przy k=25 rad/µm - 2026-09-30

Runtime managed #167 (a745f5e241dc497fad98c10c2c11cb13), model
9ba84d078cfa1cfc47ccc6ea6374639115dfe120. Rozmiar elementów
magnetycznych/interfejsu: L0=10 nm, L1=7.5 nm, L2=5 nm.
Geometria, materiał, bias, airbox i progi fizyczne pozostały te same.

| Geometria | Siatka | Częstotliwość GHz | Różnica z analityką n0 |
| --- | --- | --- | --- |
| DE | L0 | 13.384204251 | -2.118376% |
| DE | L1 | 13.436508613 | -1.736% |
| DE | L2 | 13.578981799 | -0.694% |
| BV | L0 | 9.664769493 | -0.981155% |
| BV | L1 | FAIL | brak zaakceptowanego modu |
| BV | L2 | 9.740140954 | -0.209% |

DE L1: 3279 węzłów / 10776 tetraedrów; DE L2:
7241 / 28217, wobec L0 1980 / 5720. Udane nowe runy:
6e5a375030a4423b895c0a9bac778349 (DE L1),
23515def29a842e9affc00a9fbd5d6a3 (DE L2),
ff1ecf50a4644d519cd82c4e91febfe7 (BV L2).
Status completed_unqualified, exit 0. Kontrole modalne, rozwiązania
ustawień siatki i rekonstrukcji pola z potencjału przeszły.
Niezmieniony próg modalny: 1e-8.

BV L1 (210709906e8140ecb5ce6c636396c9f4) z restartem 8 nie uzyskał
zaakceptowanego modu. SLEPc osiągnął limit 2000 iteracji; ostatnie
oszacowanie pierwszej niezbieżnej pary 1.08684e-10 wobec prefiltra 1e-10.
Kandydat 9.692659902 GHz nie jest zaakceptowanym punktem.
Kontrola restartu 10 przy identycznych progach także zakończyła się failed, exit 1: run 96673c3616e64a4f909a5eb3b96fcff8. Nie ponawiać tego samego eksperymentu bez nowej hipotezy.

## Wnioski i pozostałe kontrole

Rafinacja przesuwa wyniki w stronę analityki, ale nie dowodzi zbieżności.
Przesunięcie DE L1-L2 jest większe niż L0-L1; nie wykonywać
ekstrapolacji Richardsona. Potrzebna kontrola jakości i geometrii siatki,
profilu modu po grubości, dalszej rafinacji i niezależnej zmiany airboxu.
Analityka n0 zakłada jednorodny profil po grubości i nie musi być
dokładnym limitem pełnego operatora FEM. Kwalifikacja: NOT VERIFIED.

Manifest mesh-convergence-20260930.json i wszystkie artefakty znajdują się
pod storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/
a745f5e241dc497fad98c10c2c11cb13/comsol-dispersion/.

Wrapper odrzuca brakujące/wadliwe metadane siatki kontrolowanym błędem.
Skupione testy interpretowane: 34 PASS i 7 podtestów PASS.
Nie kompilowano natywnych testów jednostkowych.

## Kontrola rzeczywistej dyskretyzacji i preconditionera

Z współrzędnych i łączności tetraedrów zapisanych w metadata.json
wybrano komórki, których wszystkie wierzchołki leżą w filmie
(abs(z) <= 5 nm + 1e-15 m). Suma bezwzględnych objętości wynosi
1.6e-23 m3 na wszystkich poziomach, zgodnie z 40 x 40 x 10 nm.
To kontrola objętości i dyskretyzacji; nie certyfikuje całej jakości siatki.

| Poziom | Tetraedry filmu | Mediana krawędzi nm | 95 percentyl nm | Maksimum nm |
| --- | ---: | ---: | ---: | ---: |
| L0 | 191 | 9.8964 | 13.3397 | 14.2184 |
| L1 | 354 | 7.3868 | 12.5144 | 13.0783 |
| L2 | 791 | 5.7115 | 8.2713 | 10.5586 |

Zadany rozmiar elementu nie jest dowodem twardego ograniczenia każdej
krawędzi; wykres podpisuje go jako rozmiar zadany. Najmniejsza
bezwzględna objętość tetraedru jest dodatnia na każdym poziomie.

Diagnostyka potwierdza zmianę realizacji preconditionera: L1 (192 tangent
DOF, 384 real-split) używa exact_schur_materialized, natomiast L2
(422 tangent DOF, 844 real-split) magnetic_only. Limit materializacji
wynosi 512. Obie realizacje stosują matrix-free operator fizyczny;
nie wolno przypisywać poprawy iteracyjnej wyłącznie siatce.
Kwalifikacja preconditionera dla dużego A1 nadal pozostaje otwarta.

Trzeci eksperyment BV L1: KSP rtol zaostrzono z 1e-11 do 1e-12,
restart 8, EPS prefilter 1e-10, próg modalny 1e-8. Run
f81f518b3e1748f4a424444cafd6d8d8 zakończył się failed, exit 1.
Nie zamyka to hipotezy kondycji/preconditionera, ale nie wspiera naprawy
przez samo zaostrzenie tolerancji wewnętrznej.

Wykres i dane kontrolne: folder de-bv-mesh-20260930 w katalogu
wizualizacji tego wątku, pliki mesh-convergence.png/PDF i comparison.json.
