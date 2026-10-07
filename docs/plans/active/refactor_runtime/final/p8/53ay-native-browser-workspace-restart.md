# P8-53AY — rzeczywisty restart native/browser z zachowaniem workspace

## Cel i granica

Kontynuacja P8-53AX: sprawdzić produkcyjny koordynator A→B na rzeczywistej,
niepustej scenie oraz odtworzenie niezapisanego dokumentu przez produkcyjny
kernel frontendu. Diagnostyczna sesja ma własny accepted store, port API
i frontend na 3258. Działający workspace na 3197 pozostaje oddzielny.

Publiczne `restart_available` pozostaje wyłączone. Diagnostyczny frontend
dopuszcza przycisk wyłącznie po prywatnym, świeżym potwierdzeniu dokładnej
tożsamości API, worktree, generacji, buildu, źródeł, origin i nonce.
Próba nie kwalifikuje solverów ani wydania Windows.

## Wymagane dowody

1. Weryfikacja niezależnych, utrwalonych pakietów A i B oraz wspólnego profilu.
2. Niepusta kanoniczna scena w API A i rzeczywisty niezapisany dokument w UI.
3. Wywołanie rzeczywistej komendy v2 oraz produkcyjnego pumpa; bez fixture
   zastępującego odpowiedź na komendę lub proces API.
4. Dokładnie zachowana scena, nowy API pin, nowa sesja i epoch 1.
5. Dokument odtworzony przez produkcyjną hydration; baseline służy wyłącznie
   porównaniu i nie może ponownie zasilić store po restarcie.
6. Rzeczywiste PID, odebrane kody zakończenia i terminalne transporty wszystkich
   własnych API/helperów/CLI; nieznany wynik nie jest sukcesem.
7. Właściwy receipt, source identity, kanoniczny eksport OpenAPI oraz dowód
   z przeglądarki. Jeśli próba otwiera viewport: widoczny canvas, zachowany
   kontekst WebGL i niezerowy drawing buffer.

## Implementacja w toku

- Native: `control_room/development_workspace_probe.rs`, jawna bramka
  `browser-workspace`, prywatne ramki stdout i ograniczony input stdin.
- Driver: `scripts/windows/verify_workspace_browser.py`, niezależne kontrole
  świeżości, sceny, dokumentu i custody. Wygasła ramka ze stagingu nie udziela
  eligibility i nie jest interpretowana jako śmierć procesu.
- Frontend: diagnostyczna strona kopiuje rzeczywisty `KernelProvider` oraz
  `WorkspaceShell` z tego samego snapshotu co B. Nowe routy powstają wyłącznie
  w stagingu; źródła produktowych routów pozostają bez zmian.
- Zarządzane wejście: `just verify-windows-development-workspace-browser <bundle-A>`.

## Stan dowodów

- Interpretowane sprawdzenia drivera: **5/5 PASS** — expiry/scope, brak
  pustej sceny jako dowodu, prawdziwe typy PID/kodów i ucięta ramka JSON.
- Pierwszy natywny build: **FAILED, exit 1**. Snapshot
  `70c518aee49588a5e86e774a9dcdd8f6655c05ddb75815b66b6234feff4b9e76`,
  log `native-build-5632bc7092e841838d4a351b2ae575b3.log`. Nowa bramka miała
  E0282, E0502 i E0596. Dodano typ `Option<Instant>`, skopiowano dowód pompy
  przed mutowalnym drenażem i poprawiono przekazanie guarda.
- Ponowienie buildu: **PASS, exit 0**, snapshot
  `55f63cd4453c3483430a0e4f4dc05d62d49ae9fb225709610e52e2b19bee345e`,
  log `native-build-130cc681421f4e27b5fb97aa457a8be3.log`.
- Izolowany noEmit strony bez ambient types nie jest miarodajny. NoEmit
  oraz lint rzeczywistej strony w stagingu Next: **PASS, exit 0** (receipt
  `e3a543fc486948fc81db36f726dedb1f`, ponownie `052d1d54850d490586072f97308b19b2`).
- React Doctor nie zakończył kontroli; **NOT VERIFIED**.
- Pełna próba native/browser i hydration: **NOT VERIFIED**. Pierwszy driver
  używał niewłaściwej nazwy diagnostycznego statusu; dostosowano ją do
  istniejącego `backend-watch-status.json`, w odrębnym profilu checks.
  Obserwator używa teraz `GetSystemTimePreciseAsFileTime` jak Rust, przy
  niezmienionej ważności lease 1000 ms. Strona otworzyła się, lecz kreator
  nie dostał `FULLMAG_STATE_DIR`; próba zakończyła się bez utworzenia modelu
  i bez restartu. Uzupełniono środowisko kolejnej próby. Wykryto również
  brak raportowania zakończonych helperów readiness na tej ścieżce awarii.
  Probe zbiera teraz PID-y przed i po kroku pompy i zachowuje je w raportach
  sukcesu, awarii oraz nieznanego wyniku. Zaliczenie tej poprawki wymaga
  ponownego buildu i rzeczywistej próby; sam parser nie stanowi dowodu custody.
- Gotowość publicznej funkcji restartu: **NOT VERIFIED**.

Build skoordynowanego worktree zakończył się exit 0; potwierdzono brak jego
procesu managera i zwolnienie blokady. Ponowienie tej bramki korzysta ze
standardowej zarządzanej trasy. Wczesne oczekiwanie na storage zrelacjonowano
przez ten sam uchwyt procesu; nie uruchomiono równoległego wykonawcy.

## Bieżący checkpoint — 05.10.2026

Uruchomiono kolejny zarządzany `just windows-backend-dev 3197`, z poprawką
raportowania helperów i `FULLMAG_STATE_DIR` w driverze. Log:
`native-build-5aa15ba41b0c4b0e9e9d7ccd596f17da.log`.
Build zakończył się **PASS, exit 0**. Snapshot:
`99fa382b3d13398993dd53871d1c0a7b31434c03b6eca71ade09de0307893033`.
Backend/API: 2 min 40 s; desktop: 1 min 15 s. Launcher potwierdził gotowość
natywnego pakietu po końcowej kontroli snapshotu. Interpretowane kontrole
drivera ponownie **5/5 PASS**. Nie kompilowano testów jednostkowych Rust.

Uruchomiono rzeczywistą próbę przeglądarkową z pakietem A
`3b1de31747fb4fe7b5275b8cfdec42cd`. Wynik restartu i odtworzenia dokumentu
pozostaje **NOT VERIFIED** do zakończenia czynności UI i zebrania końcowego
raportu procesów; sukces buildu nie zalicza tej bramki.

Próba `b36fb7c3677744fb8b5ef2acc24c823c` potwierdziła w rzeczywistym UI:
utworzenie pustej symulacji, zatwierdzenie cienkiej warstwy, utworzenie regionu
`Restart region` i utworzenie oraz przypisanie materiału. Scena miała 1 obiekt,
1 region i 1 materiał, revision 4. Nie uruchomiono meshera ani solvera.
Canvas był widoczny, `context_lost=false`, drawing buffer 532×281.

Kontrola `Setup draft` odmówiła przed wysłaniem komendy restartu. Fixture
stosował warunek dla surowego statusu (`restart_available=false`) do odpowiedzi
typowanego klienta po prywatnym overlay (`true`). Dodatkowo mylił złożony
`SessionResourceIdentity.sessionEpoch` z liczbowym epoch właściciela API.
Poprawki dotyczą wyłącznie diagnostycznej strony; nie zmieniają publicznej
gotowości restartu ani nie zaliczają odtworzenia dokumentu. Dowód obrazu:
`fullmag-native-authoring-before-restart.png` w katalogu wizualizacji tej rozmowy.

Próba zakończyła się **FAILED**, bez restartu. Receipt zachował terminalne
wyniki: CLI 61880 → 1, API A 70272 → 1, selektor 64172 → 0 oraz helpery
89584 i 69728 → 0; wszystkie mają `waited=true`. Nie utworzono API B.
Poprawka raportowania helperów jest potwierdzona dla tej ścieżki awarii.
NoEmit i lint strony w rzeczywistym stagingu ponownie zakończyły się kodem 0.
Kontrola dalszego restartu i hydration pozostaje **NOT VERIFIED**.

Poprawiony fixture zachowuje oddzielnie złożony `session_resource_epoch`,
`request_scope_epoch` oraz liczbowy `session_epoch`. Porównuje status sesji
przez kanoniczny `sessionResourceIdentityFromStatus` i
`sessionResourceIdentitiesEqual`. Bramka nowego właściciela nadal wymaga
nowej sesji i liczbowego epoch 1. Surowy status wymaga publicznego `false`,
a status typowanego klienta jawnie oczekuje zweryfikowanego prywatnego `true`.
Lint poprawionego pliku: **PASS, exit 0**; runtime poprawki jeszcze niezaliczony.

Własny frontend 107220 został odebrany (`waited=true`, exit 1), a kontrola
procesów potwierdziła brak wszystkich PID-ów tej próby. Uruchomiono następny
zarządzany build; log `native-build-39742c0796b6498a9d24453257213330.log`.
Build zakończył się **PASS, exit 0**, snapshot
`db4780df67249edb8313cd306e6ba676d7e53774e099f5920254a665d039821d`.
Backend/API: 41,16 s; desktop: 53,20 s. To czasy kompilacji tego snapshotu,
nie całkowity czas przygotowania buildu.

Review drivera wykrył brak niezależnego sprawdzenia zmiany zakresu żądań
oraz zbyt wczesne uznanie cleanupu za terminalny na podstawie samych API.
Driver odczytuje teraz rzeczywisty status przed i po restarcie, wiąże
`request_scope_epoch` dokładnie z API pin i liczbowym epoch właściciela,
wymaga nowego zakresu oraz nowego złożonego epoch zasobów sesji. Przed
restartem dopuszcza legalny epoch 0; po restarcie nadal wymaga 1.

Cleanup zachowuje również zaległe ramki rozpoczęcia helperów. Przywrócenie
statusu wymaga poprawnego końcowego raportu z nonce, terminalnego transportu
i odebranych wyników wszystkich znanych API/helperów; nieznany helper albo
błąd transportu pozostawia status. Interpretowane regresje: **9/9 PASS**.
Zmiany drivera nie modyfikują działającego frontendu ani pakietu B.

## Próba przyjętego restartu — `a35043be10d745dd9fd13c44da75a63b`

NoEmit i lint stagingu PASS. Ponownie utworzono przez rzeczywiste UI obiekt,
region i przypisany materiał. `Setup draft` zakończył się potwierdzeniem
sceny revision 4 i niezapisanego dokumentu revision 2. Początkowa odmowa
przejęcia była związana z pozostawionym draftem formularza materiału;
wycofano tylko niezastosowany formularz, bez mutowania zapisanej sceny.
Ponowiona akcja restartu została przyjęta, a kernel przeszedł w `paused=true`.

Właściciel nie uzyskał potwierdzenia commit: odpowiedź prywatnego kanału
zawierała `reason`, a konsument oczekiwał ACK commit. Źródło ogólnej odmowy:
`PreparedOwnerControl::reject`; dokładny warunek odmowy pozostaje w diagnozie.
API A nie potwierdziło graceful exit. Native wynik: **UNKNOWN**, API B nie
powstało. CLI 5844 zakończył się kodem 1. Raport natywny odebrał helpery
74888, 85012 i 66676 z kodem 0, lecz nie odebrał kodu API A 52088.

Po sprawdzeniu PID, rodzica 5844 i dokładnej ścieżki EXE własnego bundle A
zakończono wyłącznie API testowe 52088. Zewnętrzny obserwator odebrał kod
`-1`; dowód zapisano jako `external-api-cleanup.json` w katalogu tej próby.
Nie przepisano tego kodu do raportu natywnego. Driver zachował diagnostyczny
status z niepotwierdzonym outcome; nie przywraca go na podstawie samego
zewnętrznego cleanupu. Własny frontend 59420 został odebrany z kodem 1.

Driver rozróżnia teraz poprawny raport `unknown` od błędnej ramki: zachowuje
terminalne helpery, ale nie tworzy kodu zakończenia API. Regresje nadal
**9/9 PASS**. Pełny restart, hydration i publiczna gotowość: **NOT VERIFIED**.
Obraz chronionego workspace: `fullmag-native-restart-commit-pending.png`.

## Wyjaśnienie odmowy przy niezastosowanym formularzu

Lokalny commit `87deab6b6e2332b912e7e521e5b65df6e3df1ed7` rozróżnia
potwierdzoną odmowę z powodu zmian Inspectora od pozostałych błędów capture.
UI wskazuje teraz konieczność Apply/Revert, nadal bez wysyłania restartu.
Niepotwierdzony cleanup nadal chroni workspace i nie pokazuje instrukcji,
która sugerowałaby możliwość bezpiecznego ponowienia.

Kontroler: 43 scenariusze PASS, receipt `135aaac1dfe841de86c64a9c5bd5aa21`.
Akcja: 25 scenariuszy PASS, receipt `67e0d9c5470545f9b26c7ca2a275cadb`.
Pierwsza próba testu akcji wykazała nieaktualny loader; podpięto rzeczywisty
`DevelopmentBackendBuildActionService`, bez zastąpienia go stubem.
Lint PASS, receipt `f3606ab3aba14f4dab07e4649efbc79b`. Kontrole są
interpretowane, bez emisji kodu; nie stanowią nowego dowodu browser/native.

Odrębna diagnoza wykazała fałszywy dirty draft po domyślnym Create and assign:
zamknięcie starego `baseDraft/baseKey` pozostawia puste parametry, gdy nowy
materiał ma już wartości zatwierdzone w API. Poprawka ma przestawić tylko
niezmienione pola na zatwierdzoną bazę i zachować rzeczywiste edycje oraz
odroczony Ku1. Nie wolno zastąpić jej wyzerowaniem samego bitu dirty.

Kontrola store ostatniej próby: `HANDOFF-COMMIT.json` nie istnieje,
`ADMISSION-FENCE.json` pozostaje. API bundle A ma identyczne źródła
`development_owner_control.rs` i `development_handoff_validation.rs` jak
checkout; nie potwierdzono hipotezy niezgodnego kształtu starego protokołu.
Nie odtwarzano commit ani nie usuwano fence. Trwa przygotowanie ograniczonej
diagnostyki prywatnych faz commit, bez zmiany ogólnej odpowiedzi odmowy,
autoryzacji ani timeoutów.

Diagnostyka źródłowa jest przygotowana w `development_owner_control.rs`:
flag `FULLMAG_DEVELOPMENT_OWNER_PROBE=1`, najwyżej 8 statycznych wpisów
`commit_request_shape`, `validate_cold_commit`, `hold_deadline`, `accept_handoff`.
Nie zapisuje pól żądania ani łańcuchów błędów; parse/auth nadal są ogólne.
Jeszcze nie wykonano buildu tej zmiany ani próby runtime.

Browser probe zapisuje stderr API bezpośrednio do
`state/browser-workspace-api-<uuid>.log`, a nie do logu `owner-probe` innej
ścieżki diagnostycznej. W próbie `a35043be10d745dd9fd13c44da75a63b` log to
`workspace-browser-fixture/state/browser-workspace-api-f901fc3e2e35424aa1f5fac5fb88022a.log`.
Ostatnia scena była niekompletna obliczeniowo (brak magnetization asset),
co jest legalnym authoringiem; nie dowodzi to przyczyny odmowy commit.
Następna kontrola musi rozstrzygnąć konkretną fazę odmowy i zachować wymaganie
restartu niekompletnego modelu, bez zastępowania go gotową symulacją.

## Kolejny checkpoint — baza formularza materiału

Poprawka odbudowuje bazę formularza z zatwierdzonej sceny przypisania,
zachowując wcześniejsze i wykonane w trakcie żądania edycje. Nie zeruje
samego znacznika dirty. Interpretowana kontrola obejmuje 14 scenariuszy,
w tym puste pole wobec jawnego zera, odroczony Ku1 i spóźnione zasoby.

- Production TypeScript noEmit: PASS, receipt
  `a0b4b0acba424ca9b7a0ce1e30a08685`.
- Zarządzana kontrola akcji restartu (25 scenariuszy) i formularza materiału
  (14 scenariuszy): PASS, receipt `aefd2bbe1c034274a1d251aed35f80f7`.
  Sandbox zablokował pierwsze uruchomienie Git Bash przed wykonaniem kontroli;
  ponowienie tej samej recepty poza sandboxem zakończyło się exit 0.
- Rozpoczęto natywny build diagnostyki: log
  `native-build-213ad9abf8e844aeaec63bd91ea11fe8.log`.
  Wynik buildu i kolejny dowód browser/native pozostają do potwierdzenia.

Te kontrole źródłowe nie zamykają bramki P8-53AY ani nie włączają
publicznej dostępności restartu.

Review tego checkpointu wykazał dodatkową lukę: nowsza rewizja obiektu
mogła zwolnić bazę ACK, mimo że osobny hook materiału nadal zawierał
poprzednie dane. Dotychczasowy scenariusz nowszej rewizji podawał już
aktualny materiał i nie dowodził poprawności tej kolejności. Poprawka
wymaga bazy materiału z tej samej zatwierdzonej sceny albo potwierdzonej
świeżości hooka; przed tym nie wolno commitować fragmentu jako zamkniętego.
Rozpoczęty build jest przypięty do wcześniejszego snapshotu
`a22a94b0359048299b5e0cff7961c864120c686cdbf0e0fcde3a94c2085026e5`;
kolejna poprawka należy do następnego buildu.

Build snapshotu `a22a94...` zakończył się **PASS, exit 0**: backend/API
3m39s, desktop 1m14s. Manifest SHA-256:
`130ee72ed80cfe0e01fae0fa26e192abe83d8d4ac23d2d9882b9619719ef4b8b`.
Backend source SHA-256:
`f776084c0a68d170f29847fa0340c21242de6b1231fa812d94ffac0c6ba16abd`.
Manifest potwierdza TEMP na R:, trwałe źródła kompilatora i cache na C:.
Nie restartowano workspace użytkownika. Ten pakiet obejmuje statyczne fazy
diagnostyczne API oraz metadane jego logu w browser probe, lecz nie obejmuje
następnych poprawek formularza ani rozpoznawania ogólnej odmowy w CLI.

Dotychczasowa domyślna kontrola API wymaga bieżącego fingerprint checkoutu
i nie może kwalifikować pakietu A po edycjach przygotowujących B. Powstaje
jawna trasa `verify-windows-frozen-development-backend-api <manifest-sha256>`:
weryfikacja pełnego manifestu, snapshotu i binariów pozostaje obowiązkowa;
kontrola dotyczy przypiętego pakietu, nie aktualnego checkoutu. Domyślna
trasa zachowuje swój wymóg zgodności z checkoutem.

Finalna poprawka formularza używa materiału z tej samej SceneResource,
utrzymuje bazę ACK dla starszej sceny i odrzuca ją przy potwierdzonym
konflikcie w tej samej lub nowszej rewizji. Przeszło 16 scenariuszy
formularza i 25 akcji restartu: receipt `f74c50481e3844f592b34a7d8e9a3643`.
Production noEmit PASS: `6c67091ec8994f46a90547730a385728`.
Poprzedni receipt `4949a4a6d2f54678b834361a4930fc83` zawiera exit 0
kompilatora, lecz failed z powodu zmiany źródeł w trakcie kontroli;
nie jest zaliczony jako zielona bramka. Lokalny commit fragmentu:
`b16d00ee4273aa4884209dc670fb0e14bc1a5e9e`.
Browser/native restart nadal NOT VERIFIED, bez podniesienia procentu P8.

Dodano jawną bramkę przypiętego pakietu. Parametr
`--frozen-native-build-id` odrzuca nieprawidłowe SHA oraz wszystkie dziewięć
innych trybów przed resolverem; domyślna kontrola serwisowa nadal działa,
a initial/final preflight wymaga tego samego manifestu i zweryfikowanego
snapshotu. Receipt rozdziela źródła pakietu od bieżącego checkoutu.
Interpretowana regresja tej granicy oraz browser-driver: 11/11 PASS.

Uruchomiono rzeczywistą zarządzaną kontrolę manifestu `130ee72e...` przez
`just verify-windows-frozen-development-backend-api`. Uchwyt wykonania
`29148` nadal był aktywny podczas ostatniego odczytu; wynik terminalny
jest do odebrania przed kolejnym buildem. Nie uruchomiono B ani nie
restartowano workspace użytkownika. W CLI przygotowano ścisłe rozpoznanie
ogólnej odmowy commit; nadal klasyfikuje wynik jako unknown i wymaga
durable reconciliation, bez retry lub zwolnienia fence. Ta zmiana czeka
na build B i jego runtime gate.

## Wynik pierwszej kontroli przypiętego A

Receipt `c81db3d375754acc92810fbbc249f9f8`: **FAILED**, 95 sprawdzeń
zakończonych przed kontrolą resident service. Pierwotny błąd to chwilowy
Windows `PermissionError` odczytu `OWNER.json` podczas publikacji; cleanup
timeout 20s zasłonił go, bo lokalny owner nie został jeszcze odczytany.
Nie jest to dowód zawieszonego solvera ani zaliczona bramka pakietu.
Usługa 50492 została później potwierdzona po EXE, config i dzieciach
84996/105176. Jawne owner-authenticated drain zwróciło `draining`;
wszystkie trzy procesy rzeczywiście zakończyły się exit 0 i zostały
zaobserwowane przez zachowane uchwyty Windows. Historyczny receipt pozostaje
failed/unknown; osobny `external-service-cleanup.json` opisuje tę późniejszą
czynność. Poprawka weryfikatora ma ponawiać wyłącznie przejściowy odczyt
w istniejącym deadline i zachować pierwotną diagnozę. Nie podnosi timeoutów.

Poprawka wykonana: `_wait_for_owned_service_ready` ponawia wyłącznie brak
pliku i przejściowy błąd dostępu w istniejącym 20s deadline. Nie ponawia
malformed JSON, obcego PID ani niewłaściwej tożsamości buildu. Odrębny
wait terminalny zapisuje cleanup timeout bez zastąpienia pierwotnego wyjątku
i bez wymyślania exit code. Regresje drivera i tych granic: **17/17 PASS**.
Ponowiono tę samą zarządzaną kontrolę manifestu A; wynik nadal oczekuje
potwierdzenia runtime. Nie zmieniono protokołu produktu ani deadline.
Aktualny uchwyt ponowienia: `31522`, aktywny przy ostatnim odczycie.
Kontynuacja ma odebrać ten wynik; nie uruchamiać równoległej kontroli
ani buildu B przed ustaleniem stanu procesów i receipt tej próby.

## Ponowienie A i rozpoczęcie B — 06.10.2026

Receipt `8c97451737c145a09fd4ca76a84c7738`: **FAILED**, 98 sprawdzeń.
Odczyt Ready przeszedł, resident service zakończył się exit 0. Wykryto
rzeczywistą odmowę cold commit w native CLI owner probe; statyczna
diagnostyka API wskazuje `validate_cold_commit` (sześć celowo nielegalnych
żądań oraz końcowa próba). Nie zastąpiono tego wyniku zielonym statusem.

Powstał zweryfikowany integralnościowo bundle A:
`ca0a9b6b52bf427cbb65fd84e7da99cc`. Samo jego utworzenie nie kwalifikuje
restartu. Scope testowego store: `fb024769-2ac3-4841-bde4-10e56fe0efa0`;
`HANDOFF-COMMIT.json` nie istnieje, `ADMISSION-FENCE.json` pozostaje.
API 83072, parent 90412, zostało potwierdzone po procesie i EXE, następnie
zamknięte; zachowany uchwyt Windows potwierdził exit -1. Historyczny
receipt zachowuje unknown; późniejsza czynność ma osobny
`external-api-cleanup.json`. Nie replayowano commit ani nie zwalniano fence.

Odczytowa diagnoza produkcyjnym walidatorem Python potwierdziła dwie
ostatnie kapsuły jednoznacznie zawierające ścieżkę tej próby:
`94ad8017-6419-4a57-a8e4-8dbbd0fb5cc7` i
`04d66310-1d81-4795-9b42-0b0a4ed09854`; obie PASS, jeden asset.
Nie dowodzi to poprawności porównania z aktualnym workspace w API,
deadline ani walidacji candidate bundle.

Przygotowano whitelist statycznych faz walidacji w API: workspace binding,
store location/admission, snapshot binding, capsule semantics, candidate
bundle i deadline. Publiczna odmowa, autoryzacja i limity pozostają bez
zmian. Rustfmt z edycją 2021 sparsował zmienione moduły; całoplikowy check
ma exit 1 z powodu wcześniejszych różnic formatowania owner control poza
nowymi liniami. Nie sformatowano tych niezwiązanych fragmentów.

Rozpoczęto B przez `just windows-backend-dev 3197`: log
`native-build-1825578b61ba41da9b101ceae4dfd6b1.log`, uchwyt `68432`.
Najpierw odebrać ten wynik i manifest, potem przejść do owned A→B browser
proof z bundle A wskazanym wyżej. Publiczny restart i P8-53AY nadal
**NOT VERIFIED**; nie zwiększono procentu wykonania planu.

Build B utrwalił snapshot record
`9ab402abb1cb4e98fe58e8612db58360d6cedeb4355592957b804ced1738edfc`.
Git source snapshot SHA zaczyna się od `4862d7e4be1e`; to odrębne pole
od identyfikatora record. Launcher potwierdził, że dalsze edycje checkoutu
nie odrzucają tego buildu. TEMP nadal na R:, source mirror i target na C:.
Uchwyt `68432` pozostaje do odebrania, bez drugiego równoległego buildu.

Uwaga dotycząca kolejności dowodu: cold commit waliduje uruchomione stare
API, a nie API candidate. Bundle A `ca0a9b6b...` zawiera wcześniejszą,
ogólną diagnostykę. Po buildzie B należy najpierw uruchomić przypiętą
kontrolę native owner z API B, aby odczytać szczegółową fazę odmowy.
Dopiero poprawne, zweryfikowane API może zostać punktem startowym pełnej
próby browser A→B. Sam nowszy CLI nie zmienia walidacji starego API.

Build B **PASS, exit 0**: backend/API 3m31s, desktop 1m47s. Manifest:
`dc0f4b3f4b6b78cf449e5743733387f943d0af7f72b763f6721a63547ca3e46d`.
Backend source: `8ea329b915fb1d0ffbce0d9b3f7cf4208cd36351c72db67547d5ebcdaf573ba6`.
Git source snapshot: `4862d7e4be1e04fbac22d147402e03ce62dedf61f8928f504716710f03d41979`.
HEAD snapshotu: `1bdb48274050e66aabcb490b52873c5b9cc02f98`.
Uruchomiono zarządzaną kontrolę tego manifestu z API B; wynik runtime
pozostaje do odebrania. P8-53AY i publiczna dostępność restartu nadal
NOT VERIFIED. Nie uruchomiono ani nie zastąpiono workspace użytkownika.

## Przyczyna odmowy i poprawka parsera manifestu

Kontrola B: receipt `2f46799a3770420e840b5c5dc5097a1e`, FAILED po
98 sprawdzeniach. Ostatnie poprawne żądanie ma statyczną fazę
`candidate_bundle`. Bundle tej próby:
`e1ce25d3f5e9473fa4fc6348bcc61562`.

Potwierdzona niezgodność: publisher `runtime_bundle.create_bundle` dodaje
`source.build_source_snapshot`, a `RuntimeBundleSource` w API z
`deny_unknown_fields` nie deklarował tego pola. Każdy taki poprawnie
opublikowany manifest był zatem odrzucany przez ścisły parser. Nie jest
to problem semantycznej kapsuły ani powód podniesienia timeoutu.

Poprawka deklaruje opcjonalny, jawnie typowany `RuntimeBuildSourceSnapshot`
z dokładnie trzema polami publishera. Omission zachowuje zgodność ze
starszymi manifestami; jawny null i dodatkowe pola nadal są odrzucane.
Digest inventory musi mieć poprawny SHA-256, record/source muszą mieć
spójne absolutne lokalizacje bez parent traversal. Te metadane nie są
otwierane ani używane do wyboru EXE. Hash całego manifestu, fixed allowlist
binarny, hashe każdego EXE i dotychczasowe limity nadal obowiązują.

Interpretowana regresja porównuje rzeczywiste pola publishera Python i
zamkniętych typów Rust; wykrywa ten błąd w poprzednim HEAD. Łącznie
driver/source checks: 18/18 PASS. Nie jest to wykonywanie parsera Rust.
Rustfmt zmienionego modułu: PASS z edycją 2021. Wymagany jest nadal
rzeczywisty native owner gate z poprawionym API.

Testowe API 50900, parent 6548, zostało potwierdzone po procesie i EXE
i zamknięte; rzeczywisty exit -1 zapisano osobno w
`external-api-cleanup.json`. Historyczny receipt pozostaje failed/unknown;
nie replayowano commit ani nie zwalniano fence.

Rozpoczęto build C przez tę samą zarządzaną receptę: uchwyt `52974`, log
`native-build-df3b99d69bef41c8a306a6bb87e1a92f.log`. Początkowa blokada
storage została zwolniona i rozpoczęło się utrwalanie źródeł. Odbierać ten
sam uchwyt, bez równoległego buildu. Następnie sprawdzić cold commit na API
C; punkt startowy przyszłej próby browser musi zawierać tę poprawkę.

Build C **PASS, exit 0**: backend/API 3m18s, desktop 1m11s. Manifest:
`a4d33b81661177cbda92f32134f86ba34f4a00f4b1cd5248a65465fd775e9c44`.
Backend source: `8ac24194bcc794b20d5074ba6cfc4a4df4dcd16a3c1920c55307d3f5e109d3fb`.
Git source snapshot: `347ae4761cdcf2baaa1f369d87dd0d0725ce3c77211ee92a6abee1ab0c733650`.
Uruchomiono rzeczywistą przypiętą kontrolę tego pakietu; wynik runtime
pozostaje do odebrania.

Przygotowano powiązany następny przyrost po stronie publishera/preflightu
Python: walidacja `build_source_snapshot` rozróżnia brak od jawnego null,
odrzuca dodatkowe pola, błędne hashe i niespójne lokalizacje, bez otwierania
ścieżek z samych metadanych. Dotychczasowa głęboka weryfikacja snapshotu
przy tworzeniu pakietu nadal obowiązuje. Dzięki temu malformed metadata
nie jest deklarowana jako gotowy candidate tylko po to, by odmówiło API.
Interpretowane kontrole runtime bundle: 19/19 PASS. Kontrole drivera i
zgodności pól: 18/18 PASS. Pierwsza próba fixture w sandboxie była
zablokowana na rename; następnie poprawiono wyłącznie zapis celowo
uszkadzanej read-only fixture i otrzymano wynik zielony poza sandboxem.
Ta zmiana Python jest poza snapshotem C i należy do następnego pakietu.

## Natywna bramka po poprawce — PASS

Receipt `fab9fb906f4b49acaf139b54c3a6177b`: **completed, exit 0**,
287 sprawdzeń, 97 procesów z potwierdzonym `waited`, zero niepotwierdzonych.
Legalny cold commit zwrócił ACK, durable reconciliation potwierdziła zapis,
API zakończyło się łagodnie. Przeszły też lost-ACK i native replacement.
Pozostałe testy nadal odrzucają celowo nielegalne scope/manifesty.
Nie jest to dowód UI hydration, walidacji fizyki ani kwalifikacji wydania.

Poprawny bundle punktu startowego kolejnej próby:
`efc0a57a5be44d8894eee537d9b86298` (API C z poprawką parsera).
Nie używać wcześniejszych A/B do walidacji commit nowych snapshotów.

Regresję zgodności pól publishera i parsera przeniesiono do istniejącego
`test_windows_runtime_bundle.py`, aby spójny commit nie wymagał przyszłego
browser drivera. Finalny zestaw bundle: **20/20 PASS**; driver: **17/17 PASS**.
Lokalny commit pięciu plików: `fix(runtime): accept frozen bundle metadata
with closed schemas` (`c58ff5026facd10830113c329bf9929489ebdf1c`).

Rozpoczęto następny natywny build D z rzeczywistą zmianą Python preflightu
(null/nieprawidłowe frozen metadata odrzucane przed commit), nie ze zmianą
samych znaczników wersji. Uchwyt `5820`, log
`native-build-acc0c52a03ae467ab09f5922fefc2874.log`.
Po odbiorze D uruchomić owned browser proof z bundle C wskazanym wyżej.
Cały P8-53AY nadal NOT VERIFIED do browserowej kontroli modelu, dirty
document, nowych scope i WebGL; procentów planu nie podniesiono.

## Browser C→D — rzeczywisty model, wynik FAILED

Build D: **PASS, exit 0** (backend/API 1m49s, desktop 57,30s).
Manifest `e5d8a135567436dcbaab881af770e92afa5c702a0f8040df603838177e82d73c`;
backend source `53be560b639fb740733166c9aa835101896c27aa31f15129b3bfa2d976a22adc`,
git source snapshot `63ee6b1e0c5deecd894906438cc8544934548a076ed451489ebb130673959daa`.
Fingerprint źródeł różni się od C; nie zastosowano sztucznej zmiany znaczników buildu.

Receipt `2b689683d4df437997efd17844936461`: **FAILED**, nie potwierdzono
końcowego browser hydration. Karta IAB 10, własny port 3258, własny scope
`ff74ff40-deba-4e18-af5c-2c1a070125d0`. Przez zwykłe UI utworzono pustą
symulację, Thin Film, region `Restart region` i materiał `mat:new-thin-film`.
Po Create and assign Apply Inspector pozostał disabled: poprawka fałszywego
dirty została zaobserwowana również w przeglądarce. Nie wykonywano Revert.
Model pozostał nieprzygotowany obliczeniowo (mesh stale, brak symulacji).

Przed restartem: scena revision 4, 1 object/region/material,
object ID `new-thin-film-muvvtl4p`, region ID `new-thin-film-muvvtl4p:r1`.
Project document `project-c686724c3c6741c0bb0fa4feaf6435a5`, revision 2,
dirty true; archive hash
`7d6eaec3e720211e4be33a9eb5f3aa0006ea5bcd652b2af39772059820cbd3e1`.
Canvas widoczny, contextLost false, drawing buffer 532×281.
Screenshot: `fullmag-native-cd-before.jpg` w katalogu visualizations zadania.

Normalna akcja Restart backend wysłała intent bez capture refusal. Stare
API 67348/pin `f2a5cd86-e437-49ca-b089-6360d547d5d4` zakończyło się exit 0,
durable commit reconciled true. Nowe API 36092/pin
`061e03df-caa7-4964-a5fc-52988b95df7c` uruchomiono na tym samym porcie 55276.
Frame `fullmag.development-browser-native-restored.v1` został odebrany.

Ostatni dostępny DOM pozostał generation 0, paused true, z nienaruszonym
dirty document i sceną. Następnie CDP przestało odpowiadać; nie odświeżono
karty ani nie wysłano drugiego restartu. Po timeout 600s harness zakończył
próbę: stare API exit 0, nowe API exit 1 (własne zakończenie fixture),
7 helpers exit 0, CLI exit 1, Next exit 1. Wszystkie 13 zapisanych procesów
native/source zostały waited. Source typecheck/lint exit 0.

Próba zamknięcia własnej karty została zablokowana przez Browser Use URL
policy po przejściu na `data:` error page; ograniczenia nie obchodzono.
Error page zawierała failed URL z **nowym** pinem API. Odczyt kodu
`KernelProvider` potwierdził, że URL zmienia efekt `host.confirmMounted`
przez `history.replaceState`, po publikacji nowego kernela; nie jest to
pełna nawigacja strony. Ostatni DOM generation 0 poprzedzał tę zmianę.
URL nie dowodzi zachowania dokumentu po odtworzeniu.

Diagnoza strony testowej: wrapper statusu oczekuje na prywatne eligibility
również dla nowego API. Po native restore bridge celowo wycofuje eligibility
starego procesu. Taka zależność jest zbędna dla replacement status i może
blokować jego odczyt, jeśli prywatne żądanie nie odpowiada. W zapisanej próbie
409 wracało szybko, więc sam ten defekt nie dowodzi przyczyny timeoutu CDP.
Korekta powinna przepuszczać niezmieniony status nowego, jawnego API pin
po capture; wymagania produkcyjnej walidacji pin/session pozostają bez zmian.

## Korekta post-restore strony testowej, 06.10.2026

Wrapper przepuszcza odpowiedź 200 z niepustym pinem różnym od zapisanego
baseline przed parsowaniem JSON i pobraniem eligibility. Stary pin, brak
baseline i brak nagłówka nadal przechodzą dotychczasową walidację. Nie zmieniono
produkcyjnych zasobów, bridge ani warunków zakończenia dowodu.
Interpretowana regresja `check-native-workspace-restart-pin-overlay.mjs`
wykonuje rzeczywistą klasę fixture i resolver żądań: **4/4 PASS**, w tym
nowy pin z nigdy niekończącym się prywatnym fetch. Przed korektą ten przypadek
nie przechodził. ESLint obu plików z `--max-warnings=0`: PASS.
Driver Python: **17/17 PASS**. Ponowna próba używa istniejącego bundle C
`efc0a57a5be44d8894eee537d9b86298` i niezmienionego manifestu D `e5d8a135...`.

## Ponowny browser C→D — PASS, 06.10.2026

Managed recipe `just verify-windows-development-workspace-browser efc0a57a5be44d8894eee537d9b86298`:
**completed, exit 0**, receipt `6379d58c5ac14c9b8c956bd775c3e9cc`, 7 kontroli.
Przez zwykłe UI utworzono symulację FDM, Thin Film, region `Restart region`
i materiał `mat:new-thin-film`. Nie użyto solvera ani meshera. Po assignment
Apply Inspector pozostał disabled, bez Revert. Następnie Setup draft,
Restart backend i Check restart odtworzyły kernel; Finish proof zakończył
walidację bez reload ani ponownego wysłania intentu restartu.

| Własność | Przed | Po |
|---|---|---|
| API pin | `ee99ced4-bba0-4403-b35f-6b44e47b0083` | `11e41874-b454-494c-8b4a-546ae9ac91be` |
| API PID | 111440 | 57148 |
| Session ID | `session-18dbc7f018c28c640001b350` | `session-18dbc811392471680000df3c` |
| Numeric session epoch | 1 | 1 |
| Composite session epoch | `session-18dbc7f018c28c640001b350@1791245110831` | `session-18dbc811392471680000df3c@1791245253108` |
| Request scope | `ee99ced4-bba0-4403-b35f-6b44e47b0083:1` | `11e41874-b454-494c-8b4a-546ae9ac91be:1` |
| Kernel generation / paused | 0 / false | 1 / false |
| Project document | `project-f46b8b87b55a4feab1f77abe2c9fce1f`, revision 2, dirty true | identyczny |
| Document archive SHA-256 | `b2b958e4ae3e446368acc92531d3d884fd90ea01596b4694d7d3ca31736bba4c` | identyczny |
| Document scene SHA-256 | `fa21597a89161d300b092660b0c4584f6d63bfdbe7a1f2e9afcab80d2e2e4ccc` | identyczny |
| Obiekt / region / materiał | 1 / 1 / 1 | identyczne ID i treść |
| WebGL | visible, contextLost false, 662×281 | visible, contextLost false, 700×304 |

Nowy session scope nie jest wnioskowany ze zmiany numeric epoch: oba procesy
mają epoch 1, ale API pin, SessionId i composite epoch są nowe. Scene ID
pozostał częścią odtworzonego modelu, nie tożsamością nowego runtime.
Object ID: `new-thin-film-muvx4aa5`; region ID: `new-thin-film-muvx4aa5:r1`.

Odebrano wszystkie 13 zapisanych procesów: initializer, CLI, noEmit, lint,
stare API i 7 helpers exit 0; nowe API exit 1 w kontrolowanym teardown własnej
fixture. Next również waited, exit 1 w teardown. Receipt rozdziela ten stan
od funkcjonalnego wyniku odtworzenia. Własna karta 11 została zamknięta.
Screenshots: `fullmag-native-oct6-before.jpg` i
`fullmag-native-oct6-restored.jpg` w katalogu visualizations zadania.
Parametry WebGL w tabeli odczytano z diagnostycznego DOM przez CUA podczas
próby; screenshot odtworzonego UI został obejrzany. Sam receipt zawiera
Finish document/identity/scene i custody, ale nie zapisuje parametrów canvas.
Dlatego dowód WebGL wymaga również tych obserwacji przeglądarkowych.

To dowód jednego niepustego, idle FDM workspace i dokładnego zachowania
otwartego dirty document. Nie dowodzi restartu podczas symulacji, wszystkich
rodzajów szkiców ani publicznej gotowości P8-53. Pozostałe bramki P8-53
i cutover/release nadal obowiązują; publicznego restartu nie włączono.

## Review dowodu

**Uzupełnienie z P8-53AZ, 06.10.2026:** odczyt rzeczywistej staged route
wykazał, że receipt `6379d58c...` używał strony diagnostycznej z zamrożonego D.
Późniejsze zmiany overlayu i linked-scene guard w checkoutcie nie były więc
wykonane przez tę próbę. PASS pozostaje dowodem odtworzenia rzeczywistego
modelu i dokumentu w produkcyjnych źródłach D; nie jest runtime dowodem tych
zmian strony diagnostycznej. Driver został poprawiony w
[P8-53AZ](53az-native-browser-inspector-draft-guard.md), z oddzielnym snapshotem
i hashem bieżącej strony testowej. Historycznego receiptu nie zmieniono.

Read-only review wszystkich linii natywnego probe oraz dwóch hunksów
mod/dispatch w `control_room.rs`: brak wymaganych poprawek. Potwierdzono
łańcuch manifest/bundle/EXE→owner PID/API, bounded input i TTL, brak sukcesu
przy unknown oraz cleanup ograniczony do własnych, potwierdzonych procesów.

Read-only review drivera Python, jego 17 regresji i scoped diff głównego
verifiera: brak usterek blokujących. Review fixture wskazało zbyt słabą
kontrolę powiązań authoring: globalne liczniki dopuszczały geometrię, region
i materiał należące do różnych obiektów. Podsumowanie zachowuje teraz
`material_ref`; guard wymaga jednego obiektu z geometrią, regionem i
referencją do istniejącego materiału. Interpretowana regresja rzeczywistych
funkcji (`check-native-workspace-scene-evidence.mjs`): 3/3 PASS, z przypadkiem
rozłączonych liczników i dangling material reference. Lint fixture i obu
skryptów Node: PASS.

Ta korekta nastąpiła po próbie runtime. Udokumentowany model próby miał
jedną geometrię, przypisany materiał i region tego samego obiektu;
historycznego receiptu nie zmieniono. Parametry WebGL pozostają dodatkowym
dowodem z przeglądarki, nie składnikiem receiptu Python.

Odrzucono sugestię porównania `current_build.id` z digestem gotowego
manifestu: kontrakt ID jest opaque, a bieżący proces raportuje wersję
produktu. Tożsamość pakietu D wynika z niezależnej walidacji manifestu,
bundle i hashy EXE oraz owner-bound PID/API w natywnym przebiegu, nie z
samego hash źródeł wyświetlanego przez frontend.

Następna bramka P8-53: rzeczywista odmowa restartu przy lokalnym szkicu
Inspectora, zachowanie szkicu i modelu przy odmowie, a następnie poprawne
Apply/Cancel przed kontrolowanym restartem. Publicznego restartu nie włączono;
procentów wykonania całego planu nie zmieniono.
