# Kontrakt napraw FDM: materiały i granice

Data: 2026-10-29
Zakres: planner FDM oraz wybór istniejącej ścieżki wykonawczej CUDA dla stykających się ciał. Nota implementacyjna. Zakres wykonanej weryfikacji i jej ograniczenia podano poniżej.

## Niezmienniki fizyczne i planistyczne

1. Przestrzenne `Aex` zachowuje każdą fizycznie zapisaną zmianę pola. Optymalizacja reprezentacji jako stałej może odrzucić wyłącznie różnice na poziomie błędu zaokrągleń względem skali `Aex`, a nie stały próg w jednostkach SI. Kontrakt planera jest względny: `|A-A0| <= 64 ε max(|A|, |A0|, MIN_POSITIVE)`.
2. Dla selektorów `RegionFrameIR::Object` próbka w układzie lokalnym wynosi `r_obj = r_world - T_object`. Ten sam `T_object` obowiązuje pola liniowe i radialne oraz stałe nadpisania przypisane regionowi. Pozostają bez zmian definicje regionu w geometrii i identyfikacja komórek.
3. DMI jest lokalnym oddziaływaniem chiralnym w obrębie ciała. Sam kontakt dwóch ciał nie tworzy sprzężenia chiralnego między nimi; jawne sprzężenia międzyciałowe są poza zakresem. CUDA nie może użyć jednego sąsiedztwa DMI dla komórek należących do różnych ciał. Dla kontaktu w płaszczyźnie X/Y dopuszczalna jest istniejąca ścieżka CUDA z osobnymi kontekstami per warstwa, jeżeli zachowuje obsługiwaną funkcję i nie wymusza CPU.

Normatywnym odniesieniem dla trzeciego punktu jest `docs/physics/regions/0461-multi-region-note-corrected.md`, sekcja 6.5: wartość i znak D należą do ciała, a sprzężenia chiralne między ciałami są odłożone.

## Zakres zmian i testów regresyjnych

- `fullmag-plan/src/fdm.rs`: względna tolerancja redukcji przestrzennego `Aex`; przekazanie translacji właściciela do resolvera próbek w single-grid FDM.
- `fullmag-plan/src/tests/material_audit_fdm.rs`: regresje na wartościach z planu dla małego niezerowego delta-A, pól Object-frame oraz stałego override regionu Object-frame po translacji.
- CUDA multilayer: kontakt komórek różnych ciał w osi X/Y nie może wejść w pojedyncze globalne sąsiedztwo DMI. Regresja ma sprawdzać wybór osobnych kontekstów i lokalne dane planu; nie zastępuje urządzeniowego testu fizycznego.

Regresje definiują wymagane wartości/ścieżkę przed zmianą implementacji. Dozwolone jest zachowanie odrębnych masek i osobnych próbek dla ciał. Niedozwolone jest scalanie wartości D przez granicę ciała ani ciche spłaszczenie małego delta-A.

## Dowody i ograniczenia

Użytkownik 29.10.2026 zezwolił na kompilację i wykonanie testów zadania. Pełny `fullmag-plan --lib`: 609 PASS. Dwie regresje runnera z feature `cuda`: PASS, w tym faktycznie wykonane przypadki styku X i Y na NVIDIA RTX 4080 SUPER, FP64, RK4, `dt=1e-13 s`, dwie komórki na ciało. Regresja porównuje końcowe składowe magnetyzacji CPU i `cuda_assisted_multilayer` z tolerancją bezwzględną `1e-6`; nie została pominięta przez warunek dostępności urządzenia.

To dowód istniejącej ścieżki hybrydowej CUDA z osobnymi kontekstami, nie nowej implementacji całkowicie urządzeniowego DMI. Ścieżka hybrydowa odświeża natywne konteksty GPU i wykorzystuje też lokalne obserwable CPU. Test ma wyłączoną demagnetyzację i wymianę. Kombinacja przesunięcia XY z demagnetyzacją nadal jest odrzucana jako niezakwalifikowana; nie zmieniono tego strażnika ani kontraktu BulkDmi. Parytet innych integratorów, precyzji, rozmiarów siatek i wszystkich oddziaływań pozostaje NOT VERIFIED.

Testy wykonano we własnej grupie `fullmag-worktree-fullmag-033f6660666cdc47`, ze źródła readonly `/opt/fullmag/source`, targetem `/build/material-audit-target` i natywną biblioteką FDM z pakietu tej grupy. Szczegóły zbiorcze: `docs/audits/material-boundaries-fixes-20261029.md`.
