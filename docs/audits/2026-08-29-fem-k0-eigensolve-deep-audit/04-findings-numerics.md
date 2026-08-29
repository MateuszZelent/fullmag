# Audyt: problemy numeryczne

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 499–663.

### NUM-01 — P0 — SLEPc dostaje rzeczywisty target `+ω`, choć kod interpretuje wartości własne jako `λ≈±iω`

**Klasyfikacja:** błąd wyboru spektrum; **pewność:** potwierdzony.

**Dowód w implementacji.** Adapter ustawia `EPSSetTarget` na dodatnią wartość rzeczywistą i `EPS_TARGET_MAGNITUDE`; `map_eigenvalue` wyznacza częstotliwość z części urojonej `λ`. SLEPc definiuje target jako `PetscScalar`; target zespolony jest dostępny tylko w complex-scalar build.

**Dlaczego jest to błąd lub ograniczenie.** Shift-and-invert wyszukuje wartości najbliższe `σ`. Dla spektrum na osi urojonej odległość od realnego `+ω` nie odpowiada odległości częstotliwości od żądanego `ω`.

**Skutek.** Pominięte mody, zła kolejność i niestabilna zbieżność nearest-frequency.

**Naprawa.** Wybrać jeden z dwóch spójnych kontraktów: (a) przekształcić pencil tak, aby wartością własną była rzeczywista `ω`; albo (b) użyć PETSc/SLEPc complex i targetu `iω`. Dla real build można użyć strukturalnego przekształcenia, nie udawać targetu zespolonego.

**Test akceptacyjny.** Makrospin i wielomodowy problem z ciasnymi modami; target po obu stronach; mutation target real/imag.


### NUM-02 — P0 — Liczba pobranych par własnych nie gwarantuje spełnienia żądania po filtracji

**Klasyfikacja:** niepełny solve; **pewność:** potwierdzony.

**Dowód w implementacji.** Adapter prosi zwykle o `2*requested_positive_modes`, następnie odrzuca gałąź ujemną/zerową i może zwrócić sukces, gdy zaakceptowano co najmniej jeden mod.

**Dlaczego jest to błąd lub ograniczenie.** Degeneracje, pary sprzężone, mody zerowe i mody spoza okna mogą zużyć cały subspace. Stały mnożnik 2 nie jest dowodem kompletności.

**Skutek.** Request np. 8 modów może zwrócić 1–7 bez jawnego statusu partial.

**Naprawa.** Adaptacyjnie zwiększać `nev/ncv/mpd` aż do spełnienia żądania albo osiągnięcia jawnego limitu. Wynik ma zawierać `requested`, `converged`, `accepted`, `rejected_by_reason` i status partial.

**Test akceptacyjny.** Zdegenerowane klastry, zero modes, wiele ujemnych gałęzi i zbyt mały `ncv`.


### NUM-03 — P0 — Residual SLEPc z problemu zredukowanego nie jest residualem pełnego descriptor pencil

**Klasyfikacja:** niewłaściwy residual; **pewność:** potwierdzony.

**Dowód w implementacji.** Ścieżka sparse używa `EPSComputeError`; pełny model zawiera także równanie Poissona, gauge i coupling. W oracle Poisson-airbox istnieje osobna rekonstrukcja pełnego residualu, co potwierdza rozróżnienie.

**Dlaczego jest to błąd lub ograniczenie.** Mały residual Schura nie gwarantuje, że odzyskane `φ` spełnia Poissona, gauge i oryginalne bloki przy tolerancji użytej w wewnętrznych solve.

**Skutek.** Fałszywie „converged” mody i brak diagnostyki błędu demagu.

**Naprawa.** Po każdym kandydacie odtworzyć `q,φ` i obliczyć znormalizowane residuale wszystkich równań oryginalnego descriptoru oraz tangent leakage.

**Test akceptacyjny.** Celowo niedokładny Poisson KSP: reduced residual ma pozostać mały, a pełny residual ma odrzucić mod.


### NUM-04 — P0 — Diagnostyka publikuje `"complete": true` dla wyników niecertyfikowanych lub selected-only

**Klasyfikacja:** fałszywa kompletność; **pewność:** potwierdzony.

**Dowód w implementacji.** Ścieżki nearest, tiny-validation i część full-window ustawiają ogólne `complete:true`, nawet gdy `window_completeness` ma stan `not_certified`, `partial_convergence` albo wynik jest obcięty.

**Dlaczego jest to błąd lub ograniczenie.** Sukces solve, obecność wybranego moda i kompletność spektrum to trzy różne twierdzenia.

**Skutek.** API/UI może opisać pierwszy dostępny mod jako pełne widmo lub rezonans.

**Naprawa.** Usunąć niejednoznaczne pole. Wprowadzić niezależne `solve_status`, `selection_scope`, `window_status`, `certificate_id`; `nearest` zawsze `selected_only`.

**Test akceptacyjny.** Schema tests i negatywne przypadki: truncation, partial convergence, cancelled, missing subwindow.


### NUM-05 — P0 — Partitioning okna nie potrafi potwierdzić kompletności

**Klasyfikacja:** brak certyfikatu okna; **pewność:** potwierdzony.

**Dowód w implementacji.** `window_partition.cpp` pozostawia subwindow jako uncertified i `certification_method="none"`, mimo że wyższa warstwa może zakończyć się sukcesem.

**Dlaczego jest to błąd lub ograniczenie.** Złożenie kilku lokalnych nearest solves nie dowodzi, że między shiftami nie ma pominiętych wartości własnych.

**Skutek.** Dziury w widmie i fałszywy full-window.

**Naprawa.** Dla realnego `ω` użyć spectrum slicing/interwału; dla regionu zespolonego SLEPc CISS/RG z niezależnym count convergence. Każde podokno musi mieć receipt count, overlap i boundary handling.

**Test akceptacyjny.** Sztuczne spektrum z modem dokładnie między shiftami i na granicy podokien.


### NUM-06 — P1 — Konwencja fazy nie jest konsekwentnie propagowana do adaptera i artefaktów

**Klasyfikacja:** utrata metadanych; **pewność:** potwierdzony.

**Dowód w implementacji.** Część wrapperów hardcoduje lub pomija phase convention, podczas gdy `map_eigenvalue` od niej zależy.

**Dlaczego jest to błąd lub ograniczenie.** Ta sama para algebraiczna może zostać sklasyfikowana jako dodatnia lub ujemna zależnie od fazora.

**Skutek.** CPU, oracle i przyszły GPU mogą publikować przeciwne znaki.

**Naprawa.** Jedno pole w kanonicznym request; brak defaultu po przekroczeniu granicy ABI; echo w result/manifest.

**Test akceptacyjny.** Round-trip request→native→artifact oraz cross-engine parity dla obu konwencji.


### NUM-07 — P0 — Contour solver utożsamia rangę projekcji z liczbą modów

**Klasyfikacja:** wadliwy certyfikat algorytmiczny; **pewność:** potwierdzony.

**Dowód w implementacji.** Dla ogólnego payloadu `estimated_mode_count` i stabilność contour opierają się zasadniczo na `projection_rank` tej samej projekcji, z której budowane są Ritz pairs.

**Dlaczego jest to błąd lub ograniczenie.** To nie jest niezależne zliczenie spektralne. Ranga może być zaniżona przez pechowy probe, kondycję lub tolerancję i zawyżona przez szum.

**Skutek.** Fałszywy completeness certificate.

**Naprawa.** Oznaczyć obecny solver jako bounded validation-only. Produkcyjnie użyć dojrzałego CISS/spectrum slicing z powtarzanymi contourami, niezależnym count convergence i residualem.

**Test akceptacyjny.** Spektrum z wielokrotnością, ciasnym klastrem i probe ortogonalnym do podprzestrzeni.


### NUM-08 — P0 — Contour solver po cichu luzuje residual co najmniej do `1e-7`

**Klasyfikacja:** naruszenie tolerancji użytkownika; **pewność:** potwierdzony.

**Dowód w implementacji.** Akceptacja używa `max(requested_tolerance, 1e-7)`.

**Dlaczego jest to błąd lub ograniczenie.** Request `1e-10` nie oznacza wtedy `1e-10`. Solver nie może deklarować osiągnięcia tolerancji, której nie sprawdził.

**Skutek.** Niespójne residuale między silnikami i fałszywe qualification.

**Naprawa.** Nigdy nie luzować tolerancji bez jawnej polityki. Jeżeli algorytm ma floor, zwrócić `unsupported_tolerance` albo `partial` z osiągniętą wartością.

**Test akceptacyjny.** Requesty 1e-4, 1e-7, 1e-10; status i raportowana tolerancja muszą być zgodne.


### NUM-09 — P1 — Część limitów iteracji contour jest tylko walidowana lub raportowana

**Klasyfikacja:** martwe limity; **pewność:** potwierdzony.

**Dowód w implementacji.** `max_outer_iterations` i `max_linear_iterations` nie sterują odpowiednio realnym refinement/iterative solve; implementacja używa bezpośrednich gęstych rozwiązań.

**Dlaczego jest to błąd lub ograniczenie.** Limit ma chronić czas i umożliwiać cancellation. Pole bez wpływu na algorytm jest złamanym kontraktem.

**Skutek.** Nieprzewidywalny runtime i myląca telemetria.

**Naprawa.** Usunąć parametry z bounded oracle albo zaimplementować algorytm, który ich przestrzega i raportuje każdą iterację.

**Test akceptacyjny.** Budżet 0/1/mały musi deterministycznie zakończyć solve z poprawnym reason.


### NUM-10 — P1 — Własne gęste solve używają absolutnych progów pivotu bez skalowania

**Klasyfikacja:** stabilność numeryczna; **pewność:** potwierdzony.

**Dowód w implementacji.** Contour, Schur i CUDA oracle mają bardzo małe absolutne progi pivotu i ręczną eliminację Gaussa.

**Dlaczego jest to błąd lub ograniczenie.** Jednostki operatora oraz skalowanie bloków mogą zmieniać rzędy wielkości. Absolutny próg nie mierzy kondycji macierzy.

**Skutek.** NaN/Inf, niestabilne wyniki albo akceptacja źle uwarunkowanego solve.

**Naprawa.** Dla oracle użyć LAPACK/cuSOLVER z pivotingiem i estymacją kondycji; skalować bloki. Produkcyjnie PETSc KSP/PC z monitorami.

**Test akceptacyjny.** Diagonal scaling 1e±12 nie może zmieniać fizycznych wartości po odskalowaniu.


### NUM-11 — P1 — Raport `linear_iterations_total` może zawierać tylko ostatni solve

**Klasyfikacja:** niepełna telemetria; **pewność:** potwierdzony w kodzie, znaczenie zależy od konfiguracji KSP.

**Dowód w implementacji.** Adapter pobiera `KSPGetIterationNumber` po eigensolve zamiast akumulować iteracje wszystkich wywołań shift-invert przez monitor.

**Dlaczego jest to błąd lub ograniczenie.** W procesie EPS KSP jest wywoływany wielokrotnie. Stan po solve nie jest z definicji sumą całej pracy.

**Skutek.** Błędne porównania CPU/GPU i fałszywe budżety wydajności.

**Naprawa.** KSP monitor z licznikiem per solve i sumą; raportować count, min/max/mean, failed solves i setup time.

**Test akceptacyjny.** Known multi-solve fixture porównujący telemetrykę z logiem PETSc.
