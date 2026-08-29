# Audyt: problemy fizyczne linearizacji

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 379–498.

### PHY-01 — P0 — `m0` jest renormalizowane bez ponownego obliczenia `H_eff0`, demagu i energii

**Klasyfikacja:** błąd fizyczny; **pewność:** potwierdzony.

**Dowód w implementacji.** `build_linearization_state_from_equilibrium` normalizuje każdy wektor `m0`, gdy `allow_m0_renormalization=true`, po czym kopiuje niezmienione `h_eff0` i `h_demag0` z artefaktu.

**Dlaczego jest to błąd lub ograniczenie.** Operator liniowy musi być pochodną w tym samym punkcie, dla którego wyznaczono pole statyczne. Zmiana `m0` zmienia anizotropię, wymianę, DMI, demag i warunek styczności. Nawet mała korekta łamie ścisłą tożsamość stanu i jego Hessianu.

**Skutek.** Przesunięte częstotliwości, sztuczne mody niestabilne/zerowe i niereprodukowalny residual.

**Naprawa.** Domyślnie fail-closed. Jeżeli renormalizacja ma być wspierana, utworzyć nowy artefakt równowagi, przeliczyć wszystkie składniki `H_eff0`, energię i certyfikat, nadać nową tożsamość, a dopiero potem liniaryzować.

**Test akceptacyjny.** Mutation test z odchyleniem normy; przy renormalizacji musi zmienić się digest i pola statyczne, a bez recompute solve ma zostać odrzucony.


### PHY-02 — P0 — Opcje periodyczności i recompute są deklarowane, ale ignorowane

**Klasyfikacja:** martwe zabezpieczenia fizyczne; **pewność:** potwierdzony.

**Dowód w implementacji.** `LinearizationBuildOptions` zawiera `periodic_seam_tolerance`, `require_symmetric_periodic_mesh` i `recompute_h_eff0_and_compare`, lecz `build_linearization_state_from_equilibrium` ich nie używa.

**Dlaczego jest to błąd lub ograniczenie.** Konfiguracja sugeruje, że wykonano kontrolę szwu, symetrii domeny i niezależny recompute pola. W rzeczywistości żaden z tych warunków nie chroni operatora.

**Skutek.** Fałszywy certyfikat, szczególnie groźny dla PBC i starego/stale `H_eff0`.

**Naprawa.** Każdą opcję albo usunąć z publicznego kontraktu, albo egzekwować i zapisywać wynik testu w certyfikacie. Dla PBC weryfikować bijekcję węzłów, translację, orientację i zgodność regionów.

**Test akceptacyjny.** Mutation test dla każdej opcji; ustawienie na `true` musi powodować dodatkową kontrolę i odrzucenie wadliwego fixture.


### PHY-03 — P0 — `accepted_for_linearization` i dostarczone `H_eff0` są traktowane jako zaufana prawda

**Klasyfikacja:** błąd kwalifikacji równowagi; **pewność:** potwierdzony.

**Dowód w implementacji.** Kod wymaga flagi i obecności pól, ale nie oblicza ponownie pola tym samym operatorem ani nie porównuje składników fizyki z requestem.

**Dlaczego jest to błąd lub ograniczenie.** Certyfikat liniaryzacji powinien dowodzić, że `m0` jest punktem stacjonarnym dokładnie tego dyskretnego funkcjonału, który różniczkuje eigensolver. Flaga pochodząca z innego solvera, meshu lub ustawień nie jest takim dowodem.

**Skutek.** Możliwe liniaryzowanie wokół nie-równowagi lub wokół pola z innej konfiguracji.

**Naprawa.** Wprowadzić `LinearizationCertificate` tworzony przez niezależny recompute: składniki `H_eff`, dyskretny residual styczny, mesh/material/physics/boundary digest, wersję operatora i tolerancje.

**Test akceptacyjny.** Podmiana jednego składnika fizyki, regionu, BC lub meshu musi unieważnić certyfikat mimo zachowania flagi.


### PHY-04 — P1 — Torque residual jest czysto nodalny i nieważony

**Klasyfikacja:** niewłaściwa norma; **pewność:** potwierdzony.

**Dowód w implementacji.** Kod liczy maksimum `|m×H|/max(|H|,1 A/m)` po węzłach; nie używa masy FE ani residualu dyskretnego równania.

**Dlaczego jest to błąd lub ograniczenie.** Taki wskaźnik zależy od rozkładu węzłów i może nadmiernie ważyć drobne elementy lub ukrywać błąd objętościowy. Jest użyteczny jako diagnostyka punktowa, ale nie jako jedyny certyfikat stacjonarności.

**Skutek.** Brak porównywalności między siatkami i możliwa fałszywa akceptacja.

**Naprawa.** Publikować co najmniej: ważony masą `L2`, `L∞`, residual algebraiczny w przestrzeni stycznej i residual względny względem skali wszystkich składników pola. User stop i qualification threshold pozostawić osobnymi wartościami.

**Test akceptacyjny.** Refinement study: norma certyfikacyjna ma być stabilna wobec nierównomiernego zagęszczenia.


### PHY-05 — P0 — `tangent_lumped_mass` jest wypełnione jedynkami

**Klasyfikacja:** błąd dyskretyzacji/metadanych; **pewność:** potwierdzony.

**Dowód w implementacji.** `out_state.tangent_lumped_mass.assign(node_count, 1.0)` niezależnie od geometrii i elementów.

**Dlaczego jest to błąd lub ograniczenie.** Masa lumped reprezentuje objętość przypisaną DOF. Jedynki są poprawne wyłącznie dla sztucznego, równomiernego modelu bez jednostek. Błędna masa zniekształca normy, overlap, normalizację, deduplikację i tracking modów.

**Skutek.** Mesh-dependent amplitudy, błędne podobieństwo modów i niestabilna identyfikacja klastrów.

**Naprawa.** Zmontować rzeczywistą skalarową macierz masy FE i jej lumping; dla dwóch współrzędnych stycznych użyć odpowiedniego bloku. Zapisać digest masy w artefakcie.

**Test akceptacyjny.** Znane objętości Tet4/Prism6, suma mas równa objętości magnetyka, dodatniość oraz invariance overlap przy refinement.


### PHY-06 — P0 — Identyfikatory magnetic mesh, airbox mesh, `phi0` i liczba węzłów airboxa nie są wiązane

**Klasyfikacja:** niepełna tożsamość fizyczna; **pewność:** potwierdzony.

**Dowód w implementacji.** Pola istnieją w `EquilibriumArtifactDescriptor`, ale builder nie waliduje ich i nie przenosi do `LinearizationStateNative`/signature.

**Dlaczego jest to błąd lub ograniczenie.** Dynamiczny demag zależy od wspólnej topologii magnetyk–airbox, przestrzeni potencjału, gauge i warunków brzegowych. Sam `mesh_snapshot_id` nie dowodzi, że bloki sprzęgające odpowiadają temu samemu airboxowi.

**Skutek.** Stale lub skrzyżowane artefakty mogą przejść preflight.

**Naprawa.** Jedna niepodzielna tożsamość domeny: magnetic topology, airbox topology, embedding map, boundary/gauge certificate, DOF ordering i generation counters.

**Test akceptacyjny.** Każda zamiana airboxa, mapy osadzenia lub gauge musi odrzucić request przed solve.


### PHY-07 — P0 — Nieznana konwencja fazy może zostać potraktowana jako `exp(-iωt)`

**Klasyfikacja:** błąd konwencji fazy; **pewność:** potwierdzony.

**Dowód w implementacji.** W dynamic-pencil helperze wybór znaku ma ścieżkę `exp(+iωt)` versus „wszystko inne”, zamiast wyczerpującego switcha z błędem.

**Dlaczego jest to błąd lub ograniczenie.** Znak fazora ustala znak członu `iω`, wybór dodatniej gałęzi i interpretację real/imag. Cichy fallback może odwrócić częstotliwość i precesję.

**Skutek.** Niespójne wykresy, zła gałąź dodatnia oraz CPU/GPU pozornie różniące się znakiem.

**Naprawa.** Wymagany enum, exhaustive switch, fail-closed dla wartości nieznanej. Konwencja musi być zapisana w request, operatorze, result i artefakcie pola.

**Test akceptacyjny.** Negatywny enum, obie konwencje na makrospinie i test transformacji zespolonego sprzężenia.


### PHY-08 — P1 — Baza styczna skacze przy `|m_z|=0.9`

**Klasyfikacja:** gauge bazy stycznej; **pewność:** potwierdzony.

**Dowód w implementacji.** `build_tangent_frame` wybiera referencję `z` lub `y` na podstawie progu `abs(m[2]) < 0.9`, niezależnie dla każdego węzła.

**Dlaczego jest to błąd lub ograniczenie.** Baza lokalna ma swobodę gauge, ale skok referencji powoduje gwałtowny obrót współrzędnych `q` dla gładkiego `m0`. Widmo pozostaje niezmienne tylko przy konsekwentnej transformacji wszystkich bloków. Tracking i interpolacja samych współrzędnych stycznych mogą stać się nieciągłe.

**Skutek.** Niestabilne overlap i phase tracking między sweepami, artefakty przy wizualizacji lub rekonstrukcji z innego frame buildera.

**Naprawa.** Albo śledzić/porównywać mody wyłącznie po podniesieniu do kartezjańskiej przestrzeni FE, albo budować frame przez parallel transport na spójnych komponentach i zapisywać jego digest.

**Test akceptacyjny.** Gładki sweep przez próg 0.9 nie może powodować skoku fizycznego pola ani subspace overlap.
