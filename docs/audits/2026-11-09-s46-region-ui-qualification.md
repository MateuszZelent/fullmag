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
initializer. Ich wykonanie oraz przebudowa backendu są nadal wymagane. Krok CI
sprawdza także obecność obu nazw testów w zakończonym wyniku.

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
ten istniejący binding także w receipcie recreate. Jest to przygotowany kierunek
odbioru; tej migracji stanu jeszcze nie wykonano.

## Pozostałe prace

Wykonać cztery zaimplementowane profile managed browser QA i potwierdzić
rzeczywiste powiązanie receiptów eksportu/importu przez hash skryptu oraz archiwum.
Wykonać
obie rzeczywiste sekwencje oraz testy odmowy zmiany celu/rewizji bez osłabiania
istniejącego profilu całego obiektu `texture-stage-b`. FDM GPU, FEM i multilayer
pozostają oddzielnymi bramkami pełnego planu.
