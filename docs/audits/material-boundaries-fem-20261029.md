# Kontrakt napraw FEM: materiał, identyfikatory regionów i kontakt

Data: 2026-10-29
Zakres: planner FEM, przekazanie próbek materiału i walidacja konforemnego mesh asset. Nota implementacyjna; nie stanowi dowodu kompilacji, wykonania CPU/GPU ani walidacji naukowej.

## Niezmienniki

1. Dla materiału z aktywną anizotropią kubiczną dwa różne układy osi krystalograficznych nie mogą zostać uznane za jeden materiał FEM tylko dlatego, że równe są $M_s$, $A$, $\alpha$ i parametry anizotropii jednoosiowej. Obecny ABI przenosi wspólne osie jako pojedynczy układ dla całego planu; różne aktywne ramy są więc odrzucane, bez nowego pola ABI. Gdy tylko późniejszy obiekt aktywuje anizotropię kubiczną, jego rama może zostać szablonem całego planu, a istniejące współczynniki pozostałych obiektów pozostają polami per-węzeł.
2. `region_id` jest kanoniczną tożsamością. Dokładne dopasowanie ID ma pierwszeństwo przed kolidującą nazwą prezentacyjną. Nazwa jest aliasem tylko wtedy, gdy jednoznacznie wskazuje jeden aktywny region; alias wieloznaczny powoduje błąd planowania.
3. Pole `MeshRelative` jest próbkowane z lokalną skalą węzła: $h_i=\min\{\lVert x_i-x_j\rVert_2: j\ne i,\; i,j\text{ należą do wspólnego elementu}\}$. Dla `cells=n` szerokość przejścia w próbce $i$ wynosi $w_i=n h_i$. Węzeł bez sąsiada w elemencie nie dostaje wymyślonego kroku siatki; resolver ma odrzucić wymagane próbkowanie, jeśli skali nie można wyznaczyć. To przybliżenie lokalnej rozdzielczości siatki, a nie metryka krzywizny ani gwarancja błędu aproksymacji.
4. Packer rozdziela węzły różnych obiektów magnetycznych przy kontakcie ścianą. Dopóki ten podział nie ma spójnego kontraktu faset i przestrzeni, planner odrzuca dokładnie wspólną ścianę różnych `object_id`. Nie skleja stopni swobody magnetyzacji i nie modyfikuje operatora Poissona. Granice magnet–powietrze oraz różne regiony tego samego obiektu pozostają poza tym odrzuceniem.
5. Naprawy nie zmieniają semantyki Python ani schematu `ProblemIR`; ograniczają planowanie do przypadków, których obecny kontrakt materiału i mesh może jednoznacznie opisać.

Dla przykładu rozróżniającego ramy, przy $K_{c1}>0$ przyjmujemy
\[
E_{c1}=K_{c1}(m_1^2m_2^2+m_2^2m_3^2+m_1^2m_3^2),
\]
przy czym $m_i=\mathbf m\cdot\mathbf a_i$. Dla $\mathbf m=(1,0,0)$ rama $(\mathbf a_1,\mathbf a_2)=(\hat x,\hat y)$ daje $E_{c1}=0$, a obrócona rama $\mathbf a_1=(\hat x+\hat y)/\sqrt2$, $\mathbf a_2=(-\hat x+\hat y)/\sqrt2$ daje $E_{c1}=K_{c1}/4$. Te same skalarne współczynniki nie oznaczają tego samego prawa materiałowego.

## Zakres realizacji

| Realizacja | Stan po zmianie |
|---|---|
| FEM CPU | Planner odrzuca odmienne aktywne ramy kubiczne i kontakt różnych obiektów ścianą; rozwiązanie fizyczne pozostaje niezweryfikowane. |
| FEM GPU | Ten sam kontrakt planera; brak nowego ABI ani dowodu urządzeniowego/parytetu. |
| FDM CPU | Bez zmian w tym zestawie; poza zakresem tej noty. |
| FDM GPU | Bez zmian w tym zestawie; poza zakresem tej noty. |

Nie zmieniają się warunki naturalne DMI, ciągłość/strumień wymiany ani obsługa warunków Dirichleta/Robina, PBC/Floquet i anizotropii powierzchniowej. Nota nie kwalifikuje tych interakcji ani rodzin demagnetyzacji.

## Mapowanie źródeł i regresji

- `crates/fullmag-plan/src/fem.rs::plan_fem`, `heterogeneous_fem_material_shape_supported`: wybór lub jawne odrzucenie wspólnego prawa materiałowego.
- `crates/fullmag-plan/src/fem.rs::build_region_material_fields`: próbkowanie pól w węzłach FEM i przekazanie lokalnych skal siatki.
- `crates/fullmag-plan/src/fem.rs::build_conformal_region_element_fields`: sharp `Ms`/`Aex` w polu elementowym DG0.
- `crates/fullmag-plan/src/mesh.rs::resolve_object_region_marker`, `resolve_fem_domain_mesh_asset`, `validate_domain_object_region_identity`, `pack_mesh_by_analysis`: rozstrzyganie markerów i kontrakt kontaktu.
- `crates/fullmag-plan/src/validate.rs::region_is_conformal`: klasyfikacja realizacji musi korzystać z tej samej kanonicznej tożsamości i nie uznawać wieloznacznego aliasu.
- `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp::collect_boundaries`: ograniczenie topologii faset akceptowanej przez natywny builder.
- `crates/fullmag-plan/src/tests/material_audit_fem.rs`: regresje źródłowe dla ram 45°, kolizji ID/nazwy z sharp DG0, aliasu niejednoznacznego i kontaktu obiektów. Testy planera wykonano; wynik zbiorczy poniżej.

## Dowody i ograniczenia

Źródła uzasadniają plannerowe strażniki i zgodność struktur przekazywanych dalej; nie dowodzą energii CPU, działania GPU, ciągłości pola demagnetyzacji, zbieżności ani zgodności wyników naukowych. Zmiana szerokości `MeshRelative` jest zmianą próbkowania istniejącej aproksymacji smoothstep, nie nową aproksymacją zwalidowaną numerycznie. Użytkownik odwołał zakaz na potrzeby zadania. Pełny zestaw `fullmag-plan --lib` zakończył się 609 PASS we własnej grupie Docker. Nie wykonano w tej poprawce kwalifikacji fizycznego solvera FEM CPU/GPU; wyniki planera nie zastępują takiej kwalifikacji. Kanoniczne ID nieaktywnego regionu także nie może zostać zinterpretowane jako alias innego aktywnego regionu.
