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


## Czysty build 139 i rzeczywisty błąd startu po Grid

Czysty DEV `ffb83ff1cf064550b7e72c8e7872cd8d`, aplikacja i helper
`139a85fd4a4e4f7496ece032c40d128eb3f9d358`, zakończył się succeeded.
Config: `c1dfe5c881d81b5c5ddb7ac973623456de53292bf480d7ee015a45f0ec444f19`;
source snapshot: `f6d78185395068abb9896516f880a5b5868a4e54def34d591920b35ccfb5679b`;
terminal SHA: `3ea38df59be57b2633e7218d9c32bbe96bbfcf3153c73827353236bfd206d1b6`.
API `0d69717d-b9b9-4ac6-ab08-f926788658d9` potwierdziło health/sessions 200
z pustym stanem, następnie workspace/home 200 po warmup.

Rzeczywisty profil `s46-local-export`, QA `a8d2464823da467ebdaf1336b00b80a5`,
zakończył się failed-confirmed (exit 2). Kliknięta ścieżka produktu
Build + Study ukończyła dokładny Grid `fm-b9682a8d-01ff-42c6-b36e-54921207e9a0`
w 56 789 ms; następny, pojedynczy POST Solve otrzymał HTTP 409:
`command_revision precondition failed: expected 1, got 2`.
Raport nie zawiera timeoutów odczytu ani awarii proxy. To nie jest kwalifikowany
S46 export i nie wolno użyć tej próby jako rodzica importu.

Źródłowa przyczyna: UI buduje admission `command_revision` z długości listy
kolejki, podczas gdy API sprawdza `command_ledger_revisions.commands_revision`.
Poprawny licznik już publikuje `LiveStatusResource.resources.commands_revision`.
`CommandQueueStatusResource.revision` ma semantykę kolejki, odmienną od rewizji
admission w ścieżce RAM; nie jest uniwersalnym zamiennikiem. Poprawka produktu
oraz niezależnego weryfikatora musi używać jawnego licznika statusu, zachować
science pins i odmowę przy rzeczywiście nieaktualnym żądaniu. Nie wolno
podmieniać payloadu w proxy ani automatycznie ponawiać Solve.

Readback trwałego stanu potwierdził manual-held, wszystkie trzy taski accepted,
brak `start_release.json` i zero `worker_execution_started`. Solver nie wystartował.
Zarządzane zatrzymanie `70ac4b1436f141c5ac29a91528198f54` zakończyło się succeeded;
inwentarz po zatrzymaniu potwierdził niezmienione 1962 pliki / 93 815 061 B,
SHA baseline `8e5c38d2efd40a5ba4abd96a4e58dda45500f85037d57f1bcdc7622dceda0252`.
Nie powtórzono odrzuconego Compute i nie zmieniano chronionej grupy 3242.

CI 139: wszystkie workflow poza bootstrap zakończyły się success. W bootstrap
przeszły kroki publikacji/read-model, pełne session reachability/archive,
start-gate oraz frontend typecheck/lint/tests/build i browser fixture.
Job Rust `129203434516` zatrzymał się dopiero podczas kompilacji wszystkich
binarek dla kroku legacy Results. E0433 wskazał nowy test
`staged_publication_revalidation_conflict_never_commits_an_intent` w
`run_intent_persistence.rs`: odwołanie `crate::error::ApiError` nie istnieje
w osobnej binarce schedulera, która również kompiluje ten współdzielony moduł.
Nie jest to dowód awarii endpointu legacy Results: test endpointu nie wystartował.
Test adaptera zmieniono na dokładne przekazanie błędu walidacji wywołującego,
bez zależności HTTP; asercja braku RunIntent pozostaje. Ta korekta wymaga
kompilacji testów wszystkich konsumentów i nowego CI. Dalsze kroki przerwanego
joba nie są potwierdzone. Pełny odbiór P01–P22/S01–S46 pozostaje otwarty.


## Kanoniczna rewizja w niezależnym odbiorze

Weryfikatory S46 i podstawowego cyklu ponowień pobierają admission
`command_revision` z publicznego `status.resources.commands_revision`.
Nie zmieniają wychodzącego żądania ani nie ponawiają POST. Usunięto wyłącznie
nieprawidłowe równości queue revision/admission revision i count/admission;
liczba poleceń pozostaje metadanymi, sprawdzanymi względem liczby wpisów.
Gotowość nadal wymaga dokładnego ukończonego Grid, pustych liczników pracy,
zgodnego runu, sceny, domeny, sesji, etapów oraz preparation z receipt.
Podsumowanie prepared Grid jawnie zachowuje rewizję statusu, a niezależny
walidator Python porównuje z nią precondition. Regresje obejmują durable
revision 8 przy czterech wpisach, fallback z osobną agregatową rewizją kolejki,
brak canonical revision, nieaktualny precondition i błędy gotowości.

Wykonano lekkie, interpretowane kontrole bez instalacji i bez kompilacji
aplikacji na hoście: 32 testy Node weryfikatora S46, 73 unittest walidatora
browser QA oraz 15 testów workflow — wszystkie PASS. Wczesna bramka CI
uruchamia staged adapter tests także w `fullmag-api-accepted-scheduler`,
żeby ponownie sprawdzać konsumenta, w którym ujawniono E0433.
Te wyniki nie są odbiorem produktu ani solvera.

Próba recreate z helperem przypiętym do 729 zakończyła się exit 2 przed startem:
zmieniony `scripts/docker_dev_browser_qa.py` nie odpowiadał temu helper commit.
Nie omijano weryfikacji; kolejny build wymaga nowego commita obejmującego
spójnego producenta i konsumenta raportu. Zachowany run a8d nie jest odtwarzany.


Przegląd producent–konsument wykrył brak `resources.commands_revision` w
bazowym `summary(snapshot)` starszego runnera, mimo poprawnego pola w ręcznych
fixture i prepared Grid summary. Producent został uzupełniony przez wspólny
`studyStageRunSummary`; dodatkowa regresja wywołuje rzeczywisty helper i
sprawdza cały zwrócony kształt z rewizją 8. Po tej poprawce ponownie wykonano
73 testy Python i 32 Node — PASS. Nie zalicza to żadnej próby solvera.


## Admission Study po Grid — poprawka produktu i pełna regresja frontendu

UI bierze początkowy i przedwysyłkowy `command_revision` wyłącznie z istniejącego
`LiveStatusResource.resources.commands_revision`. Nie rozszerzono API/OpenAPI
ani nie użyto liczby wpisów lub agregatowej rewizji kolejki. Solve, Run i Relax
wymagają uchwyconych pinów modelu oraz świeżego statusu, kolejki i solvera.
Świeży odczyt aktualizuje dostępność, zachowując uchwyconą scenę, mesh, domenę,
regiony i bieżący run. Brak odczytu/pinu, nieterminalne polecenie, aktywne
liczniki, wyłączone sterowanie danego rodzaju lub aktywny solver zatrzymują
Compute przed POST. Stop/Pause zachowują odrębne reguły.

Inspector przekazuje status swojej projekcji kolejki przez rzeczywisty
`createCommandContext`; stan inny niż ready blokuje Compute. Build + Study
korzysta ze świeżego proof i własnego preflight, więc stary status projekcji
sprzed Grid nie zatrzymuje poprawnej kontynuacji. Przegląd nie wykazał obcinania
kanonicznej rewizji przez rzeczywiste selektory Explorer/Ribbon/provider.
Uzupełniono ich niepełne fixture, zachowując asercje targetów i powodów odmowy.

Weryfikacja w dokładnej stałej usłudze frontendowej grupy zadania:

- `a194864240d0466fab6c9b699cacaee1`: 308 testów w sześciu bezpośrednich
  plikach PASS, typecheck PASS, ESLint dziesięciu zmienionych plików PASS.
- `cf403cd4584541f2a135c117f984d9b5`: pełny Vitest 9683/9683 PASS,
  925/925 plików; pełny ESLint `--max-warnings=0`, architecture hygiene i
  API hygiene PASS. Source hashes, kontenery, techniczne wolumeny oraz
  metadane frontendu pozostały zgodne przed i po kontroli. Logi i receipt
  pozostają w `verification/p22-command-revision/<attempt>` wolumenu grupy.
- Dziewięć regresji świeżej gotowości najpierw odmówiło
  (`a9fc3741f04745e69f8f2a4ac75600f7`), potwierdzając dodatkowy POST mimo
  aktywnego/wyłączonego świeżego stanu. Po poprawce PASS. Trzy regresje
  rzeczywistego konstruktora kontekstu najpierw wykazały utratę pola
  (`e490f208a001424298242bf36df97dd1`), a po forwardzie PASS
  (`e120fbef80ca4623a1f382b62171426e`). Nie usunięto asercji braku POST.
- Ograniczony niezależny source review domknął znalezione luki gotowości oraz
  producent–konsument; nie zgłoszono dalszego P1/P2 w tym fragmencie.

Osobny nadal otwarty przypadek S21: lokalny, nierozstrzygnięty intent Compute
jest zapisywany, ale nie stanowi jeszcze bramki kolejnego kliknięcia w tej samej
karcie. Należy wykorzystać istniejący CommandFeedbackController i jego store,
z pamięciowym śledzeniem lokalnego started oraz odczytem zakresowym w kontekście
komend. Nie tworzyć drugiego store ani automatycznego retry. Ustalenie źródłowe
nie dowodzi zaakceptowania drugiego runu. Ten przypadek wymaga osobnego fragmentu
oraz regresji utraty ACK. S46, cykl rzeczywistego UI i FDM Cell Physics pozostają
otwarte; powyższe testy nie zastępują solvera ani odbioru wizualnego.

Backend/helper `b9658c1fedbedff1e86624fc15202e69da51af4a` przeszedł native
build/start w `ac4efcc4b2bf457081755eb045853400`, config
`a2339e15196d619a630d5a656e79eac8677e82019b66408c82bf210472bb5fe8`,
snapshot `2014b1ef2575cee2c2938c6a631cf56a1cffa52cd9773da0f918bce65089188f`,
terminal SHA `6a5e70387cc16fc3a6c56b87c80605294f4d7fb19091024680dd6c1b5bb7f3c9`.
API `2f967af3-f156-43ae-8b0a-6babdff8e1a6` zwróciło health/sessions 200
z pustym stanem. Nie wysłano Grid/Compute. Frontend był wtedy live widokiem
jeszcze niezacommitowanej poprawki; jest to dowód backendu, nie kwalifikacja
finalnego wspólnego commita UI. Recreate `dcf19c28010440d2ba43519ba3bbd3bc`
zachował wszystkie 1962 pliki poprzedniej próby (93 815 061 B). Chronione 3242
zachowało kontenery, PID 40953/41010 oraz StartedAt z 8 listopada.

Wszystkie sześć workflow dla commita 729 zakończyło się success, w tym
[bootstrap 42637988126](https://github.com/MateuszZelent/fullmag/actions/runs/42637988126).
To potwierdza naprawę E0433 w kompilacji wszystkich binarek. Nie jest dowodem CI
późniejszej poprawki UI ani nowego wczesnego filtra scheduler tests.


## Bieżące ograniczenia odbioru i regresje S21 — 9 listopada

Po powyższej kontroli backend tej samej próby zamknął admission: supervisor
nie potwierdził liveness usługi native przez 124 s. Odczyt publicznego
`/v2/platform/health` nadal zwraca HTTP 200, ale `status: degraded`, tę samą
instancję API i `active_session: false`; `/v2/sessions` zwraca pustą listę.
Nie jest to gotowy runtime do odbioru. Nie odtworzono żadnej symulacji.

Przygotowano testy pamięciowego śledzenia lokalnego started, deduplikacji ACK,
wiązań sesji i dokładnego odrzucenia. Dodatkowe regresje wywołują rzeczywisty
CommandRegistry z istniejącym CommandFeedbackController: utrata ACK dla
Solve/Run/Relax, dwa kończące się równocześnie preflighty, przekazanie tego
samego właściciela przez createCommandContext oraz bramka nowego Build + Study
z zachowaniem odczytowej kontynuacji własnego wcześniejszego zamiaru.
Kod produkcyjny tej korekty nie został jeszcze zmieniony. **Testy nie zostały
uruchomione:** driver zatrzymuje się w konstruktorze BuildControl przy odczycie
`namespaces/current.json`, po 60 s, przed nadaniem próbie testowej ID i przed
Docker exec. Tak samo kończy się odczyt poza sandboxem. Nie jest to RED ani
GREEN; wcześniejsze 9683 PASS dotyczą wyłącznie wcześniejszego zestawu źródeł.

Odczytowy inwentarz WSL wykazał 72 kanoniczne katalogi buildów (36 z wpisem
completed), łącznie 1 249 280 B, głównie metadane. Dodatkowo znaleziono sześć
odtwarzalnych cache Go/npm/Node: 953 843 712 B unikalnych bloków, bez twardych
linków poza tymi katalogami. Nie stwierdzono ich bindów w 79 sprawdzonych
kontenerach ani pasujących widocznych cwd/fd procesów; część procesów systemowych
pozostaje niedostępna do inspekcji. Zgoda użytkownika obejmowała inwentarz;
nie wykonano usuwania. Pełne drzewo źródeł z run_output (457 752 576 B),
historyczny runtime local (648 011 776 B), sesje, wyniki i control są zachowane.
Pomiar dotyczy WSL, bez doliczania Docker/Windows. Przy około 209 MiB wolnego
wymagany 1 GiB dla zachowanego eksportu/importu S46 pozostaje niedostępny.

Pozostają otwarte: S21 z potwierdzonym trwałym wynikiem i wariantami macierzy,
cztery kwalifikowane kroki S46, rzeczywisty cykl UI, wizualny odbiór FDM Cell
Physics oraz pozostałe bramki P01–P22/S01–S46. Ograniczenia środowiska nie
zmieniają kryteriów ukończenia ani nie zastępują odbioru produkcyjnymi testami
źródeł. Następny krok to przywrócenie zarządzanego odczytu kontrolnego,
wykonanie RED przed implementacją S21 i zwolnienie zatwierdzonego miejsca
przed odbiorem wymagającym zachowania kolejnych wyników.


## Aktualizacja S21 po wykonaniu regresji — 9 listopada, dalszy ciąg

Poprzedni akapit „Kod produkcyjny tej korekty nie został jeszcze zmieniony”
opisuje wcześniejszy checkpoint. Poniżej stan po kolejnych zmianach; dotychczasowe
wyniki i ograniczenia pozostają zachowane jako historia, nie bieżące GREEN.

Istniejący CommandFeedbackController śledzi lokalny started także w pamięci,
bramkuje następny Compute w tej samej sesji i zachowuje pierwszy niezmienny JSON
żądania. CommandContext otrzymuje tego samego właściciela. Ponowna kontrola
bezpośrednio przed POST zatrzymuje dwa równoległe preflighty. Nowy Build + Study
jest blokowany przy nierozstrzygniętym Compute; własna odczytowa kontynuacja
wcześniejszego Build + Study pozostaje dostępna.

Zarejestrowano ręczną komendę `study.retry-compute` („Retry original Compute”).
Ponawia pierwotne body i client_intent_id, bez nowego UUID i bez odświeżania
preconditions z aktualnie edytowanego modelu. Legacy hint bez body nie pozwala
zrekonstruować żądania. Nie dodano automatycznego ponawiania POST. Komenda jest
na razie dostępna przez rejestr/paletę; stały przycisk Inspectora i akcja toastu
nie zostały jeszcze dodane ani odebrane wizualnie.

Klient API dekoduje opcjonalny płaski `intent_disposition: "not_accepted"`.
Brak pola nie jest dowodem odrzucenia. Błędy HTTP, także 400, 409, 422 i 503,
bez takiego dowodu zachowują nierozstrzygnięty Compute. Backend nie publikuje
jeszcze tego nowego kontraktu: pozostaje do wdrożenia właścicielski, trwały
odczyt pod transition fence oraz finalny replay także dla dynamicznych błędów
materiału. Nowa regresja HTTP backendu jest przygotowana, lecz nie była wykonana.
Próba hostowego Cargo była błędem procedury i zatrzymała się przed kompilacją;
nie jest zaliczona jako RED i nie jest ponawiana.

Weryfikacja źródeł w istniejącym frontendzie właściwej grupy Compose:

- Core S21: potwierdzony RED 12 FAIL / 165 PASS; następnie 179/179 PASS.
- Zapis oryginalnego body i ręczne ponowienie: RED 21 FAIL / 178 PASS;
  po implementacji 200/200 PASS w `01f3605bc4314054a5fad574301c22c1`.
- Zachowanie odpowiedzi bez dowodu odrzucenia: RED 7 FAIL / 198 PASS
  w `a6e1ee679d5d42929d03a6e989c002fe`; następnie **205/205 PASS**
  w `bb571520409d49e69c7cc8bbe92da498` (5 plików). SHA raportu Vitest:
  `c955588d5426ee976aa4b879eaa6b72d32475649d13fd6cbbbff804f0b115056`.
- Klient API: **178/178 PASS**, `6e347bd4626a4eb8965a155a152830fd`.

Próby diagnostyczne mają rzeczywiste kody zakończenia i raporty Vitest w
prywatnym wolumenie frontendu oraz sprawdzone przed/po wejścia źródeł, tożsamość
usług, mounty i provenance backendu. **Nie opublikowały pełnego receiptu** i nie
zastępują wymaganych bramek. Wcześniejsza atomowa publikacja receiptu RED oraz
logu typecheck pozostaje nierozstrzygnięta: należące do niej procesy czekają
na I/O; pliki tymczasowe zachowano. Odczyt logu ujawnił TS18048 w hooku
KernelProvider; optional chaining poprawiono, ale bieżący typecheck, lint
oraz bramki architektury/API nadal oczekują wyniku osobnej próby
`f2a3d57c2d6e44598b45193691324b9e`.

Czytelny inwentarz zakończonych buildów: `/tmp/p22-inwentarz-buildow.md`.
Sześć cache nadal czeka na osobne zatwierdzenie; nic nie usunięto. Cache
Context7 był od pomiaru używany, więc przed ewentualnym usuwaniem trzeba
ponowić kontrolę rozmiarów i konsumentów. Pomiary WSL nie są pomiarami Windows
ani filesystemu Dockera. S46, działający backend i rzeczywisty odbiór UI
pozostają otwarte; zmiany nie są jeszcze scalone na master.


Próba statyczna `f2a3d57c2d6e44598b45193691324b9e` zakończyła obserwację po
600 s jako **outcome-unknown**, nie jako potwierdzony błąd TypeScript. Dokładny
Docker exec `5e3a4b847b6a400927f66e70b1ed4df4fc34b02225d02381c7ebdb688f94a6aa`
nadal jest Running (VM PID 37569); jego `next typegen` ma wątek w stanie D,
`folio_wait_bit_common`. Nie ponowiono operacji i nie zwolniono jej blokady.
ESLint oraz bramki architektury/API nie zostały w tej próbie rozpoczęte.
Odczyt health portu 3243 o 19:02 UTC nadal pokazał `degraded`.
Test HTTP backendu odizolowano w osobnym procesie testowym: zmienna konfiguracji
runtime jest ustawiana wyłącznie w środowisku dziecka, bez mutacji procesu
uruchamiającego równolegle inne testy. Parser Rust nie zastępuje kompilacji;
regresja backendu pozostaje niewykonana. Żaden z tych wyników nie kwalifikuje
merge ani runtime/UI.


## Oddzielny pomiar WSL i filesystemu Dockera

Kolejny odczyt potwierdził około 195 MiB wolnego na WSL. Jednocześnie
istniejąca usługa frontend zwróciła przez statvfs **198 087 086 080 B**
(około 184 GiB) dostępnych zarówno dla prywatnego cache, jak i codegen.
Windows C: zgłosił około 17 GiB wolnego. To trzy odrębne pomiary;
nie należy przypisywać zawieszenia fsync/typegen brakowi miejsca w wolumenie
Dockera na podstawie zapełnienia WSL. Przyczyna oczekiwania I/O pozostaje
nierozstrzygnięta. Ewentualne zatwierdzone zwolnienie sześciu cache WSL
rozwiązuje wymóg miejsca na zachowane wyniki S46, ale nie jest dowodem
naprawy I/O Dockera. Nie wykonano restartu globalnego ani zmian cudzych grup.
Odczyt Engine API dokładnego exec kontroli typów o 19:04 UTC nadal potwierdzał
Running, bez kodu zakończenia.


## Niezależny review S21 — retencja Build + Study po odrzuceniu

Przegląd nowego diffu potwierdził dodatkową lukę P2, której dotychczasowe
205 testów nie obejmuje. Build + Study zachowuje `operation.solve`, gdy Solve
zwróci pending bez command ID. Późniejszy jawny retry może otrzymać dowód
`not_accepted` i wyczyścić tracker w CommandFeedbackController, ale nie usuwa
zachowanej kontynuacji Build + Study. Kolejny odczyt pustej kolejki zwraca
znowu ten stary pending, a anulowanie pozostaje niedostępne, bo operation.solve
istnieje. To ustalenie ze źródeł, jeszcze bez wykonanej regresji RED.

Wymagane domknięcie: po takim dokładnym rozstrzygnięciu kontynuacja musi zostać
bezpiecznie zakończona albo kolejne jawne kliknięcie użytkownika rozpoczyna nowy
cykl z aktualnymi warunkami. Sam brak wpisu w kolejce, błąd bez dowodu albo
odrzucenie obcego intentu/sesji nie mogą wyczyścić własnego nierozstrzygniętego
Compute. Nie wolno dodać automatycznego POST. Przygotowanie regresji należy
wyłącznie do testów Build + Study; kod produkcyjny tej kolejnej korekty nie
został zmieniony. Jej RED/GREEN nadal wymaga zwolnienia istniejącej blokady
przez rozstrzygnięcie tej samej działającej próby, bez nowego testu równolegle.


Dodano trzy regresje źródłowe Build + Study: dokładne `not_accepted`,
markerless 503 oraz odrzucenie obcego intentu/sesji. Fixture korzysta z tego
samego bus/controller i kanonicznego zakresu, odpowiada na dokładny requestId
potwierdzenia budowy i sprawdza zgodność ponowionego body/intent oraz brak
automatycznej mutacji. Poprawiono fixture przed uruchomieniem: samo dodanie bus
bez respondera zawieszałoby test na dialogu zamiast wykazać regresję produktu.
Testy pozostają **niewykonane**, produkcyjna naprawa tej luki nadal otwarta.
Po trzeciej kolejnej turze z potwierdzonym żywym exec i blokadą I/O zapisano
worktree jako blocked; nic nie scalono ani nie wycofano. Punkt wznowienia:
`/tmp/p22-wznowienie-po-io.md`. Sam wzrost wolnego miejsca WSL nie zastępuje
potwierdzenia działającego I/O Dockera ani wymaganego odbioru UI.


## Wznowienie i wykorzystanie istniejącej bramki hosted CI

Po ponownym uruchomieniu celu zachowane źródła miały identyczne hashe, a ten
sam exec nadal był Running i trzymał blokadę testów. Nie uruchomiono drugiej
próby ani restartu Dockera. Windows CLI potwierdził tę samą tożsamość silnika
co WSL i stan Desktop running; brak odpowiedzi Linux Desktop CLI nie oznacza
awarii Engine. Inwentarz pokazał 27 działających kontenerów, w tym 8 Fullmaga
z restart_policy=no. Globalny restart nie został zatwierdzony ani wykonany.

Zapisano dwa niezależne fragmenty: klient API
`922ec4b49fc0a18fe222014952d42548e1ec3060` oraz właściciel obserwacji
`3b8285f565dbcc2315ba88ae214ac46f854727b6`. Niezmienione testy tych fragmentów
miały odpowiednio 178 PASS i 24 PASS. Wszystkie sześć workflow commita 3b8285f56
zakończyło się success, w tym
[bootstrap 42694394674](https://github.com/MateuszZelent/fullmag/actions/runs/42694394674).
Job frontendowy 129422235986 potwierdził typecheck, lint, architekturę,
pełny zestaw 9696 PASS / 13 skipped (925 plików PASS / 1 skipped), dodatkowe
3 testy performance i produkcyjny build Next. To dowód źródeł tego commita,
nie nowego runtime, S46 ani odbioru wizualnego.

Istniejący nieblokujący hook React Doctor został wykonany z już zainstalowanym
narzędziem, bez pobierania pakietów i bez zmiany hooka. Dla API i kontrolera
sam analizator zgłosił wewnętrzny błąd oxlint `Unexpected discriminant 7 for
TSTypeName`; tego wyniku nie zaliczono jako PASS. Wymagane projektowe lint i
typecheck później rzeczywiście przeszły w hosted CI.

Kolejne jawne checkpointy WIP szkicu PR zawierają brakujące regresje do
wykonania RED w tej samej istniejącej bramce. Obejmują retencję Build + Study,
HTTP not_accepted oraz późny foreground pending po odrzuceniu/terminalnym
ledgerze. Dodano także przypadek przez rzeczywisty CommandRegistry i helper
runtime: oryginalny POST pozostaje w toku, jawny retry potwierdza odrzucenie,
a dopiero potem kończy się oryginalna utracona odpowiedź. Nie wolno z niej
odtworzyć blokady Compute. Regresje są na tym etapie **niewykonane**; produkcyjna
naprawa tych konkretnych luk czeka na ich rzeczywisty RED. WIP nie oznacza
ukończonego etapu ani gotowości do merge.

Review kontraktu backendu wykazało, że sam domain_generation_id jest
fingerprintem i może wrócić do wcześniejszej wartości; nie stanowi dowodu
nieodwracalnego odrzucenia. Także wrapping_add mesha wymaga ostrożności przy
wnioskowaniu o monotoniczności. Marker musi wynikać z potwierdzonego trwałego
missu we właściwym ownerze i terminalnej niezgodności przypiętych wejść,
a nie z samego kodu HTTP, pustej kolejki lub przejściowego mismatchu domeny.
Żadnego kodu produkcyjnego tej korekty backendu jeszcze nie zmieniono.


## Hosted RED i korekta protokołu późnego wyniku

HEAD `6b8ac9b1ba19b6a6e58bf7e7e09f0cbff855dc5b` został wypchnięty na szkic PR423.
[Bootstrap 42702459943](https://github.com/MateuszZelent/fullmag/actions/runs/42702459943),
job frontendowy `129450453603`, wykonał typecheck i lint, a potem potwierdził
**4 semantyczne FAIL / 9719 PASS / 13 skipped**. Dwa FAIL dotyczą późnego
pending po odrzuceniu lub terminalnym ledgerze, trzeci rzeczywistej ścieżki
Runtime → CommandRegistry po retry, czwarty starej kontynuacji Build + Study.
Są to oczekiwane regresje, a nie błędy kompilacji lub testowej fixture.

Poprawka dodaje opcjonalny lokalny marker wyniku tylko po wyemitowaniu started.
Registry przekazuje marker; kontroler nie odtwarza rozstrzygniętego intentu z
późnego niepotwierdzonego pending. Znany ACK i nieoznaczony legacy wynik nadal
podlegają obserwacji. Build + Study pyta tego samego właściciela o dokładny
intent i wylicza aktywność kontynuacji; nie wnioskuje z pustej kolejki ani nie
wysyła automatycznie nowego POST. Przegląd źródeł nie znalazł dalszego P1/P2;
pełny GREEN tych zmian pozostaje wymagany.

Backend job `129450453156` skompilował i uruchomił nowy test HTTP, ale fixture
zatrzymała request na `session_connectivity_disconnected` przed oczekiwanym
`command_current_run_changed`. **To nie jest semantic RED brakującego markera.**
Fixture wymaga korekty podłączenia sesji przed ponownym uruchomieniem CI;
produkcji backendowego dowodu nieprzyjęcia jeszcze nie zmieniono.

Artifact `inspector-actions-browser-fixture` tego samego HEAD ma SHA-256
`be9b714ffd21bedfd02bd590bd2c310e06f46bac62e0f60f4a8d7ce5b73c71e8`.
Odczytano raport i obejrzano Object wide pending oraz Airbox narrow live.
Siedem kroków przeszło, ze stabilnymi kontrolkami; raport jawnie kwalifikuje
wyłącznie syntetyczne callbacki (0 żądań mutacji backendu), nie pełne API,
FDM Cell, wyniki solvera ani odbiór rzeczywistego UI.

Docker Engine nadal odpowiada; własny frontend jest healthy, backend unhealthy,
health HTTP200/degraded. Dokładny typecheck exec pozostaje Running, więc nie
ponowiono lokalnej bramki. Bieżący odczyt df pokazał 761 MiB wolnego na WSL
i 20 GiB na C:, bez usuwania danych przez ten etap. Nie jest to dowód naprawy I/O
ani wystarczającego miejsca dla wymaganego S46 export/import.


Fixture HTTP została uzupełniona o protokołowo zgodny testowy owner Ready i
kontrolowany socket statusu. Parent przekazuje prywatną ścieżkę konfiguracji
przez Command::env; przypadki nie zmieniają globalnych zmiennych środowiska.
Brak accepted-store zachowuje rzeczywistą odpowiedź connectivity degraded bez
markera. Rust CI przechwytuje teraz prawdziwą tożsamość źródeł istniejącym
capture_source_snapshot_identity.py przed Cargo: żaden walidator nie został
osłabiony i nie podstawiono fikcyjnego 64-hex hasha. YAML i osadzony Python
przeszły parser, a polecenie capture zwróciło poprawny commit/snapshot lokalnych
źródeł. Rustfmt sparsował fixture. Kompilacja i właściwy semantic RED nadal
wymagają następnej próby CI.

Istniejący artefakt generated-api-contract zachowuje również mapę ścieżek
TypeScript i cały generowany klient Pythona, zgodnie z już działającą bramką
deterministyczności. Umożliwia to zastosowanie rzeczywistych wyników generatora
po późniejszej zmianie schematu bez ręcznej edycji SDK.

Dodano niewykonane jeszcze regresje widocznej akcji retry w Study Runtime
(SSR, nie odbiór przeglądarki) oraz starej akcji wskazującej inny clientIntentId.
Produktowy przycisk i dokładne targetowanie komendy czekają na ich RED.


## Druga próba hosted CI i widoczna akcja recovery

HEAD `508b84157d86b6cc557e6c4538612700d98e4b34` jest wypchnięty.
[Bootstrap 42709412911](https://github.com/MateuszZelent/fullmag/actions/runs/42709412911),
frontend job `129474665206`: typecheck/lint przeszły; **9725 PASS / 2 FAIL /
13 skipped**. Wcześniejsze cztery regresje zostały zamknięte: Controller ma
21 PASS, Build + Study 15 PASS, Registry 18 PASS; rzeczywisty Runtime race nie
występuje już w zbiorze błędów. Nowe FAIL prawidłowo wskazują brak przycisku
retry oraz ignorowanie targetu starej akcji recovery. Nie jest to pełny GREEN.

Następna poprawka pokazuje w Study Runtime wspólny przycisk i banner design
systemu, bez nowego store, własnego transportu lub automatycznego POST. Kontroler
Inspectora przechwytuje clientIntentId tego samego ownera i przekazuje go przy
kliknięciu. Komenda odrzuca stary lub malformed target zamiast wybierać inny
pending request. Dodano kontrolki dokładnego poprawnego targetu, malformed ID
i braku przechwyconego ID. Istniejące wywołania bez targetu, także z kontekstem
wybranego Stage, zachowują dotychczasowe wybieranie jednego oryginalnego intentu.
Te zmiany wymagają GREEN i rzeczywistego browser finish gate; SSR nie kwalifikuje
układu, fokusu, kliknięcia ani aktywnej sesji solvera.

W bieżącym Rust job `129474665005` krok przechwycenia prawdziwego source identity
zakończył się success. Generator job `129474665122` również zakończył się success.
Wynik zamierzonego backend HTTP RED pozostaje do odczytu.

Ponowny odczyt dokładnego lokalnego exec potwierdził Running i ten sam PID37569;
API 3243 nadal HTTP200/degraded, active_session=false. Przygotowano odczytowy
inwentarz 27 działających kontenerów oraz plan opcjonalnego restartu Docker
Desktop. Dotyczyłby on także chronionej grupy 3242 i innych projektów, a 8
kontenerów Fullmaga ma restart_policy=no. Osobne pytanie o zgodę pozostaje
oczekujące; brak restartu, replay i usuwania danych.


Log trwającego Rust job 129474665005 stał się dostępny przed końcem workflow.
Wskazał E0382 w fixture: parametr submit_store_root został przeniesiony do
AppState, a następnie pożyczony do skonfigurowania testowego runtime. Korekta
odczytuje ścieżkę z AppState; brak klonowania ani zmian produkcji. To błąd
kompilacji fixture, nie oczekiwany semantic RED markera. Błędy późniejszych
kontraktów z tego samego powodu nie są osobnymi problemami runtime. Następny
push może zastąpić tę już diagnostycznie rozstrzygniętą próbę CI; test HTTP
nadal musi rzeczywiście dotrzeć do swoich asercji.


## Pełny GREEN źródeł frontendu f0650c2a9

Job `129487644325` w [bootstrap 42713138167](https://github.com/MateuszZelent/fullmag/actions/runs/42713138167)
zakończył się success dla HEAD `f0650c2a9b1e52f3c7505716ad9088b39873fae0`.
Typecheck, lint bez ostrzeżeń, architecture/API hygiene, performance i produkcyjny
build Next przeszły. Vitest: **9730 PASS / 13 skipped**, **926 plików PASS /
1 skipped**; dodatkowe testy performance **3 PASS**. Bezpośredni Runtime ma
168 PASS, Controller21 PASS, Build15 PASS, Inspector recovery3 PASS. Zamknięto
oba nowe RED dotyczące widocznej akcji i dokładnego targetowania.

To kwalifikacja źródeł tego commita. Nowa browser fixture nadal wymaga wykonania,
a backendowy proof HTTP, natywny runtime, S46, FDM Cell i pełna macierz odbioru
pozostają otwarte. Recovery ma własny stały keyed slot i toolbar; dotychczasowy
Runtime toolbar zachowuje swoje dzieci. Kontrola dokumentacji React przez
Context7 potwierdziła regułę tożsamości przez pozycję/klucz, lecz nie zastępuje
testu rzeczywistego DOM i fokusu. Nie potwierdzono reprodukcją obawy remountu
pierwszej wersji ze statycznymi warunkowymi slotami JSX.


## Potwierdzony backend semantic RED i pełniejszy kontrakt materiału

Bezpośredni odczyt GitHub job `129487643164` potwierdził zakończenie failure.
Log z 22:49:41 UTC dla PR HEAD f0650c2a9 przeszedł kompilację oraz wcześniejsze
asercje status/code, no-key, no-root i body-conflict. Dopiero końcowy assert
`live_compute_request.rs:968` otrzymał `[None, None]` zamiast dwóch
`Some("not_accepted")`. To właściwy semantic RED producenta dowodu. Niezmienione
trzy inne testy modułu przeszły; child pozostaje celowo ignorowany i uruchamiany
przez parent. CI skompilowało PR merge candidate
`8863f53021f50d6a9884534188fac60d0c90442b`, source snapshot
`e06f620ef2eb0990ba535e29fb711adf16cac59a53e6e25bd70a8eb37a4899c7`.
Migawka łącza GitHub opóźniała numer kroku; dokładne czasy i terminalność
potwierdzono bezpośrednim API GitHub, zamiast interpretować brak logu jako stop.

Dodatkowy przegląd wykazał, że material400 występuje przed sprawdzeniem pinów,
a obecny test ma także nieaktualny current_run. Sam nie dowodzi czystego przypadku
błędnego materiału przy zgodnych pinach. Resolver czyta wyłącznie
SceneDocument.materials i wymagane aex/ms; brak fallbacku do zewnętrznego cache
lub katalogu. Naprawa przez wspierane ścieżki commit zmienia rewizję sceny,
z wyjątkiem saturacji u64::MAX. Producent musi zachować typowany błąd i spójną
podstawę odrzucenia, pod transition ponownie sprawdzić kontekst i tę podstawę
oraz potwierdzić zakończony trwały keyed miss. Zgodny, jawny finite scene pin
jest konieczny do tej podstawy; brak/future/MAX pin nie dostaje takiego markera.
Nie zmieniamy globalnego kontraktu rewizji. Wdrożenie i odpowiednie regresje
pozostają w toku; nowego backendowego producenta jeszcze nie zakwalifikowano.

Rozszerzono istniejącą Inspector actions fixture o produkcyjny StudyRuntimeSection.
Smoke zachowuje Object/Airbox i dodaje dokładny callback klik/Enter, sesję i brak
oryginalnego body, stabilność DOM/fokusu oraz dark/light 300/380 px. Przed każdym
zrzutem Retry ma być faktycznie widoczne w Radix viewport, a overflow obejmuje
również wnętrze Inspectora i normalny toolbar. Kontrola no-body czeka na dokładny
stan, nie tylko wcześniejsze null. Parser Node i diff check przechodzą; właściwe
browser wykonanie oraz obejrzenie nowych zrzutów są nadal wymagane. Raport jasno
ogranicza ten dowód do synthetic callback, przy zerowych mutacjach API.


## Wznowienie 12.11: Docker, recovery i przyciski Inspectora

Bieżący HEAD pozostaje `6654b0e921312081002eef83c727e5a9d44431cf`.
Odczyt terminalnego CI bootstrap `42718282198` potwierdził PASS frontendowych
kontraktów, Inspector browser smoke i deterministycznego generatora API. Rust
pozostaje FAIL; nie jest to pełny zielony odbiór ani dowód natywnego runtime.

Silnik Docker odpowiada (29.9.3), ale dokładna para grupy T8 na porcie 3243
ma `Exited (255)`, wspólny FinishedAt `2026-11-10T14:25:25Z`, PID 0. Dawny
exec typecheck `5e3a4b847b6a400927f66e70b1ed4df4fc34b02225d02381c7ebdb688f94a6aa`
nie istnieje. Read-only odczyt control volume potwierdza zachowany development
receipt oraz process-tree `failed_outcome_retained` z diagnostycznym API.
Obecne abrupt recovery odmawia na tym stanie; nie zmieniono starych dowodów,
nie uruchomiono Solve ani restartu globalnego. Pozostaje wymagane właściwe
recovery tej pary. Na WSL odczytano 542 MiB wolnego: bramka S46 >=1 GiB
nadal nie jest spełniona. Nie usunięto danych.

Następny fragment UI usuwa nakładający się wskaźnik Next DEV przez
`devIndicators: false`; smoke sprawdza rzeczywisty hit-test trzech punktów
Retry oraz Fit view w obu motywach i szerokościach 300/380 px. Inspector
kieruje wynik jawnego ponowienia do istniejącego foreground feedback.
Komunikat po utracie ACK ponowienia mówi o jednym ponowieniu oryginalnego
żądania; regresja nadal wymaga dokładnie dwóch łącznych POST i identycznego
body. Parser smoke i diff check przechodzą. Nowe zmiany wymagają wykonania
CI i ponownego odbioru zrzutów; nie są jeszcze wdrożone w kontenerze.


### Odbiór Inspector fixture po b1f731c12

Job `131539577363`, bootstrap `43320493521`: PASS. Artefakt
`13991175464` ma SHA-256
`50b6f371ebedbd89bd99d6ad51e14ca403a1da330e38f3f12d3d45f71191ec96`
i jest przypisany do PR HEAD `b1f731c122032d335b917db981fb9ea3d9baef0a`.
Receipt wskazuje rzeczywisty CI merge candidate
`de9dec5c85ec53ee6ca05f838d951b288944962f`, niezmieniony digest źródła
`27ec44b4fe01ca6dc5572e07e3e68225367b7dc8030bacbfb7a6b79c45a1c145`,
terminal serwera i exit 0. Raport ma 8/8 kroków PASS, dwa callbacki retry
(klik/Enter) przypięte do `study-compute-a`, zero mutacji API i budżet
React 5/5 commitów wobec limitu 32.

Obejrzano wszystkie cztery zrzuty Retry (dark/light, 300/380 px): wskaźnik
Next nie zasłania już Fit view; Retry i footer pozostają czytelne. Smoke
przechodzi rzeczywiste hit-testy trzech punktów obu przycisków, kontrole
overflow, zachowania węzłów i fokusu. Jest to fixture callback-only, bez
backendu, solvera i nauki. Pełne testy jednostkowe są oddzielną bramką.

Przegląd producenta API wykazał brak jawnego scope w dowodzie odrzucenia:
handler przechodzi do tokio::spawn, który nie dziedziczy task-local nagłówka.
Potwierdzono, że restore może zachować sesję i epoch. Wymagana poprawka
przenosi kanoniczny scope do zadania, sprawdza go pod transition i pomija
marker dla legacy/headerless, bez zmiany klucza ani pozytywnego replay ACK.
Tri-state durable miss i ograniczenia materiału finite/MAX są już poprawnie
rozdzielone w roboczej implementacji. Testy nowego producenta pozostają wymagane.


### Odświeżony inwentarz miejsca WSL (12.11, bez usuwania)

`df -h / /mnt/c`: WSL 542 MiB wolnego, C: 29 GiB. Odczyt `du -sx`
dla kanonicznego `storage/builds` daje 1 282 048 B (około 1,22 MiB):
same zakończone metadane buildów nie zapewnią zapasu wymaganego przez S46.
Dawne `/tmp/mumax-hook-go-cache`, `/tmp/mumax-abc-go-cache`,
`/tmp/fullmag-ctx7-npm-cache`, `/tmp/fullmag-mcp-context7-cache` i
`/tmp/p22-ctx7-20261109` obecnie nie istnieją; nie usunięto ich w tej próbie.

| Kandydat | Zajętość `du` | Decyzja bieżąca |
|---|---:|---|
| `/home/kkingstoun/.cache/go-build` | 353 447 936 B (337 MiB) | Zachować: brak pełnego dowodu właściciela i konsumentów. |
| `/tmp/node-compile-cache` | 31 723 520 B (30,3 MiB) | Zachować: brak pełnej kwalifikacji konsumentów. |
| `/home/kkingstoun/.npm/_npx` | 328 130 560 B (313 MiB) | Zachować: m.in. narzędzie hooka Git; nie jest prywatnym buildem zadania. |

To inwentarz, nie zgoda ani receipt usuwania. Sesje, wyniki, control/ledger,
źródła i współdzielone zależności pozostają zachowane. Nawet usunięcie obu
pierwszych cache nie gwarantowałoby wymaganego 1 GiB wolnego na WSL.


Frontend job `131539576993` (bootstrap `43320493521`) zakończył się SUCCESS.
Odczytany log potwierdza 939 plików PASS / 1 pominięty, 9824 testy PASS /
13 pominiętych, dodatkowe 3 testy performance PASS oraz typecheck, lint,
resource-first/API hygiene, architecture hygiene, idle/Compute performance
i produkcyjny build Next PASS. To CI merge candidate tego PR; nie zbudowano
jeszcze bieżącego backendu lokalnego. Hook Git zgłosił istniejący wcześniej
warning array-index-key w mapie Runtime warnings; nie był to pełny PASS
React Doctor i nie zmieniano hooka ani nie wyciszano reguły.


Roboczy producent odrzucenia zachowuje typowaną podstawę błędu i wykonuje
końcowy replay także dla admission 400. Rozróżnia brak skanu od trwałego miss;
ACK ma pierwszeństwo. Scope jest przechwytywany przed tokio::spawn i ponownie
sprawdzany pod transition. Regresje obejmują headerless, restore z tym samym
id/epoch/rewizją i nową instancją, zmianę podstawy sceny oraz ACK race.
Starsza skończona rewizja sceny ma oddzielny dowód (`expected < observed`);
future/MAX i fingerprint domeny pozostają bez niego. Wspierane commity
sceny saturują rewizję, a import zmienia session epoch. Dodano asercję, że
aktualizacja snapshot bez run nie usuwa istniejącego runu. Negatywne kontrole
no-key/store/domain/body-conflict mają jawny prawidłowy scope, aby brak
nagłówka nie maskował błędu w innych bramkach. Parser rustfmt i diff check
przechodzą; nowe testy backendu nie zostały jeszcze wykonane.


### Jawny wariant recovery dla failed_outcome_retained

Dodano host proof `fullmag.docker-abrupt-stop-proof.v5`, wybierany wyłącznie
przez `--failed-outcome-retained`. Nie jest to native request v5: używa
wyłącznie istniejącego empty request v1. Przypina oryginalne process/OWNER/
LAUNCH/config i dokładny failure fence; wymaga diagnostycznego API z unknown
liveness, matching Ready owner, zatrzymanej pary i pustego store. Dotychczasowe
warianty pozostają bez zmian. Podczas review poprawiono dokładny katalog fence
na `/opt/fullmag/runtime-control/runtime-service`, odrzucono zagnieżdżone
ścieżki oraz dodatkowe/brakujące pola nowego proofu.

81 testów PASS w trzech istniejących modułach unittest:
`test_docker_volume_container_recovery`, `test_docker_volume_abrupt_stop_recovery`,
`test_docker_prepare_container_recovery`. To lekkie testy metadanych z mockami
Docker; nie uruchamiają aplikacji ani kompilacji hostowej. Parsery i diff check
PASS. Bieżąca kontrola control volume potwierdziła brak `/control/active`.

Rzeczywisty preview z pinami
`/tmp/p22-current-recovery-pins.json`, request
`6e00825f-9e01-4673-b7fd-82bacbc29232`, doszedł do kontroli konsumentów i odmówił:
foreign Windows bind kontenera
`011cba60386b345dab03dad226a0f98f6ef7d31874ff2d1c653150e4d83c19f2`
nie ma referencji poświadczającej exact Linux root. Nie opublikowano
autoryzacji ani nie uruchomiono/przebudowano usług. Ta odmowa wymaga sprawdzenia
wobec uprzednio zatwierdzonego group-local recovery (własny volume, bezpośrednie
bindy, blokady i hashe; bez fizycznego badania cudzych checkoutów). Cudzy
kontener pozostał nietknięty. Runtime nadal **NOT VERIFIED**.


### Reattest WSL oraz stan CI po 3feb9c820

Kontrola retained storage wykryła wyłącznie zmianę host_device po restarcie
WSL: 2096 → 2128. Inode i pozostałe cechy katalogu pozostały zgodne. Istniejąca
procedura `reattest-host-device-volume` przeszła preview i apply, operacja
`022278a18b4d45dfb4ad81c4482a7416` ma terminal succeeded. Stary certyfikat
SHA-256 `7a3d38121b8625d0774de60be7b05f11e09913e8a79712fc6e3edfc4ef40a007`
zachowano w journalu, nowy ma
`40a5294d3b2fe39e342fc021b5991f8be2d6160338b08b29aad6218d7c61944e`.
Niezależne wywołanie `_validate_reused_session_before_removal` przechodzi.
Nie zmieniono profilu Linux ani lokalizacji danych. Dokładna para aplikacji
nadal Exited(255); nie jest to dowód gotowości backendu.

PR423 pokazuje CONFLICTING/DIRTY z brakiem potentialMergeCommit, ale lokalny
graf i bezpośredni compare GitHuba zgodnie potwierdzają, że base
`da795b554bfdf66d55cee04cbf0e978aafed2a5a` jest przodkiem HEAD
`3feb9c820bb616590ffe8f07f7b0e34c428c0afa`: 39 ahead, 0 behind.
Merge-tree nie daje konfliktów ani różnic po stronie base; checkout nie jest
shallow i nie ma replace refs. Nie wykonywano zbędnego merge. Nowe przebiegi
pull_request nie powstały. Uruchomiono istniejący workflow_dispatch bootstrap
z contract_scope=bootstrap dla tego brancha (polecenie zaakceptowane, exit 0).
To osobna ścieżka CI; trzeba odczytać rzeczywisty run/source pin i wyniki.
Nie zastępuje wymaganych kontroli oraz poprawnego stanu PR przed scaleniem.


Workflow_dispatch `43328570802` jest potwierdzony in_progress dla dokładnego
HEAD `3feb9c820bb616590ffe8f07f7b0e34c428c0afa`. Generator
`131567194379` wygenerował kontrakt; jego bramka diff jest FAIL z powodu
niezapisanych jeszcze wyników generowania. Artefakt `13993243910`, SHA-256
`3c61946d67f43b8b4bd48c654178fb290ce783ced03f573462fa691737c5b860`,
zawiera siedem plików. Zastosowano wyłącznie oryginalne bajty trzech zmienionych
plików: OpenAPI JSON, TypeScript types i Python models. Pozostałe cztery są
identyczne. Strukturalny diff JSON ma wyłącznie opcjonalne intent_disposition
i enum IntentDisposition, a zbiór eksportów Python dodaje tylko ten enum.
SDK nie edytowano ręcznie. Determinizm na nowym HEAD wymaga kolejnego CI.


Nowy Rust job `131567194495` wykrył E0425 w trzech regresjach restore/material:
`live_compute_request.rs:1216,1268,1306` wywoływały prywatną bramkę sąsiedniego
modułu. To błąd kompilacji testów, nie semantic RED. Udostępniono istniejącą
`validate_authoring_gate_for_command_with_context` wyłącznie wewnątrz crate
i dodano jawny import w testach. Publiczne HTTP ani reguły admission nie
zmieniły się. Parser rustfmt i diff check PASS; kompilacja i wykonanie regresji
na poprawionym commicie wymagają ponownego CI.


Przegląd kolejności bramek wykazał dodatkową lukę: mesh conflict poprzedza
scene revision, a nadal błędny materiał może przerwać admission jeszcze
wcześniej. Po edycji modelu stary body z finite scene pin mógł więc pozostać
unresolved mimo nieodwracalnie starszej rewizji. Końcowa kontrola pod fence
sprawdza teraz typed scene pin niezależnie od pierwszego powodu błędu, dopiero
po completed durable miss i walidacji jawnego scope. Nie zmienia statusu, code
ani message. Dodano rzeczywiste przypadki HTTP mesh mismatch + starsza scena
oraz missing material + starsza scena. Parser/diff PASS; nowe regresje czekają
na wykonanie w CI. To poprawka przepływu sterowania, bez zmian solvera.


Rust run `43332086918`, job `131579020339`, przeszedł wcześniejszą bramkę
kompilacji API, ale osobny target `fullmag-api-accepted-worker` wykrył
E0433/E0432: współdzielony error.rs importował `crate::schemas`, którego worker
nie posiada. Przeniesiono jedyny enum IntentDisposition do wspólnego modułu
błędów, a common schema re-eksportuje ten sam typ. Nie dodano schematów Control
Room do workera ani drugiego enumu. Publiczna nazwa i serializacja są bez
zmian; istniejący SDK pozostaje oryginalnym wynikiem generatora. Parsery PASS,
ponowne CI obu targetów i regresji wymagane. To nie jest nowy semantic RED.
