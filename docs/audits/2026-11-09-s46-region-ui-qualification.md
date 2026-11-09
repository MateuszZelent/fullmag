# P22 / S46 — kontrakt rzeczywistego odbioru resetu regionu w UI

**Stan: w przygotowaniu. S46 pozostaje NOT VERIFIED.** Test IR istnieje;
nowe helpery fixture sprawdzają wyłącznie kontrakty zapisu i interakcje selektorów.
Nie dowodzą wykonania przeglądarki, importu ani solvera.

Helpery przeszły 14/14 kontraktów `node --test` w istniejącym managed frontendzie
`15d5234e4d721b8d314f55b1c8fcfd4c650f827c731581bf479f06523b23cf56`.
Sprawdzono readonly bind skryptów oraz zgodność SHA host/kontener:
helper `81936be3287f49948424005fb881308d39eae4f44f50fb7c2cbf716bc814d1f9`,
test `e41b87a3fea7e3e0390c1592b43ddf94c7f0c405ebb1be9f0a46e39f4bb321a4`.
Review zamknęło błędną odmowę ponownego włączenia B i kolizję ID grupy/etapu.
Nową scenę bazową sprawdzono parserem AST: różni się od istniejącego wariantu
niezależnego wyłącznie opisem i usunięciem osobnego przypisania `left.texture`.
Nowe kontrakty podpięto do istniejącego kroku CI. Łączne wywołanie starego
profilu tekstury obiektu i nowego profilu regionu w managed frontendzie dało
27 PASS; lokalne testy kontraktu workflow mają 15 PASS. Żaden z tych wyników
nie jest odbiorem rzeczywistego S46.

## Implementacja runnera i importu — odbiór pozostaje otwarty

Dodano cztery stałe tryby przeglądarki: s46-local-export, s46-local-import,
s46-independent-export i s46-independent-import. Runner wykonuje import pliku,
Build + Study, edycję Inspectora, eksport kanonicznej kopii i ponowienie B przez
menu PPM. Każdy zapis wymaga przypięcia instancji API, sesji, rewizji i dokładnie
oczekiwanej treści. Compute całego Study czeka na ACK budowy oraz potwierdzenie
właściwej domeny i gotowego przygotowania. Utrata potwierdzenia nie powtarza kliknięcia.
Kontroler otrzymuje osobny parser dowodów i powiązanie eksportu z importem;
kwalifikacja bezpośredniego przejścia DEV przez archiwum fresh-state jest zaimplementowana.
Kontroler wymaga dokładnego poprzednika, archiwum i nowego DEV, przypiętych
receiptami i hashami. Osobny przegląd zamknął lukę przypięcia commita recreate.
Testy kontrolera i jego integracji: **18 PASS**, w tym legalny manifest źródeł
przekraczający 512 KiB; limit pojedynczego rekordu kontrolnego wynosi 2 MiB.

Testy helperów i runnera w managed frontendzie: **43 PASS**. Kontrakty workflow:
**15 PASS**. Nie są dowodem wykonania powyższych czterech trybów. Eksport obu
scen przez Python SDK w istniejącym backendzie zakończył się poprawnie, bez Solve.

Przegląd kontraktu importu wykazał, że projects/from-script zwracało surowy JSON
z Pythona, choć zapis sceny normalizuje go przez typ SceneDocument. Odpowiedź
aktywacji korzysta teraz z tej samej kanonicznej serializacji; archiwum i bajty
skryptu zachowują dotychczasowe źródło i hash. Dwie nowe regresje Rust obejmują
normalizację aliasów i liczb, metadane Results, wyłączony B, niezależne przypisania,
nieznane pola payloadu oraz obecność jawnych null dla pbc, thermal_noise i lokalnego
initializer. Obie regresje przeszły w CI commita 9ea1739a, w kroku
sprawdzającym także obecność ich nazw. Backend tego commita został zbudowany
w zarządzanym DEV 845a8d3fede04860a1903e2fdf0e0b89.

Przed przebudową ponownie potwierdzono niezmienione **4133 pliki / 94 691 729 B**
wyników własnej sesji; obie publiczne kolejki na 3243 i chronionym 3242 mają zero
oczekujących i wykonywanych komend. Istniejące runy pozostają completed. Skrypt
odczytowej kontroli nowych wejść solvera sprawdzi claim task/attempt/epoch,
manifest i końcowy stan CAS, metadata planu, maskę FMRM v2 oraz wektory początkowe
C i ponowionego B. Nie został jeszcze wykonany na nowych wynikach S46.

## Dwie rozróżnialne recepty

| Wariant | Wejście | Reset | Oczekiwanie po wyłączeniu B |
| --- | --- | --- | --- |
| Lokalny B | `fdm_cpu_three_relax_region_ui_baseline.py`: region left-half, początkowe +X, brak osobnego przypisania między A i B | Inspector B → Add texture change → film → left-half → Use object texture → Save stage. Recepta `{object_id: film, region_id: left-half, initializer: null}` należy wyłącznie do B. | C.initial = A.final w całej domenie. Recepta pozostaje zapisana przy wyłączonym B. |
| Niezależny skrypt | `fdm_cpu_three_relax_region_reset.py` | Osobne `left.texture = uniform(0,0,1)` przed capture B. | C.initial ma +Z w regionie oraz dokładne A.final poza regionem. |

Każdy wariant wymaga rzeczywistego zapisu checkboxa `Include this stage in Study`
i potwierdzenia `Saved stage relax-b.`. Obserwowany POST musi być jedynym zapisem
w danym oknie, przypiętym do sesji i rewizji. ACK ma zawierać dokładną oczekiwaną
scenę z rewizją +1, z zachowaniem drzewa, ID, payloadów i niezwiązanych pól.

## Eksport, import i wykonanie

1. Zakończyć bazowe A/B/C i zachować katalog, CAS, task/attempt/epoch oraz wyniki.
   Zmiana lokalnego resetu i wyłączenie B nie mogą uruchamiać Compute.
2. File → Save canonical copy as…: zachować dokładne pobrane bajty i SHA-256,
   odpowiedź sync authoring oraz jej przypiętą rewizję. Python ma zachować
   disabled B i własność recepty. Nie zastępować eksportu ręcznym skryptem.
3. Import wykonać normalnym ekranem Home → Import → plik `.py` → review źródła
   → Create project → Run script and create project. Sprawdzić otrzymany projekt,
   nową potwierdzoną sesję, jej committed scene i gotowość; sama odpowiedź
   `projects/from-script` nie kwalifikuje importowanego workspace.
4. Study w zaimportowanym workspace wykonuje wyłącznie A i C. Porównać związany
   **stan początkowy C** z A.final i maską regionu dla odpowiedniego wariantu.
5. Ponownie włączyć B i zapisać. Sprawdzić zachowaną receptę, następnie PPM na B:
   dokładnie jedno nowe Compute i wyłącznie B. Porównać B.initial wewnątrz i poza
   regionem z jego receptą oraz kwalifikowanym poprzednikiem A.
6. Po reloadzie sprawdzić nową sesję/run, publiczne pola, historię, widoczny
   WebGL2, niezerowy drawing buffer, brak błędów i brak drugiego Compute.

Porównania wymagają rzeczywistej maski FMRM v2, zgodnej domeny i próbek z CAS
albo przypiętego binarnego endpointu artefaktu. Nie porównywać końcowego B poza
regionem z A.final: wymiana i solver mogą legalnie zmienić te próbki.

## Bezpieczne przejście workspace

`ScriptProjectActivation.createAndActivateScriptProject` wymaga pustej aktywnej
sesji. `Close Project` zamyka tylko dokument, a zamknięcie karty pozostawia
instancję i sesję. Docker API-only celowo odrzuca komendę `close`
(`runtime.rs`, `DOCKER_CLOSE_UNSUPPORTED_REASON`). Test nie może udawać pustej
sesji ani pomijać tego guardu przez automatyczne `replace_current`.

Dostępna ścieżka kwalifikacji: po eksporcie przypięty managed stop i
`docker_dev.py recreate-volume --fresh-state`. Kontrakt tej opcji zachowuje
poprzednią sesję i archiwizuje runtime przed uruchomieniem pustej sesji.
Przed wykonaniem trzeba sprawdzić kod tej gałęzi, dokładny receipt stopu,
archiwum i hashe zachowanych wyników; kontynuacja importu musi wskazywać
identyczny SHA pobranego pliku oraz nowy jawny DEV/API identity. Zachować
jawny budżet backendu 8 CPU / 32 GiB i frontendu 2 CPU / 8 GiB. Dotyczy to
wyłącznie własnej grupy na 3243. Grupa użytkownika na 3242 pozostaje poza operacją.
Każde recreate S46 musi otrzymać jawne --helper-source-root równe checkoutowi
aplikacji i --helper-source-commit równy jego pełnemu commitowi. Profil sprawdza
ten istniejący binding także w receipcie recreate. Pierwsza taka migracja została wykonana jako
fc273e400a3640bc941d23fb7edc904d, przed DEV 845a8d3fede04860a1903e2fdf0e0b89.
Archiwum zachowało poprzedni runtime i prywatny ledger; inwentarz 4133 plików
wyników pozostał identyczny. Nie jest to jeszcze powiązanie eksportu S46 z importem.

## Pozostałe prace

Wykonać cztery zaimplementowane profile managed browser QA i potwierdzić
rzeczywiste powiązanie receiptów eksportu/importu przez hash skryptu oraz archiwum.
Wykonać
obie rzeczywiste sekwencje oraz testy odmowy zmiany celu/rewizji bez osłabiania
istniejącego profilu całego obiektu `texture-stage-b`. FDM GPU, FEM i multilayer
pozostają oddzielnymi bramkami pełnego planu.

## Rzeczywisty import i poprawki bootstrapu Home

W DEV `845a8d3fede04860a1903e2fdf0e0b89` potwierdzono nowy backend
z commita `9ea1739a699d43900b41c87ddd8cd1b476f31288`, osobną pustą sesję API
`e9026192-ceac-4db7-a92c-3c58b4a30279` oraz budżety 8 CPU / 32 GiB
backendu i 2 CPU / 8 GiB frontendu. Chroniona grupa na 3242 nie była zmieniana.

Próba `a63220bb92d94747a65b9fcbd0201212` odtworzyła kliknięcie Import
przed hydratacją: przycisk SSR był aktywny, lecz nie miał jeszcze handlera.
Wcześniejsze przejście bezpośrednio na kanoniczny `/home` samo nie naprawiło błędu.
Home otrzymał barierę `inert`/`aria-busy` do podpięcia adaptera właściwego właściciela.
Adapter zachowuje sekcję i wybór przy odświeżeniu capabilities; stary właściciel
zostaje unieważniony po odpięciu. Regresja layout-phase wykryła dodatkowo stare
uprawnienie przy przejściu no-session → loading. Aktualizacja bindingu i komend
odbywa się teraz przed repaintem. W tej samej fazie odpinany jest poprzedni
właściciel i podpinany nowy, co blokuje użycie starego kernela przez globalne
skróty i palette. Test layout-phase odtworzył tę lukę przed poprawką i potwierdził
odrzucenie starego adaptera po niej. SSR zachowuje bezpieczną ścieżkę bez efektów.
Końcowe testy w managed frontendzie: **28 PASS**, w tym SSR, gotowość, focus,
zmiana właściciela i odwołanie capability. To dowód testów, nie pełny odbiór UI.

Próba `75c17dd9c64641ac8a01799f0861a24d` przeszła rzeczywisty Home → Import
→ review pliku → Create project. Fidelity: verified. Utworzyła sesję
`session-18e63f7d5bc25ecc000049fe` i zapisała scenę w rewizji 1.
Ścisła kontrola ACK odrzuciła dodatkowe `ui_label: Uniform`: commit sceny
normalizuje assets i etykiety pipeline, a odpowiedź importu wcześniej wykonywała
samą serializację. Nie wysłano żadnego Grid, Relax ani Solve; kolejka jest pusta,
CurrentRun zwraca 404. Sesja została zachowana, import nie został powtórzony.

Odpowiedź aktywacji korzysta teraz z tych samych dwóch normalizatorów co commit
sceny, na klonie dokumentu. Surowy eksport SDK i bajty skryptu w archiwum nie
są zmieniane. Trzecia regresja Rust sprawdza domyślne i własne etykiety,
legacy uniform/random, pustą etykietę etapu, idempotencję, niezmienione źródło
oraz opaque payload z null. Jej uruchomienie wymusza CI przez obecność nazwy
w logu; wykonanie tej nowej regresji pozostaje wymagane.

Usunięto tymczasową diagnostykę wewnętrznych struktur Reacta. Runner zachowuje
ograniczony snapshot DOM i screenshot błędu oraz przerywa oczekiwanie po
odrzuceniu guardu. Anulowany GET health jest dopuszczany wyłącznie w trzech
fazach na tej samej instancji API, w ograniczonym budżecie i z dowodem całkowicie
odebranej odpowiedzi 200. Inne błędy nadal blokują wynik. Końcowe testy: **45 PASS**
Node oraz **101 PASS** Python (kontroler, parser regionu i kontrakt workflow).
Managed `pnpm typecheck` zakończył się z kodem 0. Osobny przegląd źródeł
nie znalazł dalszej luki w normalizacji ACK i guardach runnera.

Cztery pełne profile S46, porównania masek i początkowych pól, pozostałe realizacje
FDM GPU/FEM/multilayer oraz pełna macierz P01–P22 pozostają otwarte. Nowe poprawki
wymagają przypiętego commita, CI, zachowującego stary stan przejścia DEV i rzeczywistego
odbioru; zielone fixture testy nie zamykają tych bramek.

## Poprawka kontraktu React po CI 5414a34c

CI `42554204279`, job Control Room `128956185349`, odrzuciło mutowalną komórkę
adaptera utworzoną wewnątrz renderu (`react-hooks/immutability`). Reguła pozostała
włączona. Model właściciela przeniesiono do `model/startScreenHostAdapter.ts`;
commit i invalidate nadal działają dopiero w fazie layoutu, z osobną komórką dla
każdego kernela. Testy właściciela i SSR pozostały aktywne. Manifest odbioru S46
przypina również nowy model (31 plików, limit 32). Managed ESLint dla trzech
zmienionych plików przeszedł bez błędów i ostrzeżeń; 28 testów Home/commands/state
nadal przechodzi. Ponowne CI aktualnego commita pozostaje wymagane.

## Zachowanie zaimportowanej sceny bez uruchomień

Aktualna sesja jest authoring-only: scena 1, script null, pusta kolejka i ledger,
CurrentRun 404. Zwykły stop-only nie przyjmuje aktywnej sesji w takim stanie;
istniejąca ścieżka saved-authoring wymaga trwałego projektu `.fms` i dokładnych
pinów sceny, źródła, pakietu, ownera oraz obu kontenerów. Reimport i Solve nie
są potrzebne do utworzenia tej kopii.

Istniejące `POST /v2/persistence/projects` i `/projects/authoring` operują na
lokalnych instancjach ProjectApplication i przekazanym archiwum. Zwracają kanoniczny
projekt z `project/source.py`; nie zmieniają bieżącej sesji wykonawczej. Request
validator saved-authoring pomijał tę ścieżkę, mimo że archive validator już ją
dopuszczał. Dodano wyłącznie dokładną ścieżkę `project/source.py`. Regresja najpierw
odtworzyła odmowę `UI authoring/source archive binding differs`; po poprawce cała
klasa SavedAuthoringRestartTests ma **22 PASS**. Nieznana ścieżka, traversal, brak
źródła/hashu i hash drift nadal są odrzucane. Hashy, ownership/drain i kontroli
braku wykonania nie osłabiono.

Control Room CI dla `879111602c18de8f5790ca179233f38945667a30`, job
`128960462732`, zakończyło się sukcesem po przeniesieniu adaptera poza render.
Jednorazowy producent trwałej kopii i jego wykonanie są nadal wymagane przed
managed stop oraz fresh-state/build. Runner zapisuje fazę i przypięcia API/sesji
również dla nieoczekiwanych błędów transportu; pozostają one blokujące.

## Przebudowa fb9 i rzeczywisty preflight budowy FDM

Przed przebudową zapisano na hoście FMS 6085 B, SHA-256
`4f84f09a9dbeb94a0fff7585b2d9a8ece13c29abeaec64dd3e6f02f1a0790558`, z dokładną
sceną 1 i kanonicznym `project/source.py`. Pierwszy producent błędnie oczekiwał
persisted_revision=null także po otwarciu archiwum; rzeczywista odpowiedź ma
poprzednią rewizję archiwum 1 i jawne durability=memory_only. Użyto zachowanych,
zahashowanych odpowiedzi dwóch zakończonych wywołań, bez kolejnego POST.
Kontrola live przed i po potwierdziła niezmienioną sesję, scenę i pustą kolejkę.

Managed saved-authoring stop `d3a179221a5b479b871f0cb9306a2ab3` zakończył się
sukcesem. Recreate/fresh-state `b5037c7ed4724be1873f59978c6ffa4a` zachowało stary
runtime i ledger; inode, owner, hashe, generacja oraz helper/app source root i commit
zostały odczytowo potwierdzone. Wszystkie 4133 pliki wcześniejszych wyników są
niezmienione. Chroniony API 3242 zachował ten sam run i energię.

DEV `98740c85721642beb946f114bc79db12` zbudował pakiet z czystego
`fb9af4f4595fb0850b2349b1e0ea73dbbd10f495`; receipt succeeded, config
`b74337ea7809e07c452e74f44e151146bb0f4481c436a622c6d14d384fee23d1`, budżety
8 CPU/32 GiB i 2 CPU/8 GiB. API `93a720ac-4e89-4083-8dfd-045df17139d2` było
puste. Wszystkie cztery workflowy CI fb9 zakończyły się sukcesem, w tym wymuszone
trzy regresje Rust kanonicznej aktywacji. Zimna kompilacja Next /home trwała 59 s;
po odczytowym rozgrzaniu /workspace i /home zwracały 200.

Rzeczywista próba `3d9be33fe5a2440fba5db1897a8b3d33` przeszła Import i ścisły
ACK sceny, potwierdzając naprawę ui_label w działającym backendzie. Utworzyła
sesję `session-18e645ed67a5be0f00004a47`, scena 1. Zatrzymała się dopiero na
wyłączonym przycisku Build Grid & Materialize Masks; Grid i Compute nie zostały
wysłane, command ledger pozostał pusty, CurrentRun 404. Nie ponowiono importu.

API readiness miało wszystkie checks complete, ready_to_run/export=true i brak
blockerów. Status publikował grid_build=supported oraz shared_mesh_build=unsupported
na FDM CPU/double/strict. Dialog błędnie sprawdzał zawsze shared_mesh_build,
wyłączając zarówno przycisk, jak i confirm handler. Ten sam fałszywy gate wyświetlał
komunikat Loading current scene geometry baseline. Osobno zerowe granice pustego
domain/meta przesłaniały poprawne granice autorskiego Box 8×4×2 nm. Naprawa tego
dialogu i jej regresje są w toku; manifest odbioru przypina również MeshBuildDialog
(32 pliki, limit 32). Anulowane GET-y ze scope i fazą pozostają dowodem do diagnozy,
a nie zaliczonym odbiorem ani usprawiedliwieniem odblokowania błędnych zapisów.

## Regresje dialogu budowy po próbie 3d9

Dialog wybiera teraz grid_build dla FDM i shared_mesh_build dla FEM. Mismatch
rodziny żądania i aktualnej metody (w tym opóźniony grid.build-fdm dostarczony pod
FEM oraz FDM→FEM bez zmian rewizji) daje widok wymagający nowego potwierdzenia;
confirm nie może autoryzować starego żądania uprawnieniem nowej metody. Preflight
FDM wymaga rzeczywiście odczytanych danych sceny z rewizją równą statusowi.
Brak danych, mismatch i zmiana po capture blokują potwierdzenie; zgodna last-good
scena pozostaje używalna podczas refetcha. Nieobsługiwana capability pokazuje
swój powód. Pusta domena o cells=0 nie przesłania granic autorskich obiektów;
materializowana domena z legalnym początkiem [0,0,0] zachowuje swoje granice.

Zamontowane testy na prawdziwym EventBus odtworzyły błędne zachowania przed
poprawką. Potwierdzenie dodatnie pinuje scene_revision=17 i mesh_revision=9;
ujemne ścieżki nie emitują confirmed=true. Końcowe managed testy pięciu plików
mają **29 PASS**, focused ESLint czterech zmienionych plików i typecheck mają
kod 0. Testy kontrolera z pełnymi 32 pinami źródeł mają **86 PASS**. Nadal
wymagany jest rzeczywisty odbiór tej poprawki w S46.

Przed kolejną generacją zachowano dokładnie aktualną scenę sesji 18e645:
FMS 6087 B, SHA-256 `bd8ea41d227b1a89063635c6ff83b7100f74fcf0664e56943d1ae8ca0406ac29`.
Jej scena ma SHA-256 `b0153b155c8cbc363641f6717934bba9eee5751a23a8fc85c14267012f94ece5`.
Starszego FMS nie uznano za równoważny: różnił się zapisaną ścieżką wyników.
Nowa kopia oraz operator checkpoint zostały odczytowo zweryfikowane; sesja, scena,
pusta kolejka i brak runu pozostały bez zmian. Nie wykonano Grid ani Compute.


## DEV f897 i pierwsze żądanie budowy po imporcie

Managed recreate/fresh-state `10e2f8c9c9964a568cab43f4d4e19caa` zachowało
poprzedni runtime i ledger. Odczytowy verifier potwierdził przypięcie helper/app
source do `f89756a1e36a8ce3e663f7bab6e42a31c8f56c09`, raw intent hash i odrębne
inode archiwum oraz nowej generacji. Inwentarz pierwotnych wyników nadal ma
4133 niezmienione pliki / 94 691 729 B.

DEV `eff2d81c4f30437b8334c46de36fd2a4` zakończył build, pakietowanie i start
stanem succeeded; config `e0783d822f5bfcbf20eea5a9970ad26981e6f4487c7c7454e2596dea31e91730`,
snapshot `900848a83a3e54a561e9c5ab8cd69c439ef2c610c61586e0229c44fea41f55cc`.
Log natywnej binarki potwierdza czysty commit f897. Nowe API
`31d31b92-2ec9-4508-9fdb-17084b16de83` miało sessions=[] przed próbą.
Backend ma 8 CPU / 32 GiB, frontend 2 CPU / 8 GiB. Chroniona grupa 3242
zachowała wcześniejszy completed run i energię -6.063642418651386e-22 J.

Browser QA `ad1688bc931a4d89b0f2ced87641e036` przeszło normalny import,
fidelity=verified i ścisły ACK sceny 1. Dialog pokazał prawidłowe granice
[-4,-2,-1] do [4,2,1] nm i pozwolił potwierdzić FDM Grid. Żądanie
fdm_grid_refresh przeszło guard harnessu, ale odpowiedź API miała HTTP 409.
Harness przerwał obserwację; nie wykonał Solve. Odczyt po próbie potwierdził
sesję `session-18e649a9efef628400004a24`, scene=1, commands revision=0 i pustą
kolejkę, CurrentRun=404. Readiness i kontrolka fdm_grid_refresh były dostępne.
Nie ponowiono tej operacji. S46 pozostaje NOT VERIFIED.

Body 409 nie zostało zapisane przez ówczesny runner. Przegląd źródeł wskazuje
walidację capture/round-trip przed pierwszym RunIntent jako kandydata, lecz nie
jest to ustalona przyczyna. Nie usunięto żadnego guarda. Runner zapisuje teraz
bounded metadane odrzuconego zapisu, SHA/rozmiar odpowiedzi i do 16 KiB jej
prefiksu; limit wynosi 32 obserwacje i 2 MiB na odpowiedź. Oryginalna zgodna
odpowiedź trafia raz do UI, a odbiór nadal kończy się błędem. Obce API oraz
przekroczenia limitów pozostają fail-closed. Regresje Node: 23 PASS; powiązane
kontrakty parsera/kontrolera Python: 86 PASS, w tym trzy nowe przypadki RED/GREEN
odrzucające raport PASS z rejected write. Focused ESLint przechodzi.

## Pełny snapshot projektu i rewizja zapisu

Niezależny przegląd wykazał osiągalną utratę analysis przy Save aktywowanego
projektu oraz authoring undo/redo. SceneDocument przechowuje definicje Results,
ale SceneResource i sceneDocumentPayload pomijały analysis, a pełne replace_scene
traktowało brak jako pusty stan. Projection obejmuje teraz opaque analysis bez
zmiany właściciela CRUD; snapshot, historia i saved-authoring proof zachowują
definicje, ich identyfikatory, referencje i zagnieżdżone settings. Legacy brak pola
pozostaje zgodny, jawne analysis={} pozostaje jawne w payloadzie.

Project Save wiąże osobno rewizję każdego odczytanego snapshotu. Zmiana wspólnego
scene_revision podczas odczytu, synchronizacji archiwum lub host Save blokuje
potwierdzenie aktualności i pozostawia projekt dirty. Następny jawny Save może
odczytać nowszą rewizję; API/session/epoch fence pozostają aktywne. Regresje
wykryły także błędne współdzielenie rewizji między równoległymi odczytami oraz
fałszywy clean po zakończeniu host I/O. Końcowe testy persistence: 61 PASS;
projection/history: 9 PASS; saved-authoring: 23 PASS; kontrakty workflow: 15 PASS.
Managed typecheck i focused ESLint przechodzą. Dwie nowe regresje Rust mają
osobny krok CI z kontrolą obecności obu nazw; ich wykonanie i managed regeneracja
API wymagają jeszcze weryfikacji na nowym backendzie.

Hook React Doctor dla Save zakończył dodatkowy lint błędem pluginu oxlint
Maximum call stack size exceeded; nie jest to PASS tego narzędzia. Osobne
managed ESLint/typecheck/testy są podane wyżej. W pozostałych fragmentach hook
zgłosił istniejące sekwencyjne await w runnerze oraz istniejący JSON transport
clone; nie dodano suppressions ani nie zmieniono semantyki dla uciszenia ostrzeżeń.
Powyższe regresje źródłowe nie zastępują nowego odbioru UI, S46 ani pełnej macierzy
P01–P22/S01–S46, FEM/GPU/multilayer i kwalifikacji naukowej.


Czysty test SDK w tej samej binarnej generacji f897 wykonał render-scene-document,
niezależny inventory oraz scene-only capture wygenerowanego źródła. Nie powstał
RunIntent ani komenda API. Interpreter /usr/local/bin/python3 i SDK z przypiętego
/build/workspace były zgodne z runtime. Inventory przed/po jest identyczne;
źródło ma SHA-256 `26f2f2ae07ef3bf48000661b76cfb811919082c95ed2b3cfa87c9b1f6d6cc753`.
Artefakty techniczne zachowano w prywatnym control/backend/diagnostics pod
`p22-s46-roundtrip-5fec3e53bc9347f0bfd210620a30f7c1`. Pythonowe projekcje surowych
scen różnią się 27 wpisami, głównie absent/null/puste listy i domyślne pola etapów.
Nie jest to dowód różnicy po typowanej normalizacji Rust ani przyczyna 409.
Dodano rzeczywistą scenę jako fixture oraz test Rust przechodzący przez render,
capture i dokładny validator round-trip, z osobnym krokiem CI wymuszającym nazwę
testu. Wynik tego testu pozostaje do odczytania; guard nie został osłabiony.


## Potwierdzona przyczyna 409 i efektywna polityka zapisu

DEV `623fbe00a7114365a4a2f769dacf2d95` z czystego commita
`4cf2d8090926c136ee2d8f99f980449ca03b2d59` zakończył build i start API.
Browser QA `c638f7f9fe434ce5bdeca933e7ac0036` zachowało body odrzuconego
FDM Grid: HTTP 409, `accepted_ui_scene_round_trip_changed`. Odpowiedź trafiła
również do UI. Nie wykonano Solve; sesja pozostała przy scenie 1, bez runu
oraz bez przyjętych komend.

Jednorazowy stateless import kanonicznego źródła do projektu, bez aktywacji
sesji, pozwolił porównać typowany SceneDocument. Jest dokładnie sześć różnic:
`autosave` dodane do trzech etapów i trzech payloadów pipeline. Każdy wpis to
obowiązujący domyślny zapis `m` co 100 zaakceptowanych kroków Relax w Zarr.
Scena, sesja, kolejka i ledger komend przed/po diagnostyce są identyczne.
Test Rust rzeczywistej sceny w CI 4cf odtworzył ten sam błąd 409; obie nowe
regresje zachowania `analysis` zostały rzeczywiście wykonane i przeszły.

Poprawka wydziela czysty resolver istniejącej polityki IR. Runtime i kopia
projekcji skryptowej używają tego samego właściciela defaultów; surowa scena,
rewizja i fence nie są zmieniane. Normalizacja obejmuje flat stages oraz
zagnieżdżone i wyłączone węzły pipeline. Custom cadence, target, tabela oraz
konflikt formatu zachowują znaczenie. Jawne null czyści override, ale nadal
dziedziczy skonfigurowany writer projektu. Nie wprowadzono semantyki null=off.
Dodatkowa regresja walidatora musi przyjąć równoważny default, a odrzucić zmianę
cadence w flat stage i osobno w payloadzie. Nowe testy IR, authoring i API mają
wymuszone wykonanie w CI; ich wynik po poprawce pozostaje NOT VERIFIED.
Lokalne lekkie kontrole: rustfmt obu zmienionych modułów i 15 kontraktów
workflow przechodzą. Nie kompilowano backendu na hoście.

Managed codegen API zakończył się powodzeniem w DEV 623. Receipt
`backend/codegen/openapi-v2/45e67c8f51841a9e2bbdd2f733dae9b5173c7658b0981f90c8e002c18c892e79.json`
potwierdza natywny commit 4cf, exit 0 oraz hashe opublikowanych plików.
Diff OpenAPI/TypeScript zawiera wyłącznie opcjonalne opaque `SceneResource.analysis`.
Managed typecheck przechodzi po generacji.

Poprawka Save `8dc328e561c090f0669596c3b6f004c4ea7e220a` zachowuje już
potwierdzone przez host ścieżkę, revision i hash także po nieudanym późniejszym
fence sceny. Dokument pozostaje dirty; kolejny jawny Save używa aktualnego CAS.
Regresja obejmuje host ACK rewizji 2, zmianę sceny podczas I/O i kolejny zapis
rewizji 3 z expected_revision=2. Testy persistence: 61 PASS, focused ESLint i
managed typecheck: exit 0. Niezależny review zamknął P2.
Nowy build oraz pełny odbiór S46 pozostają wymagane; powyższe nie zamyka
pozostałych P01–P22, FEM/GPU/multilayer ani bramek naukowych.


Przegląd przed buildem wykrył dodatkowo lokalne `table_autosave` bez quantities
oraz sampling `field_resolved_auto`. Projekcja uzupełnia pominięte quantities
z tej samej neutralnej stałej IR co runner; publiczne `DEFAULT_TABLE_COLUMNS`
pozostaje re-exportem tej listy. Schemat IR nadal wymaga jawnego quantities.
Dla ustalania autora nowego primary writera projekcja uwzględnia `field` oraz
`field_auto`, zgodnie z obecnym Python ownerem; resolved execution metadata
pozostają w surowej scenie i nie są usuwane z porównania. Dodano odrębny test
rzeczywistego render/capture lokalnej tabeli bez quantities. Testy Rust tych
przypadków nadal wymagają wykonania w CI.

Niezależny source review po korektach zamknął oba dodatkowe P2. Nie zastępuje to
wykonania regresji Rust ani odbioru natywnej generacji po przebudowie.


## Odbiór natywnego c98 i korekta dodatkowej fixture

DEV `4e99765af6284dea82c91bff38cd2397` z czystego
`c98c9f5170dd623c27561d864dac85cfddf29893` zakończył build/start stanem succeeded.
Config `a6b460410f947d2302b036d46e4c3837dd73bcdb45c4962243474acb353f0e66`,
snapshot `ac18002d9529c679e713a0fd9ef7214a9ed53ef4b1d9eb017c9d223806be0a40`.
Przed próbą API `2332941b-2b19-4a63-b816-bfc8f1bcb13b` miało sessions=[],
a /workspace i /home zwracały 200. Archive verifier świeżej generacji
`26beb0672cf74484811ee9e18fde7050` potwierdził helper/app c98 i raw intent.

CI c98 rzeczywiście wykonało: 6 testów resolvera IR, 10 projekcji authoring,
ujemny guard custom cadence, rzeczywisty render/capture sceny S46 oraz dwie
regresje analysis — PASS. Control Room: 924 pliki / 9641 testów PASS,
13 testów pominiętych; dodatkowy zestaw 3 PASS. Generated API determinism: PASS.
Jedyny błąd Rust dotyczy nowej fixture lokalnej tabeli: omyłkowo zawierała
sampling w Relax, którego publiczny DSL prawidłowo odmawia. Nie osłabiono
walidacji. Poprawiony test używa legalnego Run z czasowym cadence tabeli,
następnie kanonicznej sceny przechwyconej przez SDK. Usuwa tylko quantities
z lokalnych tabel flat/pipeline i ponownie sprawdza ścisły render/capture.
Projekcja kopii payloadu uzupełnia domyślne kind/table_id/quantities, zachowując
pozostałe pola i surowy dokument. Ten nowy wariant wymaga jeszcze wykonania CI.

Rzeczywiste QA `704d5cd764ae4288b976b27fabf129d9` zaimportowało scenę i ACK.
FDM Grid został przyjęty i zakończony: command
`fm-8b151158-2998-47c5-aba2-bff4653bcfec`, 8 komórek, run
`run-live-7b4bad143921812b889653bdd492b593b127eff61246d90c0c845376174e6217`.
Odczyt po próbie potwierdza waiting_for_solve, solver awaiting_command,
steps=0 i dokładnie jedną completed komendę Grid. Zatem 409 został usunięty
również w rzeczywistym runtime; nie wykonano Compute ani replay.

Cały S46 NIE przeszedł: runner zakończył obserwację po GET CurrentRun timeout
20 s, podczas gdy Grid trwał 79 483 ms. Zamknięcie kontekstu przeglądarki
przerwało obserwację odpowiedzi POST i PATCH. Ten raport nie jest dowodem
nieudanego Grid ani kwalifikowanym eksportem; późniejszy scoped odczyt API
potwierdził jego zakończenie. Trwają diagnoza blokowania odczytu i poprawka
obserwacji tej samej operacji bez ponawiania kliknięcia. Import/export resetu
regionu, pełna macierz P01–P22 i pozostałe realizacje pozostają otwarte.


Końcowy source review wskazał również nullowe identyfikatory tabeli. Projekcja
zachowuje reguły właściwego publicznego parsera: autosave.table przyjmuje domyślne
kind/table_id także dla null, a lokalne Run sampling nadal odrzuca jawne null
w table_id. Uzupełniono dodatnią i ujemną regresję tej granicy; surowa scena
zachowuje pierwotne wartości. Wynik nowych testów pozostaje do odczytania w CI.


## Obserwowalność przygotowania i odmowa restartu

Źródła potwierdzają ryzyko blokowania odczytu: CurrentRun pobierał mutation
request context pod globalnym current_live_session_transition. Pierwsze
ensure_live_accepted_study może pod tym transition czekać na przygotowanie
accepted Study w spawn_blocking. Sam native Grid po przyjęciu komendy działa
w osobnym ownerze; nie ustalono telemetrycznie, jaka część 79 483 ms przypadała
na ten lock. Nie przypisujemy całego czasu natywnego Grid do API mutexu.

CurrentRun korzysta teraz z istniejącego read-context, tak jak status i
preparation. Nadal czyta jeden committed snapshot pod read-lockiem i wywołuje
ensure_current_live_request_context z aktualnym epoch. Dodano trzy testy:
odczyt manifestu przy zajętym transition, 404 przed publikacją runu i 409 po
zmianie właściciela podczas oczekiwania na faktyczny snapshot write-lock.
Kontrola ujemna potwierdza, że mutation capture nadal czeka na transition.
Niezależny source review zamknął ten zakres; wykonanie nowych regresji Rust
pozostaje do potwierdzenia w CI.

Harness rozróżnia wyłącznie zaobserwowany komunikat APIRequestContext GET timeout.
Zapisuje do 32 obserwacji z konkretnym API/session scope/path i kontynuuje tylko
GET polling w istniejącym budżecie. Błędy HTTP/pin/guard, disposed context i
route.fetch pozostają błędami. Dotychczasowe pełne dowody terminalne nadal są
wymagane do PASS; timeout sam niczego nie potwierdza. Managed Node: 26 PASS,
focused ESLint obu plików: exit 0, zgodne SHA i readonly bind skryptów.
Rzeczywisty odbiór poprawionego obserwatora pozostaje NOT VERIFIED.

Próba managed stop-only z allow-prepared-session
`c5ac4f237bb142c4bb5a32bef70dca3b` zakończyła się failed-confirmed. Preflight
prepared wymaga commands=[], więc ukończony UI Grid także blokuje restart.
Nie ponowiono operacji; backend i frontend pozostały running. Inwentarz
przyjętych danych przed/po odmowie jest identyczny: 3915 plików / 94 031 799 B.
Kwalifikacja ukończonego Grid wymaga niezależnego związania z bieżącym runem,
manualnego Held gate bez start_release oraz wszystkich istniejących bramek
native drain. Nie usunięto ani nie wyzerowano dziennika w celu obejścia tej odmowy.


## Kwalifikacja przygotowanego Study po ukończonym Grid

Poprawiony preflight dopuszcza pusty ledger albo wyłącznie completed
fdm_grid_refresh o rzeczywistym zapisanym target=Run bieżącego runu.
API-only commands.rs wiąże ten target z accepted_context przed publikacją,
a command_status_resource kopiuje record.command.target bez retargetowania.
Wymagane są zgodne liczniki i rewizje, unikalne ID/seq, completion_status=completed,
brak błędu i prawidłowe czasy. Dispatch pozostaje opcjonalny dla synchronicznego
Grid: rzeczywista odpowiedź 704 nie zawiera tego pola. Dodatkowy test tego
kształtu był RED przed korektą i GREEN po niej. Gdy dispatch istnieje, musi
leżeć między utworzeniem i zakończeniem. Dopuszczony ledger trafia do dowodu.

Testy wykonują rzeczywisty generowany probe z mock GET i tymczasowym store
intentów. Obejmują też obcy run, Compute, nieukończone/odrzucone/nieudane komendy,
błędne liczniki/rewizje/czasy, duplikaty oraz start_release zarówno bieżącego,
jak i innego zachowanego Held runu. Wszystkie dotychczasowe kontrole native drain,
private network, scope i before/after pozostają aktywne. Rzeczywiste zastosowanie
tej wersji recovery oraz kolejny odbiór UI nadal wymagają wykonania.

Końcowe dwa moduły fixture recovery: 47 PASS (runtime state oraz terminal
prestart recovery), po korekcie rzeczywistego wariantu synchronicznego Grid.


## Rzeczywisty drain i druga obserwacja Grid na 3f1

Managed stop `6006aac041ee4401b17c639d5bee92b8` zakończył się succeeded:
preflight zachował ukończony Grid i potwierdził manualny Held gate bez
start_release. Porównanie hashów zachowało 3915 plików przyjętych wejść oraz
4133 pliki wcześniejszych wyników. Fresh-state `14e23063b77640fd86c785369f857442`
zachował poprzedni store i uruchomił DEV `ce8c805051b44e0d9eac9cc76b717f48`.
Helper i native API odpowiadają commitowi
`3f1d7c3e527445caf8c21b4b3d8312e184a27a41`; API ma tożsamość
`b44ce02d-2536-45e6-a6d2-a72836e3cd70`. Warmup /workspace i /home zwrócił 200.

QA `813bfe48a67240f69d0844f5806d2abd` przeszło import, fidelity i ACK,
lecz NIE przeszło pełnego S46. CurrentRun GET nadal przekroczył 20 s;
nowy obserwator zapisał ten timeout. Następnie route.fetch dla POST komendy
oraz PATCH wizualizacji przekroczył niezależny limit 30 s. Scoped readback
potwierdził później completed Grid `fm-72f07c99-098c-4a41-9987-fd19a28b35be`
(83 028 ms), run
`run-live-5d2dba0a7fd68f37293885882668625a955f2761be2de7ac5be4eea301e336fa`,
waiting_for_solve, steps=0 i brak Compute. Nie ponowiono komendy.
Ta próba nie jest kwalifikowanym rodzicem eksportu.

Harness przekazuje teraz pojedynczemu autoryzowanemu write pozostały budżet,
z limitem 600 000 ms. Globalny limit próby nie zmienia się; timeout musi być
skończony i dodatni. Jawne maxRetries=0 i maxRedirects=0 wykluczają ponawianie
lub przekierowanie mutacji. Błąd transportu nadal kończy próbę; odmowa HTTP
zachowuje dotychczasowy bounded body i kontrolę tożsamości API. Nowe regresje
obejmują dłuższy budżet, dokładnie jeden fetch po timeout oraz odmowę błędnego
budżetu przed wysłaniem. Managed Node: 29 PASS; focused ESLint: exit 0.
Rzeczywiste wykonanie tej wersji obserwatora wymaga nowej próby na pustym API.

CI pełnego commita 3f1: wszystkie sześć workflow zakończyło się success,
w tym bootstrap 42590728750, Rust 129071532013, Control Room 129071531825
oraz generated API 129071531941. Sam sukces CI nie kwalifikuje S46 ani
pozostałych realizacji FEM/GPU/multilayer.

Pozostaje również problem responsywności backendu: commit przyjętego Study
wykonuje synchroniczny zapis CAS i RunIntent pod snapshot write-lockiem.
Odczyt CurrentRun bez mutation transition usunął jedną zależność, ale nie
zapewnił odczytu w czasie tego zapisu. Nie zmierzono jeszcze czasu jego
poszczególnych faz. Przyszła poprawka musi zachować pojedynczą writer lease,
revalidation bieżącej sceny/kontekstu i atomową publikację przyjętego runu,
także po anulowaniu żądania HTTP. Wydłużenie budżetu testu nie zamyka tego
wymagania produkcyjnego.


## Native a49 i drugi limit proxy testu

Commit `a49bf958b38bcdc4ad694690b3b41cd7469ff6aa` został wypchnięty.
Managed stop `3ad2914fcac6497bbe83c44662af4404` zakończył się succeeded;
3915 plików ce8 zachowało hashe. Fresh-state
`f7b0483f7f3a44c19e2d006c6d7bc99f` zachował archiwum; DEV
`e6ead5d2996749e983ea96e31dba0df2` uruchomił native API/helper a49.
API `f3fd20b5-d289-4e3a-8ea9-379e3ca57344`, pusta kolekcja sesji i warmup
/workspace 200 (47,14 s) oraz /home 200 zostały potwierdzone przed próbą.
Rzeczywiste limity nowego renderu wynoszą backend 8 CPU/64 GiB i frontend
4 CPU/16 GiB; różnią się od poprzedniej konfiguracji. Nie zmieniono ich
ręcznie podczas kompilacji. Trzy zachowane store: 4133 + 3915 + 3915 plików
zachowały wszystkie hashe; chroniona grupa 3242 zachowała PID i StartedAt.

QA `b4532bf3543e4226b615ba2ceca0f2dd` jest failed-confirmed, nie eksportem.
Import/fidelity/ACK przeszły. Write fetch nie przekroczył już własnego limitu
30 s; odpowiedź nie miała jednak nagłówka API. Źródłem jest odrębny limit
`forwarded.setTimeout(30_000)` pomocniczego loopback proxy. Jego 502 nie jest
odpowiedzią przypiętego API i prawidłowo nie kwalifikuje ACK. Produkcyjny
Next proxy miał już budżet 1 920 250 ms. Scoped readback potwierdził późniejsze
completed Grid `fm-2b6eb3be-200d-4f46-ba2d-a63372fed752` (89 627 ms), run
`run-live-4e824c432ffbacfadd4162bd7ec11df13c794abb71f51e0827f8bbc644cad190`,
waiting_for_solve, zero kroków i brak Compute. Nie ponowiono komendy.
Zabezpieczono nowy store: 3915 plików / 94 031 799 B.

Próba ujawniła także anulowane odczyty subskrypcji po zmianie sceny. Nowy
kontrakt dopuszcza jedynie GET ERR_ABORTED dla czterech dokładnych zasobów
(readiness, planar-monitors, stage execution, FDM region memberships),
z właściwym API i session scope oraz licznikiem do 32. Każdy taki zapis wymaga
późniejszej, w pełni odebranej odpowiedzi 200 dla identycznego zasobu i scope;
przechowywany jest najnowszy numer zdarzenia. Obcy API/scope, inna ścieżka,
transport failure, wcześniejsza odpowiedź i brak pokrycia nie kwalifikują PASS.
Błędy proxy są jawne i fatalne. Niezależny parser hosta weryfikuje te same
warunki. Dotychczasowy ścisły kontrakt pięciu pól anulowania health zachowano.

Regresje Node: 32 PASS. Parser Python: 14 PASS; nowy test negatywny przed
poprawką wykazał 14 przypadków fałszywego PASS, po poprawce wszystkie odmowy
przeszły. Dwa testy proxy przeszły RED/GREEN: skonfigurowany timeout i odmowa przed listen.
Końcowy wspólny zestaw Node: 34 PASS; focused ESLint czterech plików: exit 0.
Nowy test proxy dodano do istniejącej bramki CI.
Żaden z tych wyników nie potwierdza pełnego S46 ani responsywności backendu.


## Kandydat poprawki responsywności publikacji live

Inwentarz e6ead rozdziela 3915 plików na 1954 obiekty CAS (93 063 574 B),
1954 piny (216 894 B) i 7 plików runu (751 331 B). Nie są to 3915
niezależne payloady. Nie zmierzono dotąd czasu osobnych faz pierwszego Grid.

Kandydat etapuje i weryfikuje obiekty CAS poza snapshot write-lockiem,
zachowując jedną writer lease. Scoped token HRTB, który nie jest Send,
przyjmuje tylko dokładny zestaw referencji staged intentu. Piny tymczasowe
nie stają się stałymi korzeniami GC: po akceptacji korzeniami są RunIntent refs;
po odmowie zostają nieprzypięte obiekty do zwykłego GC. RAII phase blokuje
reentrant Store GC także na tym samym wątku. Istniejące publiczne put i zwykły
commit intentu zachowują dotychczasowe kontrole. Staged ścieżka nie powtarza
pełnego odczytu payloadów podczas końcowej publikacji.

Owned transition pozostaje w finalizerze po anulowaniu HTTP. Krótki callback
pod snapshot RW sprawdza aktualny kontekst, transport scope, pełną scenę,
domenę i jawnie wybrany prepared state, buduje widok z najnowszego snapshotu,
commit i swap wykonuje bez await. Katalog powstaje potem poza RW; jego błąd
pozostawia przyjęty run i kwalifikowane metadata recovery. Scope jest jawnie
przechwytywany przed spawn: Tokio task-local nie jest dziedziczony.

Dodatkowo odczyty readiness, monitorów, stage execution, solvera, energii,
historii, wybranego runu, command detail i hysteresis korzystają z read-context,
zachowując końcowe sprawdzenie właściciela/epoki. Połączony command status
nadal zachowuje transition dla spójnej pary snapshot–ledger; nie przedstawiamy
go jako odczytu niezależnego od trwającej mutacji. Osobna poprawka FMRM przenosi
I/O poza snapshot guard i wymaga ponownej zgodności kontekstu, domeny,
fingerprintu, rewizji membership oraz źródłowego artifact dir przed odpowiedzią.

Przegląd źródłowy nie wykazał cyklu writer→snapshot write przy zachowanym
owned transition. Dodatkowy przegląd nie znalazł także cyklu snapshot read→Store lease w sprawdzonych
produkcyjnych ścieżkach. Część pozostałych field GET czyta surowy CAS pod read-lockiem:
może opóźnić write przy dużym pliku, ale nie czeka na Store lease. Nie kwalifikujemy
tym przeglądem wydajności dużych domen. Nowe regresje
obejmują CAS/GC/replay/admission/backlog, odmowę rewalidacji, własność finalizera,
anulowanie HTTP i rzeczywiste czyste GET pod zajętym transition. Ich wykonanie
Rust oraz kompilacja kandydata pozostają NIEZWERYFIKOWANE. Parser Rust i 15
regresji kontraktu workflow przeszły. Nie jest to jeszcze odbiór runtime/UI.


## Kompilacja kandydata i domknięcie niepewnej publikacji

Zarządzany DEV `cd705f16bc014bdba34dc9f9e56d9a18` zakończył się `succeeded`.
To build dirty HEAD `24aade012402f1cbd19503baa2d1186b8f95cdb8`, snapshot
`645521b4677a8184187456603d63046d2875bc693f24b15746963082b1a37ca4`,
source digest `d12910b9c13304ad3a2cf5e0572a43b0b508034d79119474fa48f2587f0e17d7`.
SHA surowego terminala:
`a582535d729bf3f3b392a0d1d206d04697397451d2322d8567116e2cec21524f`.
Kompilacja produkcyjna oraz handoff/start API przeszły; nie uruchomiono
nowych testów Rust ani S46. API potwierdziło pustą listę sesji. Następnie
zwykły managed stop z drain `21eaaa7ea27946f0a069773ae6a8fefc` zakończył się
`succeeded`. Chroniona grupa 3242 zachowała API
`0089cc71-246f-4920-81df-915cc81bc93d`; store oryginalny (4133 pliki) i e6ead
(3915 plików) zachowały wszystkie hashe. Archiwum refresh 5006 zweryfikowano.
Wszystkie sześć workflow dla 24aade012 zakończyło się success; ten wynik
nie obejmuje opisanych poniżej nowych poprawek.

Review wykryło dwie istotne luki: `atomic_write` może zwrócić błąd bariery
już po widocznym rename RunIntent, a replay receiptu mógł potwierdzić Compute
bez potwierdzonego zapisu lub po błędzie materializacji katalogu. Nowa ścieżka
staged rozróżnia potwierdzone Accepted/Replayed i `VisibleUnconfirmed`.
Ten ostatni wynik wymaga dokładnych bajtów kanonicznego rekordu pod writer
lease; publikuje tę samą tożsamość runu z osobnym kodem
`run_intent_durability_unconfirmed`, bez fałszywej deklaracji trwałości.
Nie materializuje katalogu ani nie otwiera bramki Compute.

Wszystkie staged live intents wymagają immutable manual gate. Jawny Compute
otwiera istniejący StartRelease dopiero po potwierdzeniu RunIntent i katalogu;
Study/Grid pozostaje wstrzymane. Ponowienie identycznego żądania wymaga
potwierdzenia RunIntent, a manual direct receipt bez release wymaga recovery,
zamiast tworzyć drugi run lub zwracać pozorny sukces. Metadata błędów
przygotowania i publikacji blokują również wcześniejszą ścieżkę replay.

Dodane regresje dotyczą transient/persistent błędów bariery, exact readback,
replay, braku publikacji przed rename, widocznej tożsamości i odmowy Compute.
Aktualne poprawki po cd705 wymagają nowej kompilacji i wykonania testów Rust;
nie przypisujemy im wcześniejszego dowodu buildu ani odbioru UI. Kontrakt
workflow ma nadal 15/15 PASS. Pełny S46 i pozostałe bramki planu pozostają otwarte.


Review objęło także widoczny, lecz niepotwierdzony StartRelease. Wspólna bramka
`accepted_run_start_permitted` po znalezieniu manual grantu ponownie odczytuje
kanoniczny RunIntent i grant pod stabilnym fence, a przed `true` potwierdza obie
bariery. Wykorzystuje istniejący writer na bieżącym wątku lub shared reader;
nie wymusza writer lease na read-only projekcji ani nie zapisuje WRITER.owner.
Brak grantu pozostaje bezpiecznym `false`. Dodano regresje trzech kolejnych
błędów bariery oraz nested shared reader z niezmienionymi bajtami owner record.
Przegląd źródłowy tego domknięcia nie wykazał kolejnego P1/P2; nie zastępuje
testów i nie potwierdza bramek fizycznych. Końcowy parser 17 plików Rust i
`git diff --check` przeszły; testy Rust nadal czekają na wykonanie.


Kolejny dirty kandydat `317207a2b2ec4c6a93c5e1f2c67028bb` zakończył się
`failed-confirmed`, CLI exit 2, przed startem API. Native make trwał 430 476 ms;
Rust zgłosił E0599 dla `RunId::to_string` w nowej gałęzi niepewnej publikacji.
Zmieniono wywołanie na `run_id.as_str().to_owned()`. SHA terminala:
`085922781c109f2f623fd0ca29e94ecb890f545a0f411f6c4a9077bb340dce6e`.
Config przypięty do dokładnego compose.json tej próby:
`8431879e98cf0820542f19fa04978a258793a8f6c07c732dfd5d40e19b25c0e2`.
Nie wysłano Grid/Compute ani nie uruchomiono testów Rust lub odbioru UI.

Końcowy review replay wykrył dwa dodatkowe przypadki i poprawki:

- Grant musi zawierać dokładny typed receipt osadzony w direct-Compute
  RunIntent. Inne żądanie nie może zwolnić przygotowanego stage A jako całego
  Study B. Walidacja działa przed zapisem i przy późniejszym odczycie grantu.
  Startup bez direct receiptu zachowuje dotychczasową możliwość nowego Compute.
  Regresja obejmuje brak receiptu, inne żądanie/payload, brak grantu po odmowie,
  exact success/reopen oraz odmowę już zapisanego obcego grantu.
- `PublicationUncertain` dla `start_release.json` ma odrębny kod
  `start_release_durability_unconfirmed`; nie jest błędnie opisywany jako
  niepotwierdzony RunIntent. Nieznany destination ma ogólny kod publikacji.

Obie poprawki po failed 317207 wymagają nowej kompilacji i testów. Aktualny
kontrakt workflow: 15/15 PASS. Źródła zawierają gotowy read-only profil odbioru
inspektora komórki: `--canvas-only --expect-live-field m --expect-fdm-cell-physics`.
Profil używa rzeczywistego pointer pick, porównuje liczby z publicznym probe,
sprawdza zakładki z klawiatury, energię density×volume oraz zrzuty light/dark
przy szerokościach panelu 380/300 px. Jego istnienie nie oznacza wykonania;
pozostaje do uruchomienia na kwalifikowanym, czystym buildzie.


Poprawiony kandydat `a843427be7a246a083ab4b0a6b86893f` zakończył się
`succeeded` (CLI exit 0). Recreate po błędzie kompilacji
`e0852c7ddcee4ec3b54badac467d26bc` również succeeded; nie wymagał uruchomienia
starego solvera ani zmiany chronionej grupy. Native proof dotyczy dirty HEAD
`24aade012402f1cbd19503baa2d1186b8f95cdb8`, source snapshot
`2891ea9ad7e92c3e111e9dc4077d37f3fbe6f241371b2c4128cc0d2bf88e18a6`,
source digest `7a19390c2a8ec7662c3de1182754b65f9425a5636643819319e2872bb2daf718`.
SHA surowego terminala:
`e0ae1074adc9d1f538f6117861ee898067053cf83e0b83672297196853344b91`;
config `988e3097095d4c92fdae8ae178e6c6729859752fed1b0df82c37d433788a79d2`.
Wszystkie 19 zamrożonych plików zachowały dokładne hashe podczas buildu.
API `560c72ad-5048-4555-af95-36652f841bc4` zwróciło health 200 bez aktywnej
sesji i sessions 200 z pustą listą. Nie wysłano Grid/Compute.

Kod produkcyjny kompiluje się; nowych testów Rust jeszcze nie wykonano.
Zakończony source review obejmuje pierwotne i dodatkowe ustalenia oraz ich
poprawki; nie zgłoszono pozostałego actionable problemu w tym zakresie.
Przed odbiorem UI pozostają wykonanie nowych regresji oraz czysty native
build commita. Oryginalne 4133 pliki i trzy zachowane zbiory po 3915 plików
ponownie potwierdziły wszystkie hashe. Chronione kontenery 3242 zachowały
PID 40953/41010 oraz StartedAt z 2026-11-08 12:36:17 UTC.


## Czysty build fc9 i wykonane regresje CI

Commit `fc9a94f84fc6d9fe345473130bce5f4e847ea77a` jest wypchnięty do PR #423.
Czysty native DEV `8b78a35e1e744af292d9adb6ebbda351` zakończył się succeeded
(CLI exit 0), z jawnym tym samym helper commit. Binarka wypisała `clean`,
source snapshot `2118494522586c1cce35971f34262c6655d9152fad28e1cf5312d7bebb9c163e`,
source digest `da01f860ce0e81e0e21be08af0c0026fce3f6a0da199313b7d624319a5e08577`.
SHA terminala `8fbd15dbed856a9db2ba47dcba561674c2c8f5a43061e2a6db9494e541ca0346`,
config `135fcd6e8b7a8de978d6faeda584190d9023640401f64d0787a15b0c9c78d4c8`.
API `9783abb7-b328-4d1a-b338-9c2ec1260e86` potwierdziło health 200 bez aktywnej
sesji i sessions 200 z pustą listą; warmup workspace/home 200. Grid/Compute
ani odbioru S46 nie wykonano.

Rust job [129188611530](https://github.com/MateuszZelent/fullmag/actions/runs/42625653277/job/129188611530)
wykonał nowe testy publikacji: 7 PASS, 1 FAIL. Błąd dotyczył oczekiwania w
`cached_workspace_resources_remain_readable_during_a_mutation_transition`:
fixture deklaruje `session.status=running`, a test oczekiwał
`awaiting_command` z pomocniczej, nieefektywnej wskazówki runtime.
Endpoint zachował prawidłowy efektywny stan `running`. Asercję dopasowano do
istniejącego kontraktu fixture i dodano kontrolę `session_status=running`;
timeouty oraz sprawdzenie blokady złożonego command status pozostają.
Nie zmieniono kodu produktu, fixture współdzielonej ani progów testu.

Z logu tego joba potwierdzono także 14 odrębnych wyników PASS bramki startu
(włącznie z FMS round-trip), w tym pięć nowych regresji: niepotwierdzony intent,
persistent niepotwierdzony grant, ponowne potwierdzenie, nested shared reader
bez zapisów ownera oraz dokładny direct receipt/odmowa obcego grantu.
Pełne session tests oraz kolejne filtry FMRM/staged bridge/replay nie są
potwierdzone tym wynikiem; przerwany blok nie wykonał ich po pierwszej odmowie.
Poprawka testu wymaga ponowienia CI. S46, aktualne cykle UI i pozostałe bramki
planu pozostają otwarte.
