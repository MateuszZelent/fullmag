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
