# Plan rozszerzenia mixed-P1 dla warstw i rozłącznych regionów materiałowych

- **Status:** propozycja dokumentacyjna; niezaimplementowana i niezakwalifikowana.
- **Data:** 2026-10-16.
- **Zakres zapisu:** nota naukowa, mapa źródeł i plan wdrożenia; implementacja i kwalifikacja G1–G7 pozostają otwarte.
- **Powiązana nota:** `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`.
- **Cel:** przygotować legalną, fail-closed ścieżkę dla niezmienionego przykładu `examples/permalloy_layer_cofeb_rings_relax_300nm.py`, bez zmiany jego geometrii, parametrów ani żądania GPU.

## Zakres naukowy i wejście referencyjne

Przykład ma aktywną warstwę `Box` oraz aktywny górny pierścień CSG zbudowany jako różnica dwóch cylindrów i przesunięty w przestrzeni. Dolny pierścień pozostaje zakomentowany. Oryginalne źródło ma SHA-256 `86c67df4c48c04bf2e4b51ed54ceb61ab6ef4667de4be2adb54eb31e82334797` i musi pozostać niezmienione. Obydwa aktywne obiekty są rozłączne i muszą mieć dodatnią, certyfikowaną separację. Ogólny kontrakt nie może rozpoznawać ich po nazwach ani wymagać dokładnie dwóch obiektów; liczba regionów wynika z certyfikowanej geometrii.

Zakładany zakres fizyczny:

- P1 nodal H1 dla wszystkich elementów; warstwa pozostaje prism6, pierścień może używać tet4, a przejście w powietrzu może używać pyramid5/tet4.
- `Ms`, `Ku1`/`Ku2`, `axis` i `alpha` są polami nodalnymi P1 per region. `Aex` jest jedną dodatnią stałą współdzieloną przez regiony. Nie wprowadzać DG0 ani ukrytego uśredniania między materiałami.
- Demagnetyzacja pozostaje skalarnym Poissonem z istniejącym warunkiem Robin na wspólnej domenie. Źródło RHS obejmuje wyłącznie komórki magnetyczne; powietrze nie dostaje prawa materiałowego.
- `alpha` musi przejść walidację i provenance, ale nie może zostać po cichu użyte lub pominięte w statycznym pochodnym PG-BB. Jego użycie w przyszłym dynamicznym LLG wymaga osobnej bramki.
- `study.device("gpu", precision="double")`, strict, FEM GPU i PG-BB pozostają wymagane. Nie ma cichego fallbacku CPU, zmiany na FDM, DMI, DG0, PBC, termiki ani zmiany skryptu.

## Granica obecnego kodu

Obecna bramka Python `packages/fullmag-py/src/fullmag/model/problem.py::_validate_authored_mixed_p1_scope`, planner w `crates/fullmag-plan/src/mesh.rs::validate_mixed_p1_execution_scope` i natywna walidacja `backends/fem/core/fem_mesh.cpp::validate_supported_physics_topology` ograniczają mixed-P1 do jednej geometrii/materialu. Odrzucenie `material_count_not_one` dla oryginalnego przykładu jest więc prawidłowe i nie jest dowodem błędu w samym skrypcie. Aktualna pierwsza warstwa capability pozostaje bez zmian; plan nie podnosi statusu runtime.

Nie należy rozszerzać guardu przez samą zmianę limitu `1` na `2`. Najpierw trzeba certyfikować regiony, markery, rozłączność, pola i ownership operatorów, a następnie użyć wersjonowanego `MixedLayerTopologyCertificateV2IR` w tej samej rodzinie certyfikatów. `MixedLayerTopologyCertificateV1IR` zachowuje obecne znaczenie i kompatybilność first-slice; nie wolno rozszerzać go in place ani odczytywać payloadu V2 jako V1. Nie tworzyć nowego publicznego backendu ani profilu nazwanego od pierścienia.

## Kolejność implementacji

### 1. Wykonalność meshera, Python authoring → ProblemIR

Pierwszym krokiem implementacyjnym po nocie jest izolowana wykonalność
meshera: zachować `Box` jako prism6, zrealizować przesuniętą różnicę
cylindrów wokół osi X jako tet4, a powietrze jako pyramid5/tet4, z zachowaniem
per-object controls i markerów. Zachować authored Gmsh 4.15.2 `Mesh.Algorithm3D=10`
i `optimizeGmsh`; dowód musi konstruktywnie certyfikować przejście pyramid5
z trójkątnej granicy zewnętrznej oraz HXT10 free-air/ring tet4, bez polegania
na automatycznych piramidach HXT ani cichym fallbacku do Delaunay1. Ten krok
nie rozszerza jeszcze ogólnego CSG.

Zachować drzewo operandów CSG, transformacje, `object_id`, nazwy oraz przypisania materiałów. Wykorzystać istniejące `MaterialParameterField`, `MaterialParameterAssignment`, `MaterialParameterNameIR` i `set_material_field`. Każdy segment geometrii musi mieć jawny region marker. IR ma zachować requested device, resolved execution, strictness, precision, source identity oraz wszystkie przypisania pól.

Bramki:

- round-trip Python → IR → Python zachowuje CSG, object IDs, transformacje i field payloads;
- brak anonimowego scalania regionów po nazwie lub kolejności listy;
- brak `material_count_not_one` po spełnieniu certyfikatu regionów, ale zachowanie tego błędu dla niecertyfikowanych wejść;
- niezmieniony skrypt referencyjny ma być wejściem testu, a nie generowanym wariantem.

### 2. CSG, siatka i wersjonowany mixed certificate V2

Zdefiniować `MixedLayerTopologyCertificateV2IR` jako wersjonowanego następcę
w tej samej rodzinie, z kompatybilnym odczytem istniejącego V1. V2 ma przenosić
deterministyczne dane regionów: marker, object ID, typ elementu, ownership
węzłów/komórek, separację, conforming H1 traces na granicach region–powietrze,
uporządkowany digest pól oraz relację do source/mesh digest. Zachować jawne
dispatch V1/V2 i odrzucać nieznane pola; V1 nie może udawać regionalnego V2.
Writers, loaders i trusted-cache path muszą odrzucać brak lub złą wersję V2
oraz payload V1 podszywający się pod V2. Canonical V2 digest projection musi
w deterministycznej kolejności obejmować ownership regionów, komórek i węzłów,
pola `Ms`, `Ku1`, `Ku2`, `alpha`, authored/planner-normalized `axis`, dodatnią
separację oraz identity operatora i schematu. Obecny `_semantic_manifest_sha256`
nie obejmuje tych pól i nie może sam autoryzować V2.

Certyfikat odrzuca:

- przecięcie lub stykanie magnetycznych regionów;
- brak dodatniej separacji albo niejednoznaczny region marker;
- niezgodne ślady interfejsu, niezgodną kolejność regionów lub brak markerów komórek;
- elementy inne niż P1, prism layer conversion, DG0/material-interface fallback;
- pole `Aex` inne niż jedna skończona dodatnia stała;
- zmianę topology/region digest pomiędzy mesh producerem a plannerem.

### 3. Planner i capability

Zastąpić obecny one-body/one-material predicate walidacją zbioru certyfikowanych regionów. Zbiór jednoelementowy zachowuje dotychczasową legalną ścieżkę; nowe regiony są akceptowane dopiero po certyfikacie. Legalność ma być strukturalna, nie oparta na dokładnie dwóch regionach ani magicznych nazwach. Oryginalny layer+ring jest pierwszym workloadem dowodowym, lecz nie definiuje całej składni. Dotychczasowe legalne first-slice tuples, failure codes i fail-closed odrzucenia pozostają zachowane.

Zachować w provenance: `requested=GPU`, `resolved=FEM GPU`, strict, double, `fallback=none`, backend capability, source snapshot i wszystkie digesty. Każda niespełniona bramka musi zakończyć się przed uruchomieniem native operatora.

### 4. Interfejs region-material

Zbudować deterministyczne mapy region → komórki → węzły oraz tablice nodalne `Ms`, `Ku1`, `Ku2`, `alpha`, `axis`. Python przechowuje trzykomponentowy authored axis bez gwarancji jednostkowej; planner odrzuca wartości niefinitywne/bliskie zeru i normalizuje je przez `normalize_nonzero_vector3`. Native P1 AOS-3 sprawdza kształt i skończoność, lecz nie zastępuje unit check. Granica V2 musi jawnie zweryfikować i związać normę jednostkową authored/planner axis przed operatorem; użycie nodalnych wartości pozostaje bez nowej interpolacji lub normalizacji w quadrature. Sprawdzać `Ms > 0`, `alpha >= 0`, skończone `Ku1`/`Ku2`, zgodność jednostek i zakresów.

Nie wolno stosować last-writer-wins ani współdzielić węzła przez dwa rozłączne magnetic regions. Dodatnia separacja wyklucza wspólne magnetic nodes; overlap, touching boundaries lub wspólny owner kończą się odrzuceniem. Hashować kolejność regionów, markerów, indeksów węzłów i tablic pól w receipt/provenance.

### 5. Operatory i pochodne

- Exchange: suma po regionach z jednym `Aex0`; nie zmieniać energii ani znaku.
- Anisotropy: regionalne nodal `Ku1`/`Ku2`; V2 musi związać planner-normalized unit axes z authored inputs, a następnie potwierdzić pochodną względem magnetyzacji przy istniejącej lumped nodal mass.
- Demag: istniejący Poisson Robin, RHS wyłącznie na komórkach magnetycznych, powietrze bez `M`.
- PG-BB: istniejący tangent projector i field-like gradient `g=-P_m H_eff` w jednostkach `A/m`; existing energy-weighted metric `mu0*Ms*w` daje joule-valued directional products. `eta` ma jednostkę `m/A`, a retraction na `S^2`, Armijo i BB pozostają bez osobnego lane.
- `alpha`: tylko validated transport w tej statycznej ścieżce; dynamiczne użycie wymaga osobnego operatora i planu.

Dla każdego regionu i dla coupled layer/ring przygotować analityczny derivative check względem central finite difference. Ten check musi wykazać także poprawne ownership Poissona, nie tylko lokalny exchange.

### 6. CPU reference, patch i convergence

Dodać interpretowalne i później natywne bramki: P1 element patch tests dla prism/tet/pyramid, manufactured Poisson-Robin, mesh refinement, region-marker conservation, derivative finite-difference, energy descent, torque i PG-BB convergence. CPU jest referencją czytelną, ale jego wynik nie kwalifikuje GPU i nie oznacza fallbacku.

Minimalne artefakty: topology/region certificate, field digest, source digest, operator derivative report, mesh-refinement table, initial/final magnetization hashes, accepted-step rows i failure reason dla każdej negatywnej próbki.

### 7. GPU implementation i residency

Przenieść wszystkie regionalne tablice na device przez istniejący coefficient-upload boundary. Receipt ma potwierdzać bytes, element/node ownership, device pointer/residency i brak host recomputation w operatorze. Wykonać strict double PG-BB na CUDA, zachowując provider/device identity. Porównać ten sam stan początkowy i podsumowania accepted steps z CPU w zamrożonych tolerancjach; nie porównywać nieporównywalnych ścieżek przez luźny final-energy-only check.

### 8. Qualification niezmienionego przykładu

Dopiero po G0–G6 uruchomić literalne źródło z jego `interactive(True)`, `device("gpu", precision="double")`, `demag(realization="poisson_robin")` i `max_steps=10`. Dowód musi zawierać:

- source SHA podany wyżej oraz source snapshot/attempt identity;
- authored strict GPU intent i resolved native FEM GPU;
- brak pre-pass skip, brak CPU fallback i actual device demag timing;
- region/material/field/topology digests zgodne z receipt;
- accepted PG-BB steps, skończone energy/torque/residual artifacts;
- terminal receipt i exact runtime evidence z canonical storage.

Sam start CLI, wykrycie GPU, zbudowanie DLL, statyczny parser, CPU test, browser output lub `max_steps=10` bez solver-step evidence nie kwalifikuje tego workloadu.

## Granica markerów materiału i binarnej maski solvera

Audyt źródeł wymaga rozdzielenia dwóch reprezentacji. Autorytatywne markery materiałowe, np. `Box→1`, `ring→2`, `air→0`, muszą pozostać powiązane z `object_id`, polami i digestem V2. Obecna projekcja FFI `[1,2,0]→[1,1,0]` w `normalized_runtime_element_markers` jest dozwolona wyłącznie jako jawna maska magnetic/air; nie zastępuje mapy regionów ani provenance.

Przed dopuszczeniem V2 należy:

- zapobiec utracie regionu w `crates/fullmag-plan/src/mesh.rs::merged_fem_element_markers` i reindeksacji `per_domain_quality` do samego markera `1`;
- odrzucać brak autorytatywnego mapowania zamiast zgadywać `1` w fallbacku `crates/fullmag-runner/src/native_fem.rs`;
- sprawdzać jednolitość zadeklarowanego regionu w całym zakresie elementów segmentu w `crates/fullmag-plan/src/fem.rs`;
- ograniczyć legacy klasyfikację meshera `source_markers == 1` do V1 albo parametryzować ją deklarowanym marker setem;
- testować `[1,2,0]` i pojedynczy `[2]`: zachowanie autorytatywnej identity, poprawna maska `[1,1,0]`, oba ciała w masie, RHS Poissona, energii, observable i polach nodalnych;
- zachować preflight rejection modal/frequency/eigen, DG0 oraz innych modułów spoza tego rozszerzenia. Nie rozszerzać modalnego consumera w ramach kwalifikacji PG-BB.

Źródłowa obecność `marker != 0` w native/GPU nie jest jeszcze dowodem wykonania ani zachowania autorytatywnej mapy przed FFI. Te bramki pozostają niezaimplementowane i wymagają osobnych dowodów.

## Gate matrix

| Gate | Zakres | Wymagany dowód | Stan obecny |
|---|---|---|---|
| G0 | nota, source map, vocabulary | parser scientific docs; bez placeholderów | kontrakt i source map zweryfikowane strukturalnie; 41 interpretowanych testów walidatora PASS; runtime niezweryfikowany |
| G1 | Python/IR | round-trip CSG/object IDs/material fields/provenance | niezaimplementowane |
| G2 | CSG/mesh | disjointness, positive separation, marker ownership, conforming P1 certificate | niezaimplementowane |
| G3 | planner/capability | structural multi-region legality + strict GPU/no fallback | obecny guard odrzuca `material_count_not_one` |
| G4 | region-material/operator | nodal fields, constant Aex, derivative and Poisson ownership checks | niezaimplementowane |
| G5 | CPU numerical | patch, manufactured Robin, convergence, energy/torque | niezaimplementowane |
| G6 | GPU numerical | device residency, same-state parity, strict GPU timing/provenance | niezaimplementowane |
| G7 | original runtime | unchanged script, actual FEM GPU PG-BB, terminal receipt | NOT VERIFIED; no claim |

## Proponowane granice zmian po zatwierdzeniu planu

1. Najpierw commit dokumentacyjny: canonical physics note + source map + ten plan.
2. Następnie osobny Python/IR/certificate fragment z negatywnymi guardami i round-trip.
3. Następnie planner/region-material interface oraz CPU operator/reference gates.
4. Następnie CUDA coefficient upload/operator/parity gates.
5. Na końcu managed runtime qualification and immutable artifacts.

Żaden z tych fragmentów nie powinien zmieniać fizyki oryginalnego skryptu ani
zmieniać wyniku dla istniejących legalnych first-slice tuples. Dotychczasowe
fail-closed odrzucenia unsupported topology/physics muszą pozostać aktywne;
nowy predicate może dopuścić wyłącznie certyfikowane regiony z tego planu.
Każdy commit musi zawierać odpowiedni dowód źródłowy i interpretacyjny.

## Stan i ograniczenia

Zapisano kontrakt planowanego rozszerzenia i mapę bieżących źródeł. Walidator dokumentacji naukowej, JSON oraz 41 interpretowanych testów jego kontraktu przeszły. Nie wykonano w tym etapie buildu produktu, kompilacji testów jednostkowych, zmiany oryginalnego modelu ani kwalifikacji runtime. Render publikacji oraz bramki G1–G7 pozostają otwarte; kontrola strukturalna nie potwierdza poprawności numerycznej.
