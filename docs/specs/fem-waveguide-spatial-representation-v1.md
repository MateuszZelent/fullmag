# Kontrakt reprezentacji falowodu FEM 2.5D — v1

Status: projekt kontraktu S01/S02/S09 do review. Nie jest obecnym formatem publicznego API ani dowodem dostępności providera. Decyzja: [ADR-0035](../adr/0035-eigen-spatial-representation-contract.md). Fizyka: [0828](../physics/0828-fem-frequency-domain-floquet-demag.md), [0832](../physics/0832-fem-waveguide-nodal-ms-quadrature.md). Pierwszy kamień milowy CPU3D S00–S08 pozostaje odrębny.

## Reprezentacja i migracja Γ

Przy przyszłym atomowym cutoverze istniejącego V04 serializer ma jawnie zapisywać `spatial_representation.kind = full_3d | waveguide_2p5d`; obecny publiczny writer 0.3 tego nie robi. Historyczny dekoder braku pola wybiera istniejącą pełną domenę 3D; nie tworzy certyfikatu periodyczności ani invariance. Brak pola w nowym payloadzie jest błędem wersji kontraktu.

| Reprezentacja | Magnetostatyka | k=0 | Semantyka |
|---|---|---|---|
| full_3d | open | legalne przy istniejących guardach | izolowany obiekt 3D, dotychczasowy provider |
| full_3d | periodic_airbox_k0 | wyłącznie Γ, istniejące periodiczne BC | dotychczasowa okresowa domena 3D |
| full_3d | floquet_airbox | Single Γ nie otwiera providera; Path z nonzero może zawierać Γ | pełne pole 3D; obecny dispatcher normalizuje próbkę Γ do periodic K0 |
| waveguide_2p5d | finite_air_cross_section_dirichlet | legalny punkt signed sweepu, w tym dokładne k=0 | zawsze operator przekroju; żadnego routingu Γ do periodic_airbox_k0 |

Eigensolve predicate `floquet_airbox_dynamic_demag_cpu_plan_supported` w `crates/fullmag-plan/src/fem.rs` rozróżnia Single i Path. Guard frequency response jest innym produktem i nie określa legalności Eigenmodes. Nowy waveguide sweep przechodzi przez Γ bez zmiany reprezentacji; naukowa ciągłość k→0 pozostaje osobną bramką.

Dokładna ścieżka IR nowego BC: `study.spatial_representation` jest tagged enum; wariant `waveguide_2p5d` zawiera `frame`, `cross_section_mesh` oraz własny tagged `magnetostatic_bc.kind = finite_air_cross_section_dirichlet` z referencjami do stabilnych `boundary_component_id` i incidence krawędzi zewnętrznego powietrza; sam luźny marker nie dowodzi topologii. Top-level legacy `study.magnetostatic_bc` pozostaje wyłącznie dla full_3d i jest niedozwolony w nowym wire waveguide. Pierwszy nowy authoring musi odróżniać brak legacy BC od jawnego żądania (default sentinel/None): dla full_3d brak rozwiązuje się do open; dla waveguide BC pochodzi z tagged wariantu, a jawne 3D BC jest konfliktem. Serializer nie emituje obu niezgodnych reprezentacji. Historyczny importer nie zna waveguide, a nowy importer zachowuje go i nigdy nie redukuje do open/full_3d.

Inne kombinacje nie otrzymują fallbacku. Nowy rodzaj magnetostatyki nie może być dodany do obecnego globalnego string allow-list bez tagged kontraktu reprezentacji i guardów wszystkich konsumentów. Gdy provider nie istnieje, wynik jest `waveguide_2p5d_unavailable`, przed budową siatki 3D lub wyborem solvera Blocha.

## Pierwszy jawny model brzegu

Wybrany wariant `finite_air_cross_section_dirichlet` oznacza skończony przekrój magnetyku i otaczającego go powietrza. Na wskazanych krawędziach ZEWNĘTRZNYCH powietrza obowiązuje phi=0. Nie jest to dokładny operator otwartej nieskończonej przestrzeni; rozmiar przekroju powietrza i osobna zbieżność są obowiązkowe. Nie dobierać automatycznie stałego Robin beta ani grubości 3D.

Scalar P1 jest konformny na całym przekroju. Potencjał jest ciągły na interfejsie magnetyk–powietrze. Jump normalnej pochodnej wynika z fizycznego źródła Ms*delta_m w weak form 0828/0832; nie nakładać zerowego potencjału ani ciągłości samego H_n na granicy magnetyku. Zewnętrzny Dirichlet usuwa stały nullspace także przy k=0; nie dodawać redundantnego gauge. Rekonstrukcja pola używa gradientu poprzecznego i +ik*phi wzdłuż osi. Cały modalny pencil musi również zawierać longitudinalny wkład wymiany k² z właściwym polem A: dodatnia energia per-length obejmuje całkę A*k²*|delta_m|² dA obok pochodnych poprzecznych. Nie dodawać tego jako samej korekty częstotliwości ani nie stosować jednocześnie podłużnego C(k). Tangent Hessian i niejednorodne współczynniki nadal podlegają wspólnej nocie 0831.

`spin_wave_bc` pozostaje osobnym żądaniem: pierwszy owner wspiera naturalne free exchange boundary na ZEWNĘTRZNYM brzegu magnetyku, z zachowaniem interfejsów materiałowych. Pinned, DMI i surface terms wymagają własnych warunków i guardów dostępności; nie interpretować ich jako free. Wewnętrzny interfejs dwóch regionów magnetycznych nie staje się zewnętrzną free boundary.

## Rama i signed k

Canonical frame zawiera `origin_m`, `e_u`, `e_v`, `axis_unit` w globalnych współrzędnych. E_u, e_v, axis są prawoskrętne i ortonormalne w granicach wspólnej tolerancji geometrycznej. Kierunku axis nie kanonizować przez znak dominującego składnika. Każdy wektor musi być skończony; brak lub zerowa oś jest błędem.

Pierwsza wspólna polityka walidacji wymaga norm jednostkowych, iloczynów skalarnych i det=+1 z dimensionless tolerance 1e-12. Wartość i wyniki walidacji muszą trafić do resolved provenance; to nie jest tolerance solvera ani residualu. Python/Rust/UI korzystają z jednego kontraktu i wspólnych fixtures, a nie prywatnych epsilonów. Po kontroli norm każdą oś normalizować wyłącznie przez jej dodatnią długość, zapisując original frame, canonical frame i skale tej jawnej operacji. Nie obracać osi przez Gram–Schmidta ani nie odwracać znaków. Kontrole ortogonalności/determinant oraz projekcja k używają canonical frame.

Requested sampling zachowuje dotychczasowy GLOBALNY wektor KPoint/KPath. Dla niezerowego k obliczyć signed scalar dot(k,axis) i relative collinearity error norm(k-axis*scalar)/norm(k); wymagany error<=1e-12. Dokładny zerowy wektor daje scalar=0 i error=0. Używać stabilnego norm/hypot, odrzucać overflow/NaN. Nie stosować absolute floor 1 rad/m, który zaakceptowałby całkowicie poprzeczne małe k.

Resolved sample zapisuje requested global vector, signed scalar [rad/m], reconstructed global vector, collinearity error i hash ramy. Odrzucenie poprzecznego k jest jawne; niewielka różnica dopuszczona przez tolerance pozostaje widoczna. Axis→-axis razem z scalar→-scalar zachowuje physical global k, ale rama/przekrój i wektorowe pola muszą być przekształcone razem, a certyfikat recomputed. Konkretny adapter odwrócenia osi utrzymuje origin i e_u, zamienia e_v→-e_v i axis→-axis oraz v→-v lokalnych węzłów. Zmienia signed scalar k→-k i odpowiednio porządkuje connectivity/edge incidence, by przywrócić CCW orientację komórek. Scalar transverse envelope phi(u,v) przechodzi na phi(u,-v); globalne wektory delta_m/H pozostają fizycznie takie same, a lokalne komponenty e_v/axis zmieniają znak. Recomputed certificate/mesh/frame hashes wiążą nowe bajty. Nie oczekiwać identycznego hasha dla innych współrzędnych.

## Topologia przekroju i object_id

Nie rozszerzać po cichu 3D FemConnectivityIR przez użycie trójkąta jako tetrahedron. Nowy typed resolved descriptor przekroju zawiera local nodes [u,v] w m, trójkąty P1 z trzema indeksami, krawędzie z dwoma indeksami oraz stabilne region_id/boundary_component_id z kompletną incidence krawędzi. Mapping do globalnego świata pochodzi wyłącznie z deklarowanej ramy. Indeksy, region_id i boundary_component_id wiążą się z istniejącymi niezmiennymi object_id; nazwy/type nie włączają magnetyzmu.

Geometry guard definiuje dimensionless triangle quality q=4*sqrt(3)*area/(sum squared edge lengths), z q=1 dla equilateral. Obliczyć area i długości po skalowaniu krawędzi największą długością, aby kryterium nie zależało od jednostek/rozmiaru. Odrzucić q<=64*epsilon_f64 jako numerycznie zdegenerowany (epsilon_f64=2^-52), overflow/underflow wymaganych fizycznych współczynników, zerowe krawędzie i nie-dodatnią signed area. Ta roundoff granica nie jest certyfikatem dokładności FEM ani zalecaną jakością meshera: conditioning/residual oraz mesh convergence pozostają osobnymi bramkami. Certificate publikuje minimum q, threshold oraz minimum fizycznej area [m²]; nie kopiować absolute minimum area 1e-30 m² bounded oracle do produkcji.

Każdy trójkąt ma dodatnią signed area w prawoskrętnej lokalnej ramie; odwrócone, zdegenerowane, niekonformne i nie-manifold elementy są błędem. Region jest jawnie magnetic lub air, z kompletnym mapping materiału. Wspólny scalar mesh ma konformny interfejs, a q ma dwa tangent DOF tylko w magnetic subspace. Zewnętrzne pętle konturu są skierowane przeciwnie do wskazówek zegara, a pętle otworów zgodnie z nim: wnętrze oznaczonego regionu pozostaje po lewej stronie. Normalny znak musi pochodzić z incidence elementu i regionu; dwa elementy współdzielonego interfejsu mają przeciwne normalne. Same luźne markery bez incidence nie są dowodem orientacji.

Każda zmiana współrzędnych, connectivity, region_id/boundary_component_id/edge-incidence, object mapping lub frame zmienia identity mesha i unieważnia powiązane certificate/operator cache. Mesh asset/import/binary codec wymaga nowej jawnej dimensionality/kind; istniejącego payloadu 3D nie reinterpretować. Pierwsza realizacja przyjmuje świadomie authored przekrój 2D, nie automatycznie wybrany slice modelu 3D.

## Certyfikat structural invariance

Projektowany schema `fullmag.waveguide_2p5d.invariance.v1` jest w resolved plan/artifact, nie w publicznym booleanie. Producent: dedykowany compiler/provider przekroju, z managed build identity. Walidator runnera sprawdza jego źródło, wszystkie bindings i metryki przed utworzeniem operatora.

Pierwszy certificate obsługuje wyłącznie structural_2d: geometry, material fields, applied field oraz equilibrium są definiowane jako stałe lub P1 pola przekroju, bez osiowej współrzędnej w ich reprezentacji. Structural proof obejmuje WSZYSTKIE BC i interakcje: exchange boundary, surface anisotropy/DMI/interface normals, interfejsy materiałowe, applied fields oraz zewnętrzną granicę powietrza muszą być stałe wzdłuż osi, reprezentowane w tym samym przekroju. Nieobsługiwany wariant lub jego osiowo zmienny współczynnik jest unavailable, a nie przemilczany. Invariance wynika z kompletnego modelu wejściowego, nie z wymyślonej liczby „axial error=0”. Nie wolno wystawić tego certificate dla nieznanego callbacku 3D lub jednego wyciętego slice. Adapter rzeczywistej ekstrudowanej domeny 3D wymaga osobnego certyfikatu, metryk i kwalifikacji.

Nieznane pola geometryczne/materialowe lub nieobsługiwane interakcje nie mogą być pominięte w bindings: są błędem albo unavailable. Hashy nie wyliczać z niekanonicznego pretty-print dict; wiążą dokładne artefakty/manifesty zgodnie z istniejącym kontraktem source identity.

Wymagane pola certyfikatu:

- schema, status `validated_structural_2d`, representation kind i producer build/source identity;
- SHA-256 niezmiennych bajtów artefaktów i manifestów topologii/współrzędnych/region_id/boundary_component_id/edge-incidence, object_id mapping, ramy, wszystkich material/applied-field danych, equilibrium i warunków brzegu;
- proof kind structural_2d oraz identities kompletnych definicji geometry/fieldów; brak wsparcia dla nieznanej osiowej zależności;
- liczby komórek/węzłów regionów, zakresy mapping, minimum signed area [m²], frame norm/orthogonality/determinant errors i pełność oznaczeń brzegu;
- jawna polityka geometry tolerance i wynik poszczególnych kontroli; żadnego synthetic runtime/science pass;
- odniesienie do osobnego accepted equilibrium/static-torque certificate. Invariance nie dowodzi równowagi ani k0 frequency.

Zmiana input binding, brak producer identity, invalid metric albo nieznany proof kind oznacza unavailable/replan przed solverem. Hash nie jest dowodem poprawnej fizyki; niezależny walidator ponownie sprawdza kształty/mapping i warunki. Sam k nie należy do proof invariance, lecz każdy sampled operator i wynik ma osobne binding request/plan/sample k. Zmiana materiału/ramy/BC/equilibrium unieważnia reuse między próbkami.

## Normalizacja i bramki wdrożenia

Norma przekroju używa dA i physical Cartesian interpolation tangent frames; nie mylić jej z gyroscopic B ani Ms-weighted metric. Mapowanie unit_l2/unit_max_amplitude, jednostki normalized shape/amplitude/potencjału/energii oraz porównanie extruded3D opisuje proponowana [nota naukowa 0833](../physics/0833-fem-waveguide-25d-normalization.md). Kod normalizacji 2D nadal wymaga typed kontraktu i kwalifikacji providera. Żaden istniejący artifact field nie otrzymuje nowych jednostek bez wersjonowanego kontraktu i adaptera.

Kolejność: review tego kontraktu i noty normalizacji → wspólny authoring/IR round-trip oraz unavailable guard → nowy mesh asset/ABI/provider MFEM 2D → pełny residual i reconstructed fields → zbieżności mesh/exterior/k→0 → TetraX/extruded3D → OpenAPI/generated client/browser → promocja supported. Source tests nie zamykają żadnej bramki runtime/science. GPU jest oddzielną realizacją i nie ma cichego fallbacku.


## Powiązanie z globalnym wire

Wariant falowodu należy do istniejącego `ProblemIRV04`, a nie do rozszerzenia
ignorowanego przez 0.3. Obowiązuje [macierz wersji i BC w ADR0035](../adr/0035-eigen-spatial-representation-contract.md#wersjonowanie-istniejący-v04-bez-konkurencyjnego-wire).
Presence guard legacy/staging StudyIR jest przygotowany w źródłach, z review
oraz parserem PASS; jego regresje Rust i runtime pozostają OPEN. Typed StudyIRV04
i migracja reprezentacji nie są jeszcze zaimplementowane. Publiczny writer
pozostaje 0.3; status providera unavailable.

## Typowany surowy descriptor przekroju — wire v1

Przyrost S09 zamraża wyłącznie surowy typ danych `WaveguideCrossSectionMeshIR`.
Nie jest to validated mesh, certyfikat structural invariance ani admission
V04. Publiczny writer/reader 0.3 nadal odrzuca spatial_representation. Pełny
cutover V04 zachowuje wszystkie wcześniejsze wymagania tej specyfikacji.

Właściciel nowych źródeł: `crates/fullmag-ir/src/waveguide_mesh.rs`.
Zamknięty schema ma token `fullmag.waveguide-cross-section-mesh.v1`.
Wszystkie obiekty i tagged enum mają lokalny deny_unknown_fields; wymagane
pola nie mają serde(default). Nieznany kind/schema i jawne null są błędem
typu. Schema i loop_kind wymagają string-only TryFrom<String>; nie dopuszczają mapy unit wariantu z null. Źródło tego rozróżnienia: [serde_json Value VariantDeserializer](https://docs.rs/serde_json/latest/src/serde_json/value/de.rs.html#556-560).
Samo serde nie kontroluje znaczenia indeksów, geometrii ani mappingu.

| Pole | Typ i znaczenie | Jednostka SI |
|---|---|---|
| schema | dokładny wersjonowany token surowego descriptoru | $1$ |
| nodes_uv_m | tablica par lokalnych współrzędnych u,v | $\mathrm m$ |
| triangles | P1: nodes z trzema indeksami u64 i region_id | $1$ |
| edges | nodes z dwoma indeksami u64 oraz incidences | $1$ |
| incidences / half_edges | triangle_index u64 i local_edge_index z zamkniętego zbioru 0,1,2 | $1$ |
| regions | tagged kind magnetic/air; jawne region_id i object_id, material_id wyłącznie magnetic | $1$ |
| boundary_components | boundary_component_id, region_id, loop_kind outer/hole, ordered half_edges | $1$ |

Local side 0 oznacza nodes[0]→nodes[1], side 1 nodes[1]→nodes[2],
side 2 nodes[2]→nodes[0]. Kierunek półkrawędzi wynika z dodatnio
zorientowanego trójkąta, nie ze znacznika użytkownika. Edge.nodes ma
kanoniczny rosnący porządek indeksów; walidator musi go porównać z obiema
incidences. Jedna incidence oznacza brzeg całej domeny, dwie muszą mieć
przeciwne kierunki i różnych właścicieli-trójkąty. Więcej niż dwie, brak
incidence, duplikaty, orphan edges/triangles, luki lub niezgodne indeksy
są błędem późniejszej walidacji topologii, nie poprawną siatką.

Każdy region-boundary segment ma dokładnie jednego właściciela w jego
konturze. Zewnętrzna krawędź należy do konturu jedynego regionu. Interfejs
dwóch regionów występuje po obu stronach z przeciwstawnym kierunkiem;
wewnętrzna krawędź jednego regionu nie jest konturem. Każdy kontur jest
zamknięty, ma niepowtarzane skierowane półkrawędzie, a jego region leży
po lewej stronie. Loop kind nie zastępuje sprawdzenia signed area i
nestingu: outer ma CCW, hole CW. Zamknięta wyspa powietrza nie otrzymuje
automatycznie Dirichleta. BC ma później wiązać jawne ID zewnętrznych
air contours i każdą składową całego scalar mesh.

Raw region/object/material identyfikatory są referencjami do kanonicznych
rejestrów; nazwa/type nie włącza fizyki. Deserializer nie daje certyfikatu
ich istnienia, pełnego pokrycia ani jednolitości wzdłuż osi. Również puste
tablice, powtarzane ID, współrzędne nonfinite i złe referencje mają zostać
odrzucone przez niezależny compiler/validator przed jakimkolwiek operatorem.

Rama jest oddzielnym wymaganym polem wariantu spatial representation;
nie kopiować jej do mesha jako drugiego źródła prawdy. Przyszły fingerprint
2D wiąże exact nodes/connectivity/incidence/region/object/material/contours
oraz requested/canonical frame i politykę walidacji. Nie używa fingerprintu
3D. Definicje structural_2d pól, interakcji i BC pozostają oddzielnym
kompletnym kontraktem; nie chować ich w unknown extensions mesha.

Ten przyrost nie dodaje validatora topology/geometry, fingerprintu ani
produkcji certificate. Wymagane następne kroki: scaled signed area/quality
i representability; pełna incidence/fan/contour/non-overlap kontrola;
bindingi rejestrów i pól; typed V04 migration/admission; owner MFEM i
wszystkie bramki runtime/nauki. Prepared serde regressions nie są dowodem
wykonania Rust; kompilacja unit tests pozostaje zakazana.


## Lokalna walidacja raw mesha — przyrost źródłowy 2026-10-04

`validate_waveguide_mesh_elements` w `crates/fullmag-ir/src/waveguide_mesh_elements.rs`
sprawdza orientację CCW, finite coordinates, indeksy, duplikaty współrzędnych
oraz reprezentowalność geometrycznych skalarów P1. Quality używa jawnego
bezwymiarowego `WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD = 64 * f64::EPSILON`,
bez absolute area floor. Guard IEEE gradual underflow jest współdzielony
z walidacją ramy. Równania, jednostki i ograniczenia są w nocie
[0833](../physics/0833-fem-waveguide-25d-normalization.md#lokalne-kontrole-elementów-i-incydencji--przyrost-źródłowy-s09).

`validate_waveguide_mesh_incidence` w `crates/fullmag-ir/src/waveguide_mesh_incidence.rs`
sprawdza pełne pokrycie boków komórek przez incydencje, skierowane zamknięte
kontury regionów, referencje i spójność vertex fans. Wyznacza składowe całej
domeny skalarnej oraz zewnętrzne krawędzie air w każdej. Sam rodzaj regionu
nie aktywuje ani nie dowodzi BC/anchoring; zamknięta wyspa air jest legalną
topologią. Object/material references muszą być niepuste, ale istnienie tych
obiektów w rejestrach wymaga osobnego binding validator.

Raporty obu funkcji mają prywatne pola i są serializowalne tylko w kierunku
wyjścia. Nie są typem `ValidatedWaveguideMesh`, nie nadają statusu
`validated_structural_2d`, nie aktywują wersji IR0.4 ani capability/provider.
Brak przecięć/overlap/T-junction, geometryczne znaczenie outer/hole i nesting,
frame/world map, immutable registry bindings, invariance/equilibrium oraz
finite-air boundary certificate pozostają wymagane przed admission.

Prepared Rust regression checks nie są wykonywane ani kompilowane w okresie
obowiązywania zakazu. Source review, parser i dokładny oracle wejściowy nie
zastępują produkcyjnego wykonania MFEM, testów Rust ani walidacji naukowej.
S09 pozostaje OPEN.
