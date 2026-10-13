# Aktualizacja worktree UI z mastera — 08.10.2026

## Zakres

- Worktree: `C:\git\fullmag\worktrees\dispersion-mode-ui-20261008`.
- Branch: `codex/dispersion-mode-ui-20261008`.
- Stan przed aktualizacją: czysty, HEAD `807ebb4ed5293a5ff0d63c35c4d1eb12f5c38f1c`.
- Pobrany master: `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`.
- Integracja 13 commitów z mastera przez merge, bez resetu/rebase/force-push.
- Główny checkout z cudzymi zmianami nie jest modyfikowany.

## Rozwiązanie konfliktu

Jedyny konflikt treści: `crates/fullmag-authoring/src/scene.rs`.
Zachowano obie niezależne zmiany:

1. Dotychczasowy `deserialize_scene_pbc_presence`: brak pola zachowuje PBC,
   jawne null usuwa PBC. Zachowano pola i polityki specyficzne dla brancha.
2. Importowane z mastera `SceneStageF64`, `SceneStageU64`, `SceneStageVec3`
   i `SceneStudyStageState`: liczbowe parametry etapów w canonical scene,
   kontrolowana zgodność z legacy tekstem oraz adaptery/validation mastera.

Nie wybrano całego pliku jednej strony. Parser Rust i brak markerów sprawdzone.

## Dowody

- Production-source receipt `1857c2efff6e482d8352fc5a184999cd`: PASS/exit0.
- Rustfmt `--emit stdout` dla scene.rs: parser PASS, bez formatowania repo
  i bez kompilacji testów.
- Git diff check PASS; brak nierozwiązanych ścieżek w indeksie.
- Bounded review viewportu: zachowane mode/complex/phase wiring,
  rozróżnienie Inspector Focus od Frame All oraz jeden właściciel WebGL.
- CI rozszerzone o `fullmag-authoring --lib scene_`: testy PBC oraz
  numerycznych etapów wyłącznie w GitHub Actions. Wynik merge CI jest osobnym
  dowodem; wcześniejsze CI nie certyfikuje nowego połączenia źródeł.

## Pozostałe ograniczenia

Review źródeł wskazało potencjalne opóźnienie wyboru krawędzi ticków podczas
ruchu kamery: `DimensionFrameLayer` korzysta ze snapshotu cameraState,
zatwierdzanego po końcu gestu OrbitControls. Jest to zachowanie importowane
z mastera, nie skutek rozwiązania konfliktu. Runtime/browser potwierdzenie
tego findingu: NOT VERIFIED. Nie zmieniano mechanizmu kamery w aktualizacji Git.

Aktualizacja źródeł nie jest wdrożeniem nowego backendu ani ponowną walidacją
naukową. Aktywny workspace korzysta ze wcześniej zbudowanego backendu;
frontend dev może przeładować zmienione źródła. Nowe HUD/authoring wymagają
oddzielnego dowodu runtime przed kwalifikacją produktu.

S00–S12 i szersza integracja solvera do mastera pozostają otwarte.


## Korekta po terminalnym CI — 13.10.2026

CI `37845860140` dla `c8a8dd5e4749d180f5cf3f2e46e5bdaa8a466de2`
zakończyło się FAILURE. Capture-contract PASS; native scene: 79 PASS / 1 FAIL;
frontend nie wykonał regresji po awarii Doctor. Poprzednia informacja
„CI oczekuje” opisuje checkpoint historyczny, nie aktualny wynik.

Naprawy tego przyrostu:

1. Scene parallel_execution przyjmuje wyłącznie obiekt lub null. Serde
   dopuszczało reprezentację sekwencyjną struktury, w tym pustą tablicę z
   defaultami. Deserializer odrzuca ten niekanoniczny kształt; null nadal
   przywraca serial, a obiekt adaptive zachowuje intencję. Regresja obejmuje
   pustą i pełną tablicę, nieznane pole i legalny adaptive.
2. Frontend checkout pobiera pełną historię. Doctor działa w checkoutcie
   źródeł (binarium pochodzi z managed workspace), ale fetch-depth 32 nie
   gwarantowało obecności bazowego commita po merge. Osobna kontrola
   cat-file/ancestor kończy CI błędem przed Doctor przy braku właściwej bazy.
   Zakres i bazowy commit pozostają niezmienione; nie wyłączono reguł.

Diff check i parser rustfmt PASS. Testów jednostkowych lokalnie nie
kompilowano. Wykonanie regresji i Doctor wymaga świeżego GitHub Actions;
wynik nie jest jeszcze potwierdzony. Nie zmieniono solvera, progów residualu
ani istniejących danych. Pełne S00–S12 i kwalifikacja naukowa pozostają OPEN.


## Wynik weryfikacji i kolejny runtime — 13.10.2026

Commit naprawy `00b14fb05acd597a1506b3b191a1166631ce2368` jest na remote.
CI https://github.com/MateuszZelent/fullmag/actions/runs/38357947899 zakończone
SUCCESS: frontend, native-resource-contracts i capture-contract PASS.
Oznacza to zamknięcie obu poprzednich awarii tej konfiguracji CI, nie naukową
kwalifikację solvera lub akceptację projektu interfejsu.

Runner potwierdzony healthy/accepting, bez aktywnych buildów. Wykonano managed
serial preflight i rzeczywistą próbę `de-smoke-parallel-probe` na runtime #241
`4ebf0c524ca2479eab4672836694586d`, source digest
`711a91e06a61f5b9dd0352959dd96ef5fd356be1268079f826cd859031cea66d`.
Dry-run PASS; wykonanie terminal FAILED/exit1 przed eigensolve.
Output: `storage/runs/dispersion-mode-ui-20261008-9aae306a4b5f5e7d/4ebf0c524ca2479eab4672836694586d/comsol-dispersion/bf0e6c0f6a3643629a35769db4997f9f`.
Runtime.log: `scoped layer-partitioned realization requested 3 layers but resolved 9 exact z intervals`.
Nie zmieniono wymagania trzech warstw ani guardu; nie zlecono adaptive dla
odrzuconego modelu. Nowszy solver checkpoint `1827c3436f80ff17396c285d13c0e269eecf4b25`
zawiera rozbudowane poprawki _gmsh_swept/_gmsh_fields; ich zależności i dowody
należy sprawdzić przed integracją. Cudzy dirty worktree pozostaje zachowany.

Wykonano niezależny postsolve siedmiu wcześniej obliczonych punktów #241:
parametry z rzeczywistego metadata, dokładne sample_index/k/frequency z JSON
modów, full residual <=1e-8 i pełne lokalne descriptor certificates.
Raport z hashami wejść i źródeł orakli, PNG/PDF:
`storage/runs/dispersion-mode-ui-20261008-9aae306a4b5f5e7d/postsolve-seven-20261013-e2b3056ac79a453bb4c3fc73a86edfa4`.
Nie są to nowe punkty FEM. Względem istniejącego finite-Dirichlet n=0:
Gamma praktycznie 0%, ±5 około -0.0733%, ±15 około -0.5345%, ±25 około -1.255%.
Open-film thickness N=32 pozostawia około -1.023% przy ±25 i ma inne BC.
N=0 jest przybliżeniem; ten raport nie ustala przyczyny różnicy i nie zamyka
zbieżności siatki/airboxu/gałęzi ani porównania COMSOL. Wykres sprawdzony wizualnie.

Następna zależność planu: integracja sprawdzonej realizacji warstw przy
zachowaniu owner-scoped zagęszczenia -> aktualny managed runtime -> powtórzenie
serial/adaptive probe -> kontrola parytetu -> signed DE/BV i zbieżność.
Docelowy projekt UI oraz pełne S00–S12 pozostają OPEN.


## Przyrost naprawy siatki próby parytetu — 13.10.2026

Po rzeczywistym błędzie 3→9 wybrano ograniczoną closure zamiast merge 380
niepowiązanych plików nowszego brancha. Przeniesione źródła:

- `f1645a398bb2c65761ca18975152c69c4bf5febf`: jawne single-layer GEO extrusion.
- `a0999b68c541e4fef23105304d0de7b06f4040e1`: quality volumes do SI i testy.
- `096fa6a311c816b9b134caa4538898d67cad4721`: ponowny certyfikat końcowego SI mesha.
- `d8bbe5226422cf7eaec26c09e54a72fd7942b8cf`: zachowanie immutable MeshData.
- `a4d93372c73da71f917ad70eb81dfda5b34e26a7`: korekta nieprawdziwej deklaracji
  realizacji interior-only regional density przez kopiowaną cap triangulation.

Zachowano exact-count, brak dodatkowych poziomów z, dodatnie komórki i guardy
periodyczne. Prawidłowe warstwy nie dowodzą realizacji wszystkich pól 3D.
Nie przeniesiono nowszych cap refinements bez oddzielnej diagnozy: actual-Gmsh
CI38041254243 dla1827 pozostaje FAILURE (mixed pyramid quality i ring metric);
CI38045443734 dla27af ujawniło dodatkowe exact-layer failures. Te dowody nie
stanowią kwalifikacji importowanego stosu.

Regresja `test_scoped_periodic_box_keeps_exact_layers_before_modal_probe`
wykonuje rzeczywisty Gmsh:40×40×10nm, owner-scoped5nm, ±2um airbox,
3/6layers, PBCxy; sprawdza płaszczyzny, nieprzecinanie warstw, objętość filmu,
dodatnie tetraedry i pełne mapowanie obu osi także w powietrzu.
Dedicated CI job `exact-layer-mesh` wykonuje tę regresję oraz istniejące
periodic/topology tests i quality-unit tests. AST i nota0104/source-map PASS.
Nie kompilowano testów lokalnie. Świeże CI i managed runtime pozostają
NOT VERIFIED do otrzymania rzeczywistych wyników.


## Wyniki rzeczywistego Gmsh i korekta regresji — 13.10.2026

Dla commita `749166ed8e4463c65b2f7620ed1c077652b5d28b` job
`exact-layer-mesh` w CI38360281635: **37 PASS, 1 FAIL**.
Nowe scoped 3/6-layer i quality SI checks przeszły. Jedyny błąd tego
zestawu to historyczna nazwa `geo_layered_tetrahedral` w publicznym DE
fixture; raport dla owner-scoped realizacji zgodnie z kodem zwraca
`geo_layer_partitioned_tetrahedral`. Skorygowano dwie asercje nazwy;
nie zmieniono kryteriów geometrycznych. Dodano bezpośrednie sprawdzenie
zwróconego accepted periodic certificate i niepustych komórek każdej warstwy.
Review źródeł nie znalazło blokującego błędu, wskazało te dwie luki testowe.

Osobny CI38360281511 actual-Gmsh: **309 tests, 1 FAIL, 1 SKIP**.
`test_direct_layered_box_region_floor_beats_eligible_upper_actual_density`
dla thin_film_tetrahedral nie znalazł elementów wewnątrz lokalnego
regionu (`region_lengths=[]`). Jest to otwarty problem realizacji
zagęszczenia, nie błąd nazwy. Nie usunięto testu ani nie poluzowano
kryteriów gęstości. Managed serial/adaptive runtime pozostaje NOT VERIFIED.


## Potwierdzone CI i następna bramka — 13.10.2026

Commit `335c09de2a3e4088a0ad806041166fb5f7034e60`, CI38361400702:
**4/4 jobs SUCCESS** (frontend, native-resource-contracts,
capture-contract, exact-layer-mesh). Real-Gmsh exact-layer suite:
**38 PASS w 8.85 s**. Asercje obejmują zwrócony accepted certificate,
niepuste slaby, scoped 3/6-layer, PBC oraz quality SI. Nie jest to
runtime tego commita ani pełna regional-density kwalifikacja.

Oddzielne CI38360281511 pozostaje FAILURE: interior cylinder nie ma
wybranych ROI tetra centroidów. Przekrój źródłowy scoped sweepu leży
poza z-supportem regionu, a meshed extrusion kopiuje XY topologię.
To hipoteza przyczyny oparta na źródłach; następna diagnoza musi
zachować actual mesh i liczniki ROI/per-plane, także gdy ROI jest pusty.
Naprawa nie może rozciągać lokalnego pola przez cały airbox ani
osłabiać exact-layer/density gates.

Runner ponownie sprawdzony: zdrowy, accepting, idle, brak aktywnych
jobów, profil runtime-v2 dostępny. Wolne9302654976 B (~8.66 GiB)
przekracza jedynie próg przyjęcia; poprzedni pełny build potrzebował
około27 GB. Nowego buildu nie uruchomiono przed zapewnieniem
headroomu. Pytanie operatora o30–40GB pozostaje pending.
Pełne S00–S12: OPEN; signed DE/BV, serial/adaptive parity,
COMSOL, mesh/airbox/mode-count convergence, S09/GPU, accepted UI,
review i integracja pozostają odrębnymi bramkami.


Reguły sprzątania etapów zapisano na żądanie użytkownika w AGENTS.md,
commit `2d96418cc85f68d15eb5c47d966f57edf081d455`. Utworzono lokalny
skill `fullmag-build-stage-cleanup`; quick_validate PASS. Nie zmieniono
wdrożonej retencji: policy=preview, runtime_retention_enabled=false.
Read-only retention-plan zakończył się timeoutem; nie wykonano usuwania.

Diagnostyka regional density zachowuje pusty ROI jako count=0 i null
statystyki, bez błędu min(empty). Actual-Gmsh fixture zapisuje pełną
siatkę/ROI, report, inputs i plane counts przed zachowaną oryginalną
asercją; workflow publikuje failure evidence. Jest to poprawka diagnostyki,
nie realizacji regionalnego zagęszczenia. AST/YAML/diff PASS;
nowa regresja helpera oraz actual capture wymagają świeżego CI.


CI38363256813 nie utworzył żadnego joba: workflow używał runner.temp
w job.env. GitHub context-availability dopuszcza runner dopiero w step.env,
nie job.env. Przeniesiono env do kroku actual-Gmsh; upload path bez zmian.
Źródło: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
YAML i kontrola umiejscowienia env PASS; świeże CI wymagane.


## Actual mesh evidence regionalnej awarii — 13.10.2026

Commit `8ef77fb1d1da7d203e98a4e149172ba1ca3d8eb0`,
CI38363500597: **309 tests, 1 FAIL, 1 SKIP**. Empty-ROI capture
regression PASS; artifact11795852756 opublikowany i pobrany. NPZ SHA256:
`05a94dfcce2c01c5357a3fa137d65c1a90ad03009f7d258fa990550eeb28d9cd`.
Analiza niezależnie przeliczyła przekroje i centroidy z zapisanych węzłów:

- z-plane [nm]: -40,-33,-20,-10,0,10,20,33,40; każda ma15 węzłów.
- Wszystkie przekroje mają identyczny zbiór XY; w dysku r<=15nm tylko1 węzeł.
- Magnetic tetrahedra108; w ROI0; w centralnym zakresie |z|<=4nm36.
- Minimalny promień centroidu magnetic/central wynosi17.24990173470108nm,
  czyli przekracza zadane15nm. Bulk edge median33.70151208888nm.

To potwierdza kopiowanie zbyt rzadkiego cap mesh przez body i air;
nie jest wyłącznie błędem statystyki lub tolerancji membership.
Gmsh4.15.2, numpy2.4.6, scipy1.17.1. Plan naprawy musi realizować
właścicielskie wymagania przestrzenne na magnetic przekrojach/slabach,
zachować exact-z/PBC i zgodność interface-air. Nie wolno podmienić tego
na globalne XY zagęszczenie, nowe ukryte z-planes ani osłabione progi.
Zachowany ROI/artifact pozwala rozstrzygnąć poprawkę rzeczywistą siatką.


## Zgodne zmienne przekroje i odmowa capture — 13.10.2026

Pierwsza próba niezależnego Delaunay na dwóch slabach została odrzucona:
coarse/fine/coarse z pięcioma punktami centralnymi dało po23 tetraedry,
w tym po1 zerowym, i niezgodne triangulacje wspólnego capu. Nie zastosowano
QJ, usuwania komórek ani osłabienia kontroli. Nowy kernel zaczyna od zgodnej
siatki Freudenthal i przez wspólne stellar splity face/edge wstawia istniejące
punkty. Dokładne predykaty binary64/Fraction zachowują wejściowe węzły,
płaszczyzny i wszystkie interfejsy. Source review objął cały moduł i testy;
poprawiono ciche obcięcie współrzędnych complex oraz fixture duplicate.
Interpretowany pytest:6PASS/11subtests,1.14s. Dokumentacja source-map oraz
38 lekkich kontroli dokumentacji PASS; workflow zawiera nową regresję.
Nie uruchomiono Gmsh ani eigensolve tym kernelem. Jest to fundament naprawy,
a nie zakończony regional-density gate. Wymagane dalej: właściwe capy z pól
3D i owner scopes, lower/upper size validation, jakość, PBC, regiony i runtime.

Runner zdrowy/idle, profil runtime-v2 dostępny,29709012992B wolnego.
Źródłowy diff od poprzedniego runtime241 nie zmienia native FEM/Cargo.lock,
a cache profilu runner-fem-cpu-slepc-runtime-v2-7139ca2622b6 istnieje.
Zlecono raz `just runner-build commit fem-cpu-slepc-runtime-v2
20c8faa4d27ae9cb3fd8589bbe86ea4a25028e11`. Klient zakończył się exit2 przed
submit: `cannot safely clean linked capture stage: content object is writable`.
Nie wykonano kompilacji ani ponownego submit. Właściciel błędu:
source_store.py::_verify_object i source.py::_cleanup_capture_stage.

Obiekt CAS689bc83234b95e245a3bbcdb8d66f2c857b4daacb8a57be834a002751cabf37e-100644:
23B, SHA256 zgodny, Windows attributes32 bez ReadOnly,5hardlinks.
Cztery odwołania to .dockerignore w source kapsułach tego worktree:
f0b36bded62f43a4a6a57e33592d8d9e,78bd7f3ca7ab4fb49f49f3e1ca63e105,
e6c5a1d7084e4afe93e9311f90627347,0b62f16a15904633b44a508b3a4655e4.
Ograniczona próbka30plików starszej kapsuły f0b36... także nie ma ReadOnly.
Nie zmieniono flag ani bajtów, nie usunięto cache, nie ominięto walidacji.
Następny krok runtime musi rozwiązać niezgodność uszczelnienia obiektów CAS
na granicy Windows/kontener i uzyskać nową zweryfikowaną kapsułę.
Pełne S00–S12, nauka, COMSOL, serial/adaptive, S09/GPU i integracja OPEN.


## Sprzątanie prywatnego stagingu capture — 13.10.2026

Naprawiono kolejność `SourceContentStore.unlink_stage_link`: najpierw
kontrola typu i tożsamości pliku oraz rozróżnienie prywatnej kopii od
hardlinka CAS, potem pełna weryfikacja obiektu dla rzeczywistego hardlinka.
Po weryfikacji ponownie sprawdzana jest tożsamość stagingu. Błędny albo
writable obiekt CAS nadal jest odrzucany; nie jest automatycznie naprawiany.
Niepowiązany z nim plik prywatnego stagingu może zostać posprzątany przez
istniejący caller zamiast pozostawić całą paczkę po nieudanym capture.

Regresje: dwa przypadki RED przed poprawką, te same przypadki GREEN po
poprawce; cały interpretowany unittest source-store:12PASS,26.090s.
Nie kompilowano lokalnych testów jednostkowych. AST obu plików i YAML
workflow PASS; suite dodano do capture-contract w GitHub Actions.
Przegląd obejmuje zachowanie ochrony uszkodzonych hardlinków i zachowanie
bajtów CAS. To poprawka źródłowa, nie dowód powodzenia managed buildu.

Na HEAD10ac5e50c87769eb3a803263a1743a33d78be2d9 CI38368910997
SUCCESS4/4; exact-layer:44PASS/11subtests. CI38368910913 SUCCESS.
Scoped-mesh CI38368910881 pozostaje FAILURE:309tests,1FAIL,1SKIP;
regionalny ROI nadal pusty, bo prototyp nie jest podłączony do produkcji.

Osobny preview operatora wykazał7721 poprawnych hash/size obiektów CAS
bez ReadOnly oraz98 uszczelnionych. Przywrócenie flag dla dokładnej listy
wymaga odpowiedzi na przedstawioną propozycję; nie wykonano tej mutacji.
Ta poprawka stagingu nie usuwa blokady integralności przy nowym capture.
Pełne S00–S12, regionalne owner fields/PBC, fresh runtime, serial/adaptive,
zbieżność, COMSOL, S09/GPU, GUI i integracja nadal OPEN.


## Translacyjna zgodność faset prototypu — 13.10.2026

Nowa regresja kernela sprawdza obie osie x/y: istniejące pary węzłów
brzegowych na trzech capach o różnej gęstości oraz cały zbiór trójkątów
zewnętrznych po translacji. Kontrola nie opiera się na samych liczbach
węzłów/faset; wykorzystuje pełny mesh contract, incidence i geometryczne
klucze trójkątów. Interpretowany pytest:7PASS/13subtests,1.16s.
To dowód dla małego fixture kernela, nie certyfikat dowolnej siatki PBC.
Produkcja nadal wymaga bijektywnego node mapping, markerów, zgodnych
faset oraz Floquet/solver proof. Nie wykonano lokalnej kompilacji testów.


## Actual Gmsh → zmienne capy → kernel — 13.10.2026

Fixture wykazał błąd początkowej diagnozy timeout: hmax podano w SI tam,
gdzie helper oczekuje już jednostek Gmsh. Poprawiono tylko jednostki testu,
bez zmiany modelu/targetu. Meshed extrusion z produkcyjnymi argumentami
numElements=[1],heights=[1],recombine=True kopiuje cap XY:43/43/43nodes,
ROI3/3/3. Geometry-only extrusion z tym samym Restrict/VolumesList i
IncludeBoundary=1:43/56/43nodes,ROI3/11/3; shared cap i exact-z zachowane.
Interpretowany test porównawczy2PASS; geometry-only rozszerzony o kernel
1PASS/1deselected.142rzeczywiste SI nodes bez snapu,404tets,142/142nodes
użyte,90 zgodnych faset middlecap,51 centroidówtetwROI, volume relative
error7.35e-16. Kernel0.6198052s.

Dodatnia topologia nie wystarcza: minimum determinant3.6786376201e-35m^3
wygląda na bardzo cienki tetraedr; trwa osobny pomiar jakości bezwymiarowej.
Nie podłączono tego wyniku do produkcyjnego eigensolve, nie usunięto
żadnego węzła/komórki ani nie zastosowano jitter/snap. Adapter MeshData
z markerami i pełnym mappingiem fasetPBC jest implementowany osobno.
Geometry-only sam nie rozwiązuje jakości, lower/upper controls i runtime.
CIaaea731b5 (`38379025215`) zakończone SUCCESS4/4. Pełna kwalifikacja S00–S12OPEN.

Pomiar bezwymiarowy actualcapskernel: det/max_edge³min1.2177e-14,
pervertexdet/edgeproductmin3.0985e-14;386/404tetów w histogramie[0,.1).
Najgorsze trójki capnodes są około1e-19m od linii. To poważne ryzyko
sliverów; topologyPASS nie dopuszcza productionrouting. Nie porównano
bezpośrednio tych metryk z SICN/gamma lub mixedcertp05 i nie zmieniono
progów. Recepta diagnosticCI używa pytest-s, aby zachować actualmetrics
w logu także przy zielonej kontroli topologii. Naprawa jakości jest teraz
jawnym warunkiem poprzedzającym runtime tej nowej ścieżki.


## Wewnętrzny adapter MeshData — 13.10.2026

build_layered_box_mesh_data używa kernela i istniejącego CSR MeshData.
Regiony magnetic1/air2 z exact slab containment, interface10 z normals
magnetic→air, exterior z outward incidence. Pełne x/y bijections, translation
boxwidth, triangle-set equality oraz x/y commutation są walidowane.
Nie tworzy certificate/quality/realization ani sztucznych near/far_air części.
Review poprawił U1→U4 topology string arrays, odrzucenieboolbounds i usunął
nieuzasadnione przypisanie wszystkich aircells dofar_air.14 interpretowanych
regresji PASS,1.40s; AST/YAML/scientificmap/diff PASS. Nie budowano unit tests.
To prototypowa realizacja kontraktu, nie productionrouting; stwierdzone
actualGmsh slivery nadal wymagają naprawy przed FEM. Source-map i istniejący
exact-layer CI obejmują adapter. Pełne S00–S12 nadalOPEN.

## Zgodne polepszanie capów — 13.10.2026

Po actual diagnostyce dwóch sliverów około1e-14 zaimplementowano dokładne
cap-edge flips: strictly convex quad, common apex w każdym slabie,
jednoczesna zmiana shared cap, niezmienione nodes/cavity boundary i sumdet
osobno per slab. Wybór to strict lexicographic increase sorted exact Q²;
cache canonical tet keys, geometry-sorted traversal, restart po zmianie,
bez arbitralnego iteration limit lub jakościowego success threshold.

TDD: dwie regresje RED przed implementacją. Kernel+adapter24PASS/13subtests
w5.96s; dodatkowo odmowa częściowego flipu przy niezgodnych apexes.
Root przejrzał cały diff. Actual Gmsh2PASS w19.29s: kernel15.08s,
142nodes/404tets,90shared middlefaces,40ROIcentroids, wszystkie nodes użyte,
volume relative error4.90e-16, minimum det/max_edge³2.088095e-4
(wcześniej1.2177e-14), min per-vertex determinant/product norms4.440676e-4.
Dokładny cavity proof i log: visualization layered-cap-sliver-diagnostic-20261013.

Ta poprawka usuwa skrajne slivery w badanym prototypie. Pozostała jakość,
lower/upper regional size i produkcyjny routing nadal OPEN. Dla większej
siatki koszt wielokrotnych exact rescans wymaga poprawy przed zastosowaniem
produkcyjnym. Wskaźniki nie zastępują SICN/gamma ani polityki0105.
Świeży managed capture nadal oczekuje autoryzowanej naprawy ReadOnly CAS;
żadnych obiektów CAS, wyników ani cache nie zmieniono.

## Koszt exact cap flips — 13.10.2026

Baseline b101530745ddd0d69c73c0b2c183a851540b798e ma CI38384634580
SUCCESS4/4 i artifact-consumers38384634591 SUCCESS. Scoped-mesh-fields
38384634688 nadal FAILURE:309tests,1FAIL,1SKIP; log potwierdza pustyROI.
Production routing nie zostało podmienione na prototyp.

Profil real142node/404tet ujawnił36958candidatechecks,121544orient3d,
622capscans. Nowy cache przechowuje signed determinants według orderedtet,
strictconvex według niezmiennegoquad, geometryrank i capmap wszystkich
planes w jednym przebiegu. Ownerzy/istnienieprzekątnych/duplicate guards
są nadal sprawdzane na aktualnej topologii; ścisłe predykaty i porządek
zaakceptowanych zmian pozostają identyczne.

Focused24PASS/13subtests (3.13s), odrębna signedcache regression1PASS(0.97s).
ActualNPZ output dokładnie identyczny z zapisanym baseline; jeden pomiar
przed17.779s/po4.418s. Root actual-Gmsh2PASS/8.58s: kernel4.216s,
142nodes/404tets,90sharedfaces,40ROIcentroids i niezmienione metryki jakości.
Cachememory niezmierzone; brak large-mesh/runtime/sciencequalification.
Dalsza naprawa musi spełnić jakościowe i regional lower/upper gates,
zachować Box/ring distinction i potem umożliwić właściwy managed sweep.


## 2026-10-13 — falsyfikacja prostych poprawek pól na powierzchniach

Źródła funkcjonalne: checkpoint7b5b6a419 (zmiana względem7a90 dotyczyła tylko
planu). Gmsh4.15.2; dokładny interpretowany produkcyjny test
`RegionMeshPolicyTests.test_direct_layered_box_region_floor_beats_eligible_upper_actual_density`.
Nie zmieniano repo, requestu, progów, warstw ani źródłowych asercji w probe.

Baseline thin-film:135 węzłów,108 magnetycznych Tet4, z-planes[-10,0,10]nm,
node counts[15,15,15], zero komórek przekraczających wewnętrzny cap.
ROI ma0 tetraedrów/0 krawędzi. Bulk median33.70nm/max49.16nm.
Free-tetrahedral subtest ma24 Tet4 w ROI i przechodzi istniejącą asercję
median4–12nm (11.23nm baseline;11.54nm w kolejnej realizacji).

Dwa niezależne runtime monkeypatch eksperymenty nie naprawiły thin-film:

1. IncludeBoundary/IncludeEmbedded na obu właściwych Constant owner masks,
   VolumesList[4,5], VIn1/VOut0: te same135/108, ROI0, exit1 przy
   `assertTrue(region_lengths)`.
2. Jawne jednorazowe generate(2) po instalacji wszystkich24 pól i przed
   istniejącym generate(3): te same planes/counts/ROI0, exit1 w tej samej asercji.

Nie wdrażamy tych sfalsyfikowanych poprawek. Kolejna hipoteza do sprawdzenia:
jawna coverage pól upper/lower na powierzchniach dokładnych body owner volumes,
łącznie ze wspólnym capem (deduped getBoundary oddzielnie dla każdej objętości).
Jeśli to nie zmienia rzeczywistego mesha, należy zbadać lineage/ograniczenia
meshingu po geometrycznym extrusion. Zarejestrowane pole i poprawny h_target8nm
nie dowodzą wykonania regionalnej gęstości. Production gate pozostaje FAIL.

Dowody operatorowe: visualization layered-cap-sliver-diagnostic-20261013,
scoped-mesh-field-boundary-probe.py oraz baseline/patched/surface.log.
Nie traktujemy probe jako managed runtime ani jako naukowej walidacji eigensolve.


## 2026-10-13 — potwierdzona lineage capów i częściowe wznowienie CAS

Trzecia próba Gmsh: jawne SurfacesList na Restrict10 i owner masks15/20,
pozostawione VolumesList[4,5], VIn1/VOut0. Deduped granice objętości pobrane
oddzielnie obejmują wspólny cap92. Po generate(2) każda płaszczyzna
−10/0/+10nm ma18 trójkątów, identyczną triangulację XY i0 centroidów
trójkątów w radius15nm. Fasety Tet4 dokładnie odtwarzają te cap triangles.
Nadal135nodes/108magneticTet4/ROI0, exit1 przy niezmienionej asercji.
`geo.extrude(..., numElements=[1], recombine=True)` kopiuje tę samą
siatkę capów; dodatkowe flagi/powierzchnie/premeshing nie realizują pola
zależnego od z. To bezpośredni dowód ograniczenia trasy, nie poprawka.

CAS: druga operacja zatrzymała się terminalnie po2537 verified przy
niekompletnym state=error rekordu koordynatora. Receipt2537 wierszy
sprawdzony względem approved preview SHA256e4592b39ed5daf81211411eab0be3439540b2c228074a69bf05cb0fee22e88ef.
Runner ponownie potwierdził healthy/idle, bez active jobs i retention.
Operator resume_approved_readonly.py fizycznie sprawdził hash/size/identity/
link_count/ReadOnly wszystkich2537 obiektów pod blokadami przed wznowieniem.
Wznowienie unified-exec72887 zakończyło się exit1 po kolejnych123 obiektach;
receipt apply-20261013T113613647521Z.jsonl. Łącznie2660/7721 verified.
Przyczyna: odczyt statusu koordynatora zwrócił FileNotFoundError dla
/storage/index/local-runner-service.json. Nie wykonujemy ślepego restartu
ani nie ignorujemy błędu kontroli healthy/idle; potrzebna diagnoza publikacji rekordu.
Nie zmieniono zawartości ani nie usunięto danych. Kolejne błędy zatrzymują
proces, bez automatycznego retry. Miejsce około7GB poniżej progu8GiB;
nowego managed buildu nie zgłoszono.

4→4: po wcześniejszej odmowie automatycznego review użytkownik jawnie
zatwierdził dokładną propozycję i oba pliki źródeł/testów. Root read-review
i ponowne10/10 syntetycznych checks PASS. Rozpoczęto adaptację do kernela;
wynik integracji i pomiar actual mesh pozostają do sprawdzenia.
Zgoda usuwa blokadę uprawnień, lecz nie zastępuje kwalifikacji produkcji.

Dalsza hipoteza geometryczna: actual cap-node sets43/56/43 mają23 wspólne
XY we wszystkich płaszczyznach (outer caps43 wspólne). Badamy seed z ich
konformnej pryzmatycznej triangulacji, aby ograniczyć dalekie apices podczas
stellar insertions. To eksperyment poza repo; żadnej produkcyjnej zmiany
ani domniemanej kwalifikacji nie dokonano.


## 2026-10-13 — zatwierdzony ruch 4→4 i odrzucona hipoteza seed23

Po jawnej zgodzie użytkownika ruch 4→4 jest włączony po cap-quality pass
i przed niezmienionym końcowym walidatorem kernela. Review objęło cały
nowy algorytm i regresje: exact closed convex cavity, SAT, dodatnie orientacje,
identyczne granice/capy i objętość, nowa nieobecna krótsza przekątna,
niepogorszone minimum lokalnego Q² oraz malejący globalny profil krawędzi.
Nie zmieniono publicznego DSL/IR, nodes, exact planes ani progów jakości.
Kernel: 15/15 interpretowanych testów PASS; zmiana numeracji i kolejności
komórek oraz przesunięcie zachowują geometryczny wynik. Dokumentacja/mapa
źródeł PASS, 38 testów kontraktu dokumentacji PASS.

Actual baseline142/404: 43 ruchy, pełny exact validator PASS.
Global unique-edge p95 113,578→109,991 nm; max144,568 nm bez zmiany.
Nie jest to p95 hK per komórka ani zaliczenie regionalnej bramki.
Kontrprzykład: box-ROI hK p95 129,258→130,064 nm, cylinder-ROI
135,705→136,510 nm; zmiana centroidów zmniejszyła counts40→39 i32→31.
Global minQ²4,36014e−8 i global hKp95134,536 nm bez zmiany.
Cylinder all-six-edge median62,017 nm bez zmiany. Poprawa globalnego
zbioru krawędzi nie gwarantuje regionalnych statystyk; nie włączamy tego
prototypu do produkcji jako rzekomej naprawy gęstości.
Wymagane pozostają produkcyjne routing/size/PBC/quality i fresh runtime.

Niezależny eksperyment seed23 nie został wdrożony: choć exact validator
przeszedł dla356 tetraedrów i wszystkich142 nodes, cylinder ROI mediana
wszystkich sześciu krawędzi pogorszyła się62,017→64,032 nm,
hK p95 135,704→144,568 nm, global minQ² 4,36e−8→6,30e−28.
Ścisły PBC helper odrzuca zapisany baseline i kandydata; brak Gmsh pairs
w NPZ nie daje podstaw do certyfikacji. Nie osłabiamy tego sprawdzenia.
Dowody poza repo: common23-staircase-cap-seed-report.md/.json i connectivity
w visualization layered-cap-sliver-diagnostic-20261013.

Pełny cel S00–S12 nadal OPEN. Ten etap jest poprawką wewnętrznego kernela,
a nie końcową kwalifikacją solvera, całej siatki ani UI.

Weryfikacja konsumentów po zmianie: adapter MeshData14/14 PASS (3,52 s),
actual Gmsh cap sampling2/2 PASS (16,715 s), exit0; bez kompilacji testów.
Dowód actual4→4: interior-4to4-actual-fixture-report.json SHA256
cf036e26a3cec341b8727afb54d72fd7978d18d38c441ec23d07cb731c652f7b;
connectivity SHA256 f91838d27d3e713ab8775ed7c16ba6d3daea9d949ac6c78a2d53a52e0ca35ccc.
Root review i final source/test SHA zgodne z dowodami; brak zmian public API.


## 2026-10-13 — ograniczone ponowienie odczytu statusu runnera

Naprawiono czytnik `_service_record`: wyłącznie FileNotFoundError po dodatnim
exists() prowadzi do najwyżej trzech odczytów z dwiema przerwami po10ms.
Trwały ENOENT, błędny JSON, PermissionError i inne I/O nadal zwracają error;
nie oznaczają zdrowego runnera. Nie zmieniono CAS validation, danych ani kolejki.
Dokładna przyczyna chwilowego ENOENT na bind mount pozostaje nieustalona.
Reprodukcja wykazuje błąd czytnika; nie dowodzi, że os.replace usuwa rekord.

Testy interpretowane: moduł container_main33/33 PASS; szersze scripts/tests/
local_runner91/91 PASS; resolver storage48 tests PASS/2skips.
Szersze scripts/test_local_runner_*:341 tests,1FAIL/2skips; failure jest w
RetentionPlanTests.test_execution_progress_is_measured_and_does_not_change_fingerprint.
Nie osłabiamy fingerprint; trwa diagnoza różnicy metadata między odczytami.
Nie wdrożono poprawki do działającego obrazu ani nie zgłoszono native buildu.

Runner live image sha256:69422110f29c0897e9872ae9f6227e9c9fc34e6d640774268c8e012b81cf0814;
API healthy/idle, bez active jobs i retention;5,38GB wolnego poniżej8GiB.
Przed wymianą obrazu wykryto9 plików źródeł i2 pliki UI różne od checkoutu.
Profile/cataloque/executor pozostają identyczne, ale pełna aktualizacja wymaga
zachowania tych kontraktów i właściwych bramek; nie wykonano ślepego restartu.
Zachowany snapshot29 plików kodu i diff w visualization runner-status-read-repair-20261013,
bez lokalnej konfiguracji/tokenów/danych jobów.

Propozycja SciPy Delaunay dwóch slabów dała krótsze krawędzie, lecz została
odrzucona: raw516tet zawiera18 exact-zero simplexów. Osobny subset498tet
zachowuje142nodes, exact slab volumes i90 wspólnych cap triangles, ale ma
16 wolnych faset o dodatnim exact polu poza Box/cap. Cztery zero-simplexy
łączą dwie różne triangulacje dokładnie współpłaszczyznowych pionowych quadów.
Same sumy objętości nie dowodzą zgodnej triangulacji. Bez wdrożenia/tolerancji;
badana jest wyłącznie konkretna geometryczna przyczyna gapów.

## 2026-10-13 — fingerprint retention i przygotowany obraz koordynatora

Izolowana diagnoza wykazała zmianę wyłącznie st_mtime_ns katalogu nested
po zapisaniu pliku potomnego na Windows 11/CPython 3.12.2. Mismatch
odtworzono też bez progress callback (31/40); ustalenie mtime po zapisach
dało 0/40 różnic. Dokładny mechanizm systemu plików pozostaje nieustalony.
Fixture ustala mtime przed baseline; produkcyjny fingerprint i asercja
równości bez zmian. Focused20/20 i moduł13/13 PASS. Dowody w visualization
runner-retention-fingerprint-diagnostic-20261013.

Przez just runner-coordinator-image przygotowano obraz
sha256:3a81b67a35d3c5f6778b4079d7187b89f0baa6d9c36e7a609c1687bcfd898564
ze źródeł 5f76503e201d8eab03bd5e2077030a242774e3e4 (exit0).
Obraz nie został wdrożony. Działający koordynator pozostaje na69422110…;
CAS ReadOnly nadal STOPPED2660/7721. To nie jest build FEM ani dowód
wykonania nowej poprawki w runtime.

Dokładna propozycja reconciliation2→2 usunęła jeden z czterech quad mismatch.
Trzy pozostałe mają różne przeciwległe wierzchołki, więc prosty cone flip
jest niedopuszczalny. Pozostało12 wolnych off-boundary facets; pełny validator
oraz PBC nadal FAIL. Kandydat odrzucony, bez zmian produkcyjnej siatki.
Zachowane142nodes, cap90/90 i exact slab volumes nie zastępują zgodności
ścian. Raport: visualization delaunay-slab-proposal-20261013/
exact-quad-2to2-reconciliation-report.md. Dalsza naprawa wymaga zgodnej
triangulacji większych cavities lub bezpośredniej konstrukcji zgodnych
interfejsów; samo usunięcie zerowych simplexów nie naprawia granic.

Pełny cel S00–S12 pozostaje OPEN. Wymiana koordynatora wymaga domknięcia
przeglądu różnic i bramek, a nowy FEM build również miejsca w storage.

Ponowiony szerszy zestaw po poprawce fixture:341 tests/2skips,
121,871s, exit1. Awaria fingerprintu nie powróciła; ujawniono odrębny
ERROR w test_parallel_captures_share_verified_objects_and_keep_v1_identity.
Publication lock znika po FileExistsError, przed _guard_path/lstat;
trwa diagnoza wyścigu zwolnienia blokady. Nie wdrożono obrazu runnera.

## 2026-10-13 — zgodna topologia po legalnym one-sided 2→2

Poprzednia propozycja wymagała dwóch wspólnych apexów i pozostawiła trzy
mismatche. Dalszy exact probe wybiera legalny kierunek: flipuje stronę ze
wspólnym apexem do triangulacji drugiej strony. Wszystkie trzy brakujące
flipy przeszły guards granic cavity, objętości, orientacji, capów, duplikatów,
slab ownership oraz exact SAT również względem otoczenia. Liczba mismatchów
maleje3→0. Pełny niezmieniony validator kernela PASS:142/142nodes,498tets,
0 off-box/internal-cap freefaces,90/90 shared-cap triangles, exact slab volumes.
To postęp topologii; strict PBC helper nadal FAIL jak dla wejścia. Brak
kwalifikacji siatki i produkcyjnego routingu. Rozdzielamy teraz niezgodność
translacyjnych zbiorów węzłów od triangulacji przeciwległych faset; brak
Gmsh node-pairs w zapisanym NPZ nie daje podstaw do pominięcia PBC.
Raport: visualization delaunay-slab-proposal-20261013/
exact-quad-one-sided-reconciliation-report.md; kod repo bez zmian tego probe.

Bieżąca kontrola runnera: healthy/worker_alive, bez active jobs i retention;
free_storage_bytes3430211584 poniżej progu8GiB. CAS2660/7721 bez wznowienia.
Naprawa release-race publication lock w implementacji; bramki i rollout OPEN.

Granica dowodu PBC: helper porównuje surowe współrzędne floating-point
po dokładnej translacji. Produkcyjny adapter wymaga dostarczonej kanonicznej
bijekcji node-pairs, pełnej zgodności triangle IDs i przemienności naroży;
residual translacji porównuje z już zadanym tolerance_m. Dlatego helperFAIL
nie jest sam w sobie dowodem fizycznej nieperiodyczności. Bez canonical
Gmsh maps kwalifikacja produkcyjnego kontraktu pozostaje NOT VERIFIED.
Nie dodajemy nowej tolerancji ani dopasowania węzłów, aby obejść bramkę.

Release-race CAS naprawiony w source_store._publication_lock: po O_EXCL
FileExistsError parent jest sprawdzany no-follow; tylko ENOENT liścia po
ponownej walidacji istniejącego parenta prowadzi do ograniczonego retry.
Reparse/nonregular, utrata parenta i PermissionError pozostają fail-closed;
release ownership, digest i ReadOnly validation bez zmian. Sześć nowych
regresji PASS, cały source_store18/18PASS i parallel capture15/15PASS.
Root review objęło wszystkie linie diffu i dodatkowe okno utraty parenta,
reparse pojawiający się po initial guard oraz retry przed upływem deadline.
Szerszy zestaw po poprawce:347tests,2skips,159,251s,exit0.
Log: visualization runner-retention-fingerprint-diagnostic-20261013/
runner-regression-after-lock-fix.log. To dowód źródłowy, nie deployment.
Przygotowany wcześniejszy obraz3a81 nie zawiera tej późniejszej poprawki;
przed rollout trzeba zbudować nowy obraz z aktualnego checkpointu.

## 2026-10-13 — rollout koordynatora i wznowione ReadOnly

Obraz z commita30e30ccd2 zbudowany przez just runner-coordinator-image,
exit0, sha256:d376e87bf6375eb7821b3a7d6216d53a38b43ffb7cbb7bedfcedac994fce1921.
Zarządzane stop potwierdziło paused, accepting=false, active_jobs=[],
retention_busy=false, retention_draining=true. Następnie container-replace
zakończyło się exit0 i resume zwróciło resumed=true/worker_started=true.
Nowy container6a4b0842f181219b1c16d06c57026be98d6328d8d21f37379340a0944a0b7552;
API potwierdza healthy/idle/worker_alive, bez błędów i aktywnych zadań.
Live source SHA container_main89bc969b…77bb oraz source_storee58301dc…a697
są identyczne z worktree. Dane, mount storage i profile zachowuje managed
replace; nie wykonywano nowego configure, nie usuwano wyników ani wolumenów.
To runtime proof koordynatora, nie FEM/science qualification.

Zatwierdzony repair CAS wznowiono przez resume_approved_readonly_2660.py
SHA2560340a3d58561ee05ea90d480d671dac040787bf4abad09a46035b7909ca1a802.
Ponownie sprawdzono oba wcześniejsze receipty i fizycznie wszystkie2660
obiektów prefixu pod publication locks. Każdy kolejny zapis weryfikuje
niezmieniony approved preview SHAe4592b39…, hash/size/identity/link_count,
zdrowy idle runner oraz zmianę wyłącznie ReadOnly. Bieżący proces nadal
RUNNING, handle39823; receipt apply-20261013T125214695080Z.jsonl.
Ostatnie obserwowane cumulative2688/7721; brak terminalnego sukcesu.

Korekta interpretacji PBC: test_layered_cap_field_sampling.py jawnie nie
kwalifikuje PBC i nie deklaruje setPeriodic/getPeriodicNodes. Zapisanej
nieperiodycznej próbki nie wolno traktować jako periodycznego benchmarku.
Kolejny probe wymaga jawnej periodyczności oraz canonical node-pairs;
nie używamy najbliższych współrzędnych ani nowej tolerancji do zastąpienia map.

## 2026-10-13 — kanoniczny marker air i rzeczywiste powierzchnie PBC

Adapter layered-box błędnie przypisywał air=2, podczas gdy kanoniczna
`_gmsh_extraction._semantic_marker_from_name` przypisuje powietrzu0.
Korekta zmienia adapter na air=0, pozostawiając magnetic=1, interface=10,
whole-slab classification i wszystkie odmowy PBC. Nie wprowadza nowej
publicznej semantyki ani nie przepisuje historycznych wyników.
Regresja porównuje z canonical extraction, a istniejący test nadal dowodzi
objętości obu regionów oraz orientacji interfejsu. Red przed korektą:2FAIL;
green cały moduł:15PASS,3.51s,exit0, interpretowany pytest bez cache.
Root review objęło cały diff źródeł/testów. To korekta prototypu, nie
production routing ani quality/realization certificate.

Rzeczywisty periodic-cap probe na HEAD4211c204: Gmsh4.15.2,exit0,3.4s.
181 global nodes;141 cap nodes na exact planes−10/0/+10nm (43/55/43).
Canonical56 node pairs,4 paired side surfaces,80 matched triangle pairs;
coverage, authored residual oraz3 corner commutations PASS.
X ma15/23 par on-layer i8 off-layer; y21/33 i12 off-layer.
Pełnych map nie wolno zastąpić cap-only subset bez jawnej provenance.
NPZ SHA256e69f20726ff55fef02e4a0e652d8dc57bef310ac71f7788341643b25d29fb85c.
Dowód: visualization/layered-cap-sliver-diagnostic-20261013/
actual-periodic-cap-sampler-probe-report.md oraz JSON/NPZ.
Wynik dowodzi powierzchni2D; volume PBC nadal NOT VERIFIED.

Dodatkowa wykryta luka integracji: rzeczywisty producent Gmsh publikuje
po dwa rekordy x_faces/y_faces dla osobnych slabów i różnych surface markers.
Adapter prototypu wymaga jednego unikalnego pair_id i jednej pary per axis.
Nie zmieniono rekordów ani tolerancji, aby obejść odmowę. Production route
musi zachować zakres faset i node-pair provenance, a następnie wykazać
pełną zgodność trójkątów objętościowej siatki.

Repair CAS nadal RUNNING39823; ostatni odczyt5248/7721.
Nie wykonano retencji podczas naprawy, by nie naruszyć idle guard.
Pełny S00–S12 pozostaje OPEN, bez nowego runtime FEM/science proof.

## 2026-10-13 — objętościowy periodic probe i nadal błędny rozmiar

Kod air-marker zapisano i wypchnięto w74ed88322ee606701b887e922288d877f54817e1.
Actual periodic pool141nodes: kernel400tet PASS,8.443s; wszystkie węzły
zachowane. Niezależne mapowanie faset: x15nodepairs/16trianglepairs,
y21/24, zero mismatch i3 commutingcorners. Adapter z oryginalnymi
czterema side-patch records odmawia duplicate pair_id x_faces przed
triangle validation. NPZ SHA2564a7cabc5761046532c4cc87f8d3d7ff609a7f2a7ed5cb032bf797f750f737181.
Dowód w layered-cap-sliver-diagnostic-20261013/
actual-periodic-cap-kernel-adapter-report.md. Nie jest to certyfikat.

Ten wariant nie rozwiązuje regionalnej gęstości: box ROI37tet,
median6edges58.36nm/hKp95129.32nm; cylinder28tet,63.22nm/125.12nm.
Global hKp95/max134.54/144.57nm, exact det/hK³ min3.1728e-4.
Wszystkie orientacje dodatnie. To nie SICN/gamma. Niezależny nonperiodic
142/498 wariant ma inne węzły; jego niższych rozmiarów nie wolno uznać
za controlled benchmark. Kolejny diagnostic używa Delaunay-per-slab
na SAME141input, bez QJ/snap i bez omijania exact/PBC guard.

CI dokładnego74ed: artifact-consumers38404565985SUCCESS;
scoped-mesh-fields38404566060FAIL:309tests,1FAIL/1SKIP,79.047s,
niezmienione emptyROI assertion test_meshing.py12722 dla thin_film_tetrahedral.
UI38404565728 obserwowane in_progress. Nie przedstawiamy tego jako pełnego CI PASS.

Runner aktualnie healthy/worker_alive,active_jobs=[],retention_busy=false;
storage_free_bytes35116486656. Blokada miejsca ustąpiła; nadal czekamy
na terminalne zakończenie exact CAS repair przed capture/retention/build.
Pre-inventory czterech execution #238–#241: odpowiednio316927274,
647016132,647134298,647348531 logical bytes; nie jest to deletion plan.
Reparse symlinks .so w trzech execution pominięto bez podążania.
Nie usuwano danych, wyników, runtime ani cache. Pełny S00–S12 OPEN.

## 2026-10-13 — ReadOnly CAS terminalnie zakończony

Proces39823 zakończył się exit0; summary succeeded,total_verified7721,
prior_verified2660,verified_this_run5061,modified_this_run5061.
Preview SHAe4592b39ed5daf81211411eab0be3439540b2c228074a69bf05cb0fee22e88ef
bez zmian; bytes_changed=false/deleted=false.
Terminalny receipt apply-20261013T125214695080Z.jsonl i summary zachowane
w visualization/cas-readonly-repair-20261013. Końcowa kontrola wszystkich
7721 wierszy trzech receiptów: ordinal/path/hash/size/identity/link_count
oraz dozwolony attributes_after=attributes_before|1 PASS. Bieżące lstat
wszystkich7721 obiektów potwierdza identity,size,link_count i wyłącznie
ReadOnly. Content hash był sprawdzany pod lockiem przed/po każdym zapisie
w repair; closing scan go nie powtarza. Wynik closing-verification.json.
Blokada CAS została usunięta. Nie jest to jeszcze capture/build/FEM proof.

Delaunay-per-slab na SAME141 periodic nodes zmniejsza hK p95/max do
24.20/26.08nm, ale odrzucenie topologiczne pozostaje widoczne: raw520,
24exact-zero,496positive;88/88 shared-cap triangles,141/141nodes.
Exact validator FAIL exterior face away from box boundary;28 free
verticalfaces. PBC triangle mismatch x6/6,y6/6 pomimo nodecoveragePASS.
Nie uruchomiono napraw ani nie włączono tego odrzuconego wariantu.
Pełny S00–S12 pozostaje OPEN.

## 2026-10-13 — zachowanie markerów PBC dla wielu slabów

Private adapter przyjmuje periodic_patch_z_bounds po pełnym kluczu
(pair_id,marker_a,marker_b). Same-ID rekordy zachowują wszystkie markery,
jedną globalną mapę węzłów i spójną translation/direction/tolerance.
Exact scopes wymagają istniejących planes, pełnego z-cover bez overlap/gap;
singleton może pominąć zakres albo jawnie podać dokładnie cały z-domain.
Odmowy duplicatefullrow, niepełnych/extra keys, offplane, boolean/nonfinite
i niespójnych translacji pozostają fail-closed. Facet classification
daje dokładnie jeden markerpatch per whole face. Validator sprawdza
każdy patch, globalne node coverage, triangle unions i corner commutation.
Expected full-side union pochodzi z geometrycznych faset niezależnie
od role; regresja obu odpowiadających faset przestawionych na exterior
wykazuje odmowę zamiast pozornego PASS. Public MeshData/IR format bez zmian.

TDD red: unexpectedkeyword periodic_patch_z_bounds; green pełny moduł
37PASS,10.52s,exit0, interpreted pytest -p no:cacheprovider.
Root all-line review wskazało singletonexplicit i role-independentunion;
obie poprawki mają regresje. AST/physics-doc/diff gates odpowiednio
sprawdzane przed commitem. Źródło adapter SHA82c066c240efa2c0b2a1784ef0a7618b9bc117f704dd0566f9ac61130354a460;
testSHA78bb184021c6e9832ff1f3db5d24fcc965bee42c41857f8c839dfed18d5122c7.
Nie aktywowano produkcyjnego generatora ani certyfikatu jakości.
Actual producer→adapter replay wymaga explicit marker↔surface provenance;
nie zgadujemy go z numeracji markerów ani kolejności wierszy.
Pełny S00–S12 pozostaje OPEN.

## 2026-10-13 — rzeczywista topologia PBC i jakość kandydata496

Baseline przed implementacją: cfbb55616d28953f28ae7159250234e9be5328b4.
Exact reconciliation na tych samych141 nodes zachowało496 dodatnich tetów:
7 internal flips i6 external paired flips; full kernel validator PASS,
canonical x/y triangle parity PASS, corner commutation12/12.
Actual replay adaptera multi-slab141/400 PASS zachowuje4 boundary records,
36 cap node pairs i63 pełne tablice powierzchni bez zmiany. Oba probe
używają zapisanej provenance Gmsh, nie inferują markerów z kolejności.

Root Gmsh4.15.2 quality probe porównał nowe connectivity496 i seed400
na identycznych141nodes. Volume channel aligned PASS z dodatnim signed
volume SI (rtol1e-12,atol0), suma1.92e-22m3. ROI r15nm/|zcentroid|<=4nm:
median all6edges63.2153→11.3646nm, maxedgep95125.1164→18.5025nm;
SICNmin0.01815→0.38704,gammamin0.001674→0.31113. Global gamma min
0.010499 pozostaje poniżej ostrzegawczego targetu0.08. Nie zaliczamy
size3nm przy dz10nm ani production mesh/runtime/science.

Zapisano przed source edits kontrakty w0104: exact-slab-delaunay-reconciliation
i layered-periodic-surface-scopes. Wdrażanie odbywa się w odrębnych prywatnych
modułach; aktualny route nadal nie został przełączony. Pełny S00–S12 OPEN.

Artefakty w layered-cap-sliver-diagnostic-20261013:
- `actual-periodic-positive496-exact-reconciliation-results.json` SHA256 `bb61bf60fdb2754fc9a896bb889259a87592a2bc1e8242d31916bea1bb835946`.
- `actual-periodic-cap-scoped-meshdata-adapter-results.json` SHA256 `3db19fd0bb07ca16cf6b498a6a5cd7717463978cd378715be356821f5a0a57bd`.
- `actual-periodic-reconciled-quality.py` SHA256 `fe80fc7376fae48f44e080fb381fdfee85fc99f36c2237f53e4b925d4f4cf4c6`.
- `actual-periodic-reconciled-quality-results.json` SHA256 `5826b275ebaa68aac55063523cfbc50ffa57cd580206ed42a7ace676775527f2`.

Walidacja noty/source-map PASS. Nowych buildów FEM i wyników dyspersji
nie uruchomiono w tym checkpointcie; źródłowa implementacja jest następnym krokiem.

## 2026-10-13 — helper zakresów PBC ze źródeł producenta

Po checkpointcie7b382246d48560fe0946b4083dfe823b495e48db dodano
_gmsh_layered_periodic.py::periodic_patch_z_bounds_from_gmsh oraz regresje.
19 interpretowanych testów PASS, exit0. Root review wymagał odrzucania
complex coordinates przed float cast oraz identycznego dzielenia przez SCALE
co canonical extraction. Actual saved-provenance replay8 surfaces/136
node observations PASS: cztery marker-keyed scopes dokładnie pokrywają x/y;
coords/SCALE bitowo zgodne z SI NPZ. Jest to stub API zapisanych actual danych,
nie rerun Gmsh ani production caller.

Hash helpera c1f52c101849f49b39a63718282300711404d854d8205d9835c3679f1b6ba241;
testu197406dc0faa3c7dc6165796ec2ff12b8bea4b468023442c8f4417b3337cef58.
Artefakty gmsh-layered-periodic-scope-replay-* w zatwierdzonym folderze
layered-cap-sliver-diagnostic-20261013. Doc/source-map validator PASS.

Root dodatkowo zlokalizował6 komórek gamma<0.08: były identycznie słabe
przed i po reconciliation. Istniejące cap/interior passes zmieniły24
cell sets, zachowały pełną topology/PBC parity, ale gamma_min0.010499
i SICNmin0.01186 pozostały bez poprawy. Nie deklarujemy usunięcia słabych
elementów. Nowy helper nie zmienia source route ani jakości.

Kolejka odczytana zdrowa i pusta, storage_free_bytes31126548480.
CI dla cfbb: UI38409200904 SUCCESS, consumers38409199950 SUCCESS,
regional38409200242 FAILURE. Pełny S00–S12 OPEN; Delaunay source w realizacji.

## 2026-10-13 — przeciwne orientacje wspólnych ścian

Checkpoint bazowy1d43b161b9cffb54dabc755ace3d88bf1d3c4e3f. Root wzmocnił
_validate_tetrahedralization: dwa dodatnie tetraedry przy wspólnej ścianie
muszą indukować przeciwne orientacje. Same count1/2 nie wystarczały do
wykluczenia folded/same-side cavity. Kontrola jest kombinatoryczna, bez
float tolerance i bez zmian węzłów lub volume guard. Nowa regresja zawiera
dwa różne dodatnie nakładające się tety i wymaga odmowy przed coverage.
Kernel16tests oraz adapter45tests:61PASS/17subtests, exit0,11.62s.
8 nowych testów adaptera dotyczą dispatch/provenance/no-fallback przy stubie;
nie dowodzą działania nowego Delaunay. Jego pierwszy actual141 replay
fail-closed na zbyt mocnej precondition obu cones; worker naprawia ją,
bez osłabiania cavity/SAT/volume checks. Nie przełączono production caller.
Prywatny final-tet4-quality helper również w implementacji. Cały S00–S12 OPEN.

`packages/fullmag-py/src/fullmag/meshing/_layered_box_tetrahedralization.py` SHA256 `1793966d33d1c41190140d64ba1c6d4d0ddd59f70f02d03966ccb76e7fe8257f`.

`packages/fullmag-py/tests/test_layered_box_tetrahedralization.py` SHA256 `bbda13abccbd65ae9b5bdf5dfcb7144d3429e7a8c9346c68121dd3120592228f`.
