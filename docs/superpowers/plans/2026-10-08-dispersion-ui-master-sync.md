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
