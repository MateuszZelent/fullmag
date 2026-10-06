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

Dokładna ścieżka IR nowego BC: `study.spatial_representation` jest tagged enum; wariant `waveguide_2p5d` zawiera `frame`, `cross_section_mesh`, jawne `region_targets` oraz własny tagged `magnetostatic_bc.kind = finite_air_cross_section_dirichlet` z referencjami do stabilnych `boundary_component_id` i incidence krawędzi zewnętrznego powietrza; sam luźny marker nie dowodzi topologii. Top-level legacy `study.magnetostatic_bc` pozostaje wyłącznie dla full_3d i jest niedozwolony w nowym wire waveguide. Pierwszy nowy authoring musi odróżniać brak legacy BC od jawnego żądania (default sentinel/None): dla full_3d brak rozwiązuje się do open; dla waveguide BC pochodzi z tagged wariantu, a jawne 3D BC jest konfliktem. Serializer nie emituje obu niezgodnych reprezentacji. Historyczny importer nie zna waveguide, a nowy importer zachowuje go i nigdy nie redukuje do open/full_3d.

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


### Sprawdzona przynależność trójkątów do komponentów skalarnych

`WaveguideMeshIncidenceReport::scalar_component_by_triangle()` zachowuje wynik
istniejącego traversal adjacency, w kolejności wejściowych trójkątów. Indeks
komponentu jest deterministyczny według jego najmniejszego indeksu trójkąta
(i zależy od kolejności mesha); ma jednostkę1. Dane są serializowalne w raporcie
wyjściowym, bez możliwości jego deserializacji/utworzenia przez użytkownika.

To mapa topologiczna potrzebna przyszłemu sprawdzeniu wybranych konturów
Dirichleta. Nie wybiera essential nodes i nie dowodzi anchoring. Dwa rozłączne
komponenty mogą mieć różne liczniki exterior air, w szczególności[12,0], gdy
w drugim air jest zamkniętą wyspą. Wybrany brzeg musi zostać osobno powiązany
z konkretnymi one-owner half-edges/komponentami i rejestrami modelu.
Regresja obejmuje pełną kompozycję incidence na dwóch takich domenach;
parser/source checks nie zastępują wykonania CI ani produkcyjnego MFEM2D.


### Prywatne powiązania rejestrów — przyrost S09, 2026-10-06

`waveguide_mesh_bindings::validate_waveguide_registry_bindings` jest prywatnym
etapem kompilatora. Przyjmuje pożyczone `ProblemIRV04`, raw mesh i jawną mapę
`mesh region_id -> RegionRefIR`; składa walidację ProblemIR z pełną istniejącą
walidacją konturów/geometrii. Wynik ma prywatne pola, nie jest deserializowalny
ani certyfikatem admission, a jego czas życia wiąże go z dokładnymi wejściami.

Mapa musi pokrywać dokładnie zbiór regionów mesha. Object ID musi zgadzać się
z raw meshem i rejestrem; regionalny target musi mieć właściwego właściciela
i być enabled. Region magnetyczny wymaga zgodnego materiału (kluczem obecnego
MaterialIR jest `name`), jawnego MagnetizationModule oraz zgodnego assignment
wymienionego przez obiekt. Nazwa i prezentacyjny typ obiektu nie włączają fizyki.
Whole-object target pokrywa regionalny target; odwrotne pokrycie jest odrzucane.
Air nie otrzymuje syntetycznego materiału i nie może mieć potencjalnie
nakładającego się modułu magnetyzacji. Żaden moduł magnetyzacji nie jest pomijany.

Ten pierwszy etap odrzuca więcej niż jeden region mesha dla tego samego obiektu
oraz konkurujące whole/regional providers. Nie wybiera pierwszego wpisu i nie
zakłada rozłączności różnych region IDs. Pełna produkcyjna obsługa regionalnych
materiałów wymaga późniejszego dowodu pokrycia i geometrycznej rozłączności lub
jawnej reguły pierwszeństwa; obecne ograniczenie nie zamyka tego wymagania S09.

Pozostają world/frame mapping, immutable fingerprint, wiązanie wybranych
zewnętrznych konturów air i essential nodes Dirichleta do wszystkich komponentów
skalarnych, invariance pól/interakcji oraz certyfikat równowagi. Typed routing,
owner MFEM CPU/GPU i naukowa kwalifikacja 2.5D pozostają niedostępne. Przygotowane
regresje podlegają istniejącej bramce `cargo test -p fullmag-ir waveguide_mesh`
wyłącznie w GitHub Actions. Parser i review nie zastępują ich wykonania.


### Jawny Dirichlet przekroju — prywatne bindings, 2026-10-06

`waveguide_mesh_dirichlet::validate_finite_air_dirichlet_bindings` przyjmuje
pożyczony wynik registry binding i listę exact boundary_component_id. Nie
przyjmuje niezależnego raportu innego mesha. Sprawdza ponownie incydencje na
niezmiennym mesh tego samego tokenu. Pusta selekcja, puste/powtórzone/nieznane ID,
magnetic contours, air holes i two-owner interfaces są błędami. Whitespace nie
jest usuwany z identyfikatorów. Każda wybrana half-edge musi należeć do zewnętrznego
konturu air i mieć jednego właściciela. Sama deklaracja outer nie wystarcza.

Wyjściowy opaque token zachowuje pożyczony registry, indeksy konturów w kolejności
mesha, posortowany union essential node indices oraz liczniki rzeczywiście
wybranych krawędzi i węzłów w każdej składowej skalarnej. Każda składowa musi
mieć wybrane krawędzie i essential nodes. Istnienie zewnętrznego powietrza bez
jego jawnego wyboru nie dowodzi anchoring. Ten token nie jest certyfikatem
structural_2d, równowagi ani gotowości MFEM. World mapping, fingerprint, invariance,
produkcja operatorów i wszystkie bramki naukowe pozostają wymagane.

Przygotowane regresje obejmują outer air, błędne ID/magnetic/hole/interface,
dwie rozłączne domeny i deterministyczność union względem kolejności selekcji.
Wykonanie testów zachowuje istniejącą bramkę CI waveguide_mesh; parser finalnych
bajtów oraz review źródeł nie zastępują wykonania Rust ani managed runtime.


### Prywatna tożsamość geometrii — zakres i kodowanie v1

Kolejny compiler prerequisite `waveguide_mesh_identity` oblicza geometry identity
wyłącznie z opaque world mapping. To nie jest `structural_2d` certificate ani
klucz gotowego operatora. Liczby materiałowe/interakcje, równowaga, sampled k,
producer build i execution wymagają własnych kompletnych bindings przed reuse.
Nie używać samego geometry digest jako operator/equilibrium fingerprint.

Domain: `fullmag.waveguide.geometry-identity.v1`; algorytm SHA-256. Preimage jest
streamem z jawnymi tagami, długościami/counts u64 little-endian, indeksami u64,
local-side/enum tags u8 oraz bitami f64 little-endian, bez JSON pretty-print.
String długości odnoszą się do bajtów UTF-8. Surowe signed zero zachowuje bity;
geometryczne sprawdzanie zbieżności ±0 nie zmienia exact authored identity.
BTreeMap targets jest kodowane w porządku kluczy; Vec order pozostaje znaczący.
Konwersje usize/count i przyrost długości preimage są checked.

Preimage wiąże: dokładny raw mesh schema/nodes/triangles/edges/incidences/regions/
ordered boundary components; exact RegionRef target map; requested i canonical
frame oraz dodatnie normalization lengths i frame tolerance; resolved world
nodes; selected Dirichlet component indices i essential-node union; quality
threshold oraz versioned arithmetic/orientation policy. Nie używa topology
fingerprint3D ani pól prezentacyjnej nazwy/typu obiektu do aktywacji fizyki.

Wynik pozostaje private borrowed value, bez Deserialize/public constructor.
Zachowuje odwołanie do tego samego world mapping, digest i dokładną długość
preimage. Nie zapisuje automatycznie artefaktów ani nie aktywuje cache/provider.
Regresje mają obejmować deterministic output, length framing, -0 identity,
zmianę geometrii/ramy/bindings/selection i brak zmiany przez kolejność insert
w target map. Hash wiąże dane; nie zastępuje żadnego validatora ani dowodu nauki.

#### Zamrożone tagi preimage v1

Wartość tagu zajmuje jeden bajt. Kolejność sekcji i pól w każdej sekcji jest
częścią protokołu. Indeks elementu poprzedza jego pola; kontenery zaczynają się
od liczby elementów. Wszystkie indeksy i liczby elementów są u64 little-endian.

| Tagi hex | Sekcja, w kolejności kodowania |
|---|---|
| `01` | Domain i string `fullmag.waveguide.geometry-identity.v1` |
| `10`, `11` | Raw mesh; schema enum `V1=1` |
| `12`, `13` | Nodes: count; index, u, v |
| `14`, `15` | Triangles: count; index, 3 node indices, region ID |
| `16`–`19` | Edges: count; index, 2 nodes; incidences count; triangle index, local side u8 |
| `1a`, `1b` | Regions: count; index, kind (`magnetic=1`, `air=2`), region ID, object ID; material ID tylko dla magnetic |
| `1c`–`1f` | Boundaries: count; index, component ID, region ID, loop (`outer=1`, `hole=2`); half-edge count; triangle index, local side u8 |
| `20`, `21` | Targets: count; sorted key, object ID, optional region (`None=0`, `Some=1` i string) |
| `30`–`34` | Frame: requested origin/Eu/Ev/axis; canonical origin/Eu/Ev/axis; 3 normalization lengths; tolerance |
| `40`, `41` | World nodes: count; index, x, y, z |
| `50`, `51` | Selected boundary indices i essential nodes: count, posortowane indeksy |
| `60`–`62` | Triangle quality f64; arithmetic policy string; orientation policy string |

Każdy string ma prefiks długości bajtów UTF-8 u64. Wektory mają ustalony wymiar;
nie zawierają osobnej długości. Wartości f64 koduje się przez `to_bits()` jako u64.
Polityki arytmetyki i orientacji mają jawne, niezmienne stringi w źródle encodera:
mapowanie `(origin+u*Eu)+v*Ev` z osobnymi operacjami, canonical axes i kontrolą
wartości skończonych oraz exact dyadic orientation względem osi. Zmiana tagów,
kolejności/pokrycia pól, enum wartości lub policy strings wymaga nowej wersji
domain; nie wolno przepisywać historycznych digestów jako v1.


### Pierwszy przyrost typed StudyIRV04 — staging, 2026-10-06

Istniejący opt-in ProblemIRV04 otrzymuje własny typed StudyIRV04; nie powstaje
konkurencyjny wire0.4/0.5. Publiczny writer i reader0.3 pozostają niezmienione.
Study i spatial variants mają lokalne deny_unknown_fields; root zachowuje
legacy_extensions. Każde nowe studyV04 wymaga jawnego spatial_representation.

| Pole wariantu waveguide_2p5d | Typ / znaczenie |
|---|---|
| frame | WaveguideFrameIR; wszystkie cztery wektory wymagane, jednostki SI jak w rozdziale ramy |
| cross_section_mesh | WaveguideCrossSectionMeshIR; jawny raw descriptor v1, nie ukryty przekrój mesha3D |
| region_targets | wymagane BTreeMap mesh region_id → canonical RegionRefIR; jawny object_id i opcjonalny canonical region_id |
| magnetostatic_bc.kind | dokładnie finite_air_cross_section_dirichlet |
| magnetostatic_bc.boundary_component_ids | niepusta lista dokładnych niepustych ID konturów; bez powtórzeń |

Raw shape i geometria nie są admission ani dowodem physical invariance.
Ostateczne wybrane kontury muszą przejść istniejące region/incidence/Dirichlet
bindings z tego samego modelu; same ID nie dowodzą zewnętrznego brzegu powietrza.
Signed k jest resolved z istniejącego study.k_sampling, nie z drugiego skalaru.

Pierwszy wariant waveguide występuje tylko dla Eigenmodes. FrequencyResponse,
TimeEvolution, Relaxation i Hysteresis nie dziedziczą jego legalności. W V04
full_3d spectral study top-level magnetostatic_bc jest jawne i nie-null; przy
waveguide musi być całkowicie nieobecne, również null jest konfliktem. Tagged
BC wewnątrz waveguide nie rozszerza starego globalnego string enum.

Migrator0.3→0.4 sprawdza obecność przed defaultingiem: brak reprezentacji daje
full_3d; historycznie brakujące spectral BC daje Open z provenance
`defaulted_from_missing`, jawne poprawne BC pozostaje zachowane, null jest
błędem bez mutacji dokumentu. Provenance należy do istniejącego
problem_meta.runtime_metadata i ma wersjonowany rekord migracji przestrzennej.

Walidacja modelu pozostaje oddzielna od dostępności providera. Typed reader
nie autoryzuje wykonania; jawny guard dostępności odmawia waveguide_2p5d z
waveguide_2p5d_unavailable do pełnego admission/owner MFEM i kwalifikacji.
Nie wolno zapewniać tej zgodności przez Deref/flatten do legacy StudyIR ani
przez fallback do full_3d. Ewentualna konwersja zgodności musi być checked i
przyjmować wyłącznie wariant full_3d. Ta sekcja nie przełącza publicznego API,
capability matrix, generowanych klientow ani uruchomionych instancji.


Raw mesh region_id i canonical ObjectRegionIR.region_id są odrębnymi przestrzeniami
identyfikatorów. region_targets musi dokładnie pokrywać regiony mesha; nieznane
klucze, brakujące regiony, niewłaściwy właściciel lub nieważny canonical target
są błędem. Whole-object target i regionalny target zachowują własne znaczenie;
nie wstawia się syntetycznego None ani nie wyprowadza target z object name/type.
Pole jest częścią requested intent, roundtrip i geometry identity.

Walidacja staging modelu składa istniejące common object-registry checks,
niezależne frame/mesh checks oraz rzeczywiste registry/Dirichlet bindings.
Jej call graph nie może wywoływać ponownie ProblemIRV04.validate z jego własnego
kroku bindings. Post-common-validation helper jest crate-private i ma wyraźne
preconditions; zwykły wejściowy registry validator nadal wykonuje pełną walidację
modelu. To nie oznacza invariance/equilibrium certificate ani admission.
