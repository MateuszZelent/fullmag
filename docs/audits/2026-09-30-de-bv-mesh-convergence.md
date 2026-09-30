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

## Diagnostyka jednorodnego profilu modu

Odczytano opublikowany vector.bin: node-major xyz, pary float64
real/imag little-endian, zgodnie z
crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs +
write_complex_vector_field_payload. Wektor zawiera fizyczne fazy Blocha,
odtworzone przez eigen_projection.rs +
project_complex_2x2_mode_to_tangent_basis_with_periodic_map.

Dla konwencji exp_minus_i_k_dot_delta_r usunięto fazę przez
$\mathbf u_i=\exp(+\mathrm{i}\mathbf k\cdot\mathbf r_i)\mathbf m_i$.
Wagi $w_i$ to suma $V_T/4$ po tetraedrach filmu przyległych do węzła.
Wyznaczono $\bar{\mathbf u}=\sum_iw_i\mathbf u_i/\sum_iw_i$ oraz

$$
C=\frac{(\sum_iw_i)\|\bar{\mathbf u}\|^2}
        {\sum_iw_i\|\mathbf u_i\|^2},\qquad
d=\sqrt{\frac{\sum_iw_i\|\mathbf u_i-\bar{\mathbf u}\|^2}
                   {\sum_iw_i\|\mathbf u_i\|^2}}.
$$

$C$ i $d$ są bezwymiarowe, $w_i$ ma jednostkę m3. To masa lumped,
nie dokładna norma consistent-mass FEM. Sprawdzono tożsamość
$C+d^2=1$ z błędem poniżej 1e-12. Metryki są niezależne od
globalnej zespolonej normalizacji i fazy modu.

| Mod / poziom | Nakładanie ze stałym wektorem C | Względne odchylenie RMS d |
| --- | ---: | ---: |
| DE L0 | 0.999830147 | 0.013032779 |
| DE L1 | 0.999804063 | 0.013997766 |
| DE L2 | 0.999842103 | 0.012565723 |
| BV L0 | 0.999965043 | 0.005912447 |
| BV L2 | 0.999998972 | 0.001013664 |

Wynik wspiera niemal jednorodny profil po usunięciu fazy Blocha,
zgodny z założeniem odniesienia n0. Nie dowodzi kolejności modów,
pokrycia okna widmowego ani identyfikacji najniższej gałęzi.
Nie zamyka zbieżności siatki/airboxu i nie zastępuje bezpośredniego
porównania COMSOL.

Zapisano mesh-mode-profile-diagnostic-20260930.json przy manifeście
runów, z SHA-256 czterech wejściowych artefaktów każdego runu.
Kwalifikacja pozostaje NOT VERIFIED.
