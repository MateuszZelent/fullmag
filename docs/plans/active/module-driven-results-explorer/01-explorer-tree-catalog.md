# 01 — Katalog drzew modułów analizy

- Status: projekt do przeglądu (target-only)
- Kontrakt: [spec 32](../../../specs/frontend-v2/32-results-analysis-feature-modules.md)

Każdy moduł ma ten sam szkielet: **Overview → wykresy danych → wizualizacje
punktów → jakość**. Moduły różnią się tylko szablonami węzłów i widokami.
Oznaczenia instancjacji: `auto` — z danych, `opt` — z menu „Add…”, `user` —
z interakcji, zapisywane jako definicja.

## Poziom wspólny (kernel)

```
Results · <run>                         wybór wykonania (ResultContextSelector)
├ <węzły modułów dla każdego pasującego zbioru>
├ Dataset · brak modułu analizy          tylko dla zbiorów bez modułu; widok tabeli
├ Derived Values                        istniejące (dziś niedostępne: brak właściciela)
├ Tables                                istniejące (katalog tabel)
├ Exports                               istniejące (katalog artefaktów)
└ Saved views                           user
```

Zaznaczenie `Results · <run>`: widok z listą zbiorów i dopasowanych modułów.
Inspector pokazuje, dlaczego moduł pasuje albo nie pasuje (reguła i brakująca
właściwość zbioru).

## Moduł `analysis.dispersion`

Dopasowanie: `product_kind ∈ {modal_eigen, driven_response}` oraz kontekst k
`k_path` lub `k_grid`. Dla `driven_response` pojawia się mapa A(k, f) zamiast
gałęzi.

```
Dispersion · DE wzdłuż kᵧ                       auto   zbiór
├ Overview                                      auto
├ Dispersion relation                 [plot-1d] auto
│  ├ Computed branches                [feature] auto
│  ├ Reference · Kalinikos–Slavin n=0 [feature] user   (Add reference…)
│  ├ Imported · COMSOL sweep          [feature] user   (Import CSV/COMSOL…)
│  ├ Other run · finer mesh           [feature] user   (Compare with run…)
│  └ Δf vs reference                  [feature] opt    tylko gdy istnieje referencja
├ Iso-frequency contour               [plot-2d] opt    wymaga k_grid
├ Response map A(k, f)                [plot-2d] auto   tylko driven_response
├ Branches                            [data]    auto   tylko modal_eigen
│  └ Branch 1 · 9.30–13.50 GHz                  dynamiczne (stronicowane)
├ k samples                           [data]    auto
│  └ kᵧ +15 rad/µm → Mode 1 · 12.025 GHz        dynamiczne, mody po rozwinięciu
├ Mode visualizations                 [group]   auto
│  └ Branch 1 · kᵧ +15 rad/µm · 12.025 GHz  [field-3d] user (z punktu wykresu)
│     ├ Surface · Re mᵧ               [feature] auto przy utworzeniu
│     ├ Arrows                        [feature] opt
│     ├ Slice                         [feature] opt
│     └ Thickness profile             [feature] opt    unsupported do czasu kontraktu line-probe
└ Quality & provenance                [quality] auto
```

| Węzeł | Akcja zaznaczenia | Widok | Sekcje Inspectora | Ribbon (kontekstowy „Dispersion”) |
|---|---|---|---|---|
| Zbiór / Overview | — | podsumowanie: ścieżka k, zakres f, liczba próbek i modów, kompletność, solver | Study setup (read-only), Ranges, Completeness | Add plot ▾, Export data |
| Dispersion relation | wykres; klik punktu = zaznaczenie chwilowe | wykres f(k), oś kₓ/kᵧ/k_z lub długość ścieżki, etykiety punktów ścieżki | Axes, Series visibility, Selected point (chwilowe) | Add reference, Import, Compare run, Δf, Create mode visualization, Export figure |
| Reference / Imported / Other run | wyróżnia serię | ten sam wykres z wyróżnioną serią | Compare: model, parametry, geometria, bias, warunki brzegowe, zakres ważności, status porównania | Hide, Remove, Export comparison |
| Δf vs reference | — | wykres Δf współdzielący oś k | Gate (jeśli zdefiniowana w badaniu), Assumptions status | Export |
| Iso-frequency contour | — | mapa kₓ–kᵧ z izoliniami f | Levels, Frequency | Export |
| Branches / Branch | wyróżnia gałąź | wykres z wyróżnioną gałęzią | Tracking source, overlap, crossingi | — |
| k samples / próbka / mod | kursor k / punkt | wykres z kursorem | k vector, mody, f, Im f, residual | Create mode visualization |
| Mode visualizations | — | lista przypiętych wizualizacji | — | — |
| Wizualizacja modu | ustawia wielkość głównego viewportu na mod; wykres pokazuje przypięty punkt | główny `viewport-3d` z wielkością „Mode m̃”; z wykresem źródłowym zamiast, pod lub obok | kopia Inspectora wizualizacji ferromagnetyka (spec 32 §12): Display (chipy, tryb renderowania, Quantity source = mod), Surface coloring (+ część zespolona i składowa), Vectors, Phase & animation, Layout, Clipping & section, Camera & view, Recompute (osobno) | Quantity (mod aktywny), Layout, Animate, Export figure |

Wszystkie Inspectory w tej tabeli mają układ z spec 32 §12: identyfikacja,
cztery metryki, jedna główna karta, sekcje nawigacyjne z ikonami lucide i
zwinięty kontekst. To ten sam układ co Inspector ferromagnetyka w drzewie
modelu.
| Quality & provenance | — | tabela jakości próbek | Completeness, Tracking, Accuracy, Provenance | Export report |

## Moduł `analysis.resonance` (FMR i odpowiedź wymuszona)

Dopasowanie: `product_kind ∈ {modal_eigen, driven_response}` z kontekstem
`gamma` lub `finite_open`, albo oś pola bias.

```
Resonance · <badanie>
├ Overview
├ Spectrum                            [plot-1d] auto   absorpcja/odpowiedź vs f
├ Field–frequency map                 [plot-2d] auto   gdy jest oś pola bias
├ Peaks                               [data]    auto   adnotacje, nie byty solvera
├ Resonance fits · Kittel             [derived] opt
├ Mode visualizations                 [group]   auto
│  └ Peak 2 · 9.30 GHz                [field-3d] user  (z punktu widma)
└ Quality & provenance
```

## Moduł `analysis.hysteresis`

Dopasowanie: przyszły `product_kind` pętli histerezy (luka kontraktu).

```
Hysteresis · <badanie>
├ Overview                                      protokół pola
├ Loop M(H)                           [plot-1d] auto
├ Switching fields                    [derived] auto
├ State snapshots                     [group]   auto
│  └ H = −12 mT, gałąź malejąca       [field-3d] user  (z punktu pętli)
└ Quality & provenance
```

## Moduł `analysis.transmission`

Dopasowanie: przyszły `product_kind` transmisji (luka kontraktu).

```
Transmission · <badanie>
├ Overview                                      antena, porty
├ Transmission vs f                   [plot-1d] auto
├ Propagation length                  [derived] opt
├ Field at frequency                  [group]   auto
│  └ f = 10.2 GHz                     [field-3d] user
└ Quality & provenance
```

## Moduł `analysis.time-domain`

Dopasowanie: `product_kind = time_domain_spectrum` lub
`dynamic_structure_factor`.

```
Time domain · <badanie>
├ Overview
├ Traces                              [plot-1d] auto
├ FFT / PSD                           [plot-1d] auto
├ S(k, f)                             [plot-2d] auto   tylko dynamic_structure_factor
├ Snapshots                           [group]   auto
│  └ t = 1.20 ns                      [field-3d] user
└ Quality & provenance
```

Przykładowe wartości w drzewach innych niż dyspersja ilustrują strukturę i
nie pochodzą z wyników.

## Dane przykładu (pilot FEM)

Film 40 × 40 × 10 nm; Ms = 800 kA/m; A = 13 pJ/m; B₀ = 0,1 T ∥ x; k ∥ y
(Damon–Eshbach); exchange, demag, Zeeman; Floquet xy; skończony airbox
Dirichleta. Siedem punktów kᵧ: −25, −15, −5, 0, 5, 15, 25 rad/µm;
f ≈ 13,502304; 12,025067; 10,309812; 9,299250; 10,309817; 12,025103;
13,502167 GHz. Wynik `selected_only`: bez potwierdzonej kompletności pasm i
bez kwalifikacji naukowej. W pilocie nie ma siatki k 2D, więc „Iso-frequency
contour” jest wyszarzony z powodem.
