# P8-53BQ — spójne raportowanie interakcji obiektu i agregatu

Status: **IN PROGRESS**, 14.10.2026. Poprawka opisu w Explorerze, bez
zmiany fizyki, Python DSL, ProblemIR, publicznego API ani solvera.
Baza lokalnego mastera: `50929f025798eed85f69b98fc63c01bec8ae3877`.
Ten przyrost domyka odrębne P2 zapisane w P8-53BN; nie zastępuje kwalifikacji
lane’ów ani integracji i wydania P8.

## Dowód przyczyny

`sceneModelTreeAdapter.ts` używał samej obecności kluczy materiału Dind/Dbulk
jako aktywacji. Agregat analizował surowy physics_stack osobno od obiektu,
zliczał duplikaty oraz nieznane rodzaje, a pomijał inferencję materiału.
Python `scene_document.py::_ensure_physics_stack` oraz
`script_builder.py::_ensure_geometry_physics_stack` używają ostatniego
znanego wpisu, przycinają rodzaj i wnioskują DMI wyłącznie z niezerowej
wartości kanonicznego klucza, jeżeli nie istnieje jawny wpis tego rodzaju.
Jawna zadana interakcja z parametrem zero pozostaje jawną interakcją.
Study global false ma pierwszeństwo dla exchange/demag.

Wykonywalny baseline RED:
`just verify-control-room-explorer-physics`, receipt
`b3c0908381234927b1cf9e915332650a`, exit 1.
Odczyt rzeczywistego adaptera dla materiału z Dind=null zwrócił
interfacial_dmi enabledCount=1 / objectCount=1 zamiast braku interakcji.
To naruszenie danych wejściowych, nie problem ładowania fixture.

## Mechanizm kontroli

`check-explorer-physics-reporting.mjs` wykonuje produkcyjny adapter oraz
cztery rzeczywiste zależności w stałej mapie VM, po natywnym usunięciu
adnotacji typów w pamięci. Nie mockuje normalizacji, nie uruchamia tsc,
nie emituje bundla, nie instaluje zależności i nie wykonuje solvera.
Stała recepta i route są objęte dokładnym preflightem, resolverem,
profilem windows-control-room-source-check, lockiem i terminalnym receiptem.
Przyszłe CI wykonuje driver przed istniejącym typecheckiem.

30 scenariuszy kontroluje zero/missing/null/niepoprawne i niezerowe
wartości DMI, dodatni i ujemny znak, tekstowe skalary, kanoniczną wielkość
liter klucza, jawny enabled/disabled mimo wartości materiału, kolejność
duplikatów, trim, unknown kind, liczenie kilku obiektów, globalne wyłączenie,
nonmagnetic role i niezmienność wejściowej sceny. Źródła unit regresji
pozostają NOT RUN przy obecnym zakazie ich kompilowania.

## Granice odbioru

Końcowy GREEN, produkcyjny source check i review są wymagane przed commitem
tego przyrostu. Rzeczywista przeglądarka na nowym frontendzie oraz integracja
pozostają NOT VERIFIED. Poprzedni pakiet cb9c2825 i jego PASS potwierdzają
starsze poprawki BN/BO; nie są dowodem późniejszej normalizacji DMI.
Nie podnosić procentu całego P8 na podstawie samego drivera.

## GREEN i produkcyjne źródła

Receipt `5933df1d2b44425dbf9b83214d1989a0`: **PASS / exit 0 / 30 przypadków**.
Załadowano produkcyjny adapter i rzeczywiste zależności; driver nie emitował
kodu ani nie wykonywał solvera. Source digest before=after:
`30705734bb9c3179b5f25073481c4fe4806c0f1a3d29cf9e48cd311314136386`.
Po review drivera kontrola niemutowania używa structuredClone i deepStrictEqual,
więc zachowuje NaN, -0 oraz pola undefined. Oddzielny przypadek sprawdza
jawne lokalne enabled=true mimo globalnego exchange/demag=false.

Production source receipt `b937e264f1a14f52be06966f69441d16`:
**PASS / exit 0**, z wyłączeniem źródeł testów jednostkowych.
Bash parsery, Python AST i scoped diff check PASS. Dwie unit regresje
oraz rozszerzenie niemagnetycznych ról w buildModelTree.test.ts dodano,
ale nie kompilowano ani nie wykonywano ich przy obowiązującym zakazie.

Adapter SHA-256:
`8ae4cccb6c03391e370ecc147c153834a71d869c31d3bc9c091072f13007c2c6`.
Driver SHA-256:
`c2e2c2b97261eebd42e7a5a7f07504c543a862021c3b60780dc6ac49c82d586d`.
Implementacja używa prywatnych flag materiału w adapterze; publiczny typ
ModelTreeMaterialSnapshot oraz OpenAPI nie zostały rozszerzone.
Agregat korzysta z rozwiązanego snapshotu, ignoruje role niemagnetyczne
oraz nieznane rodzaje i liczy rodzaj najwyżej raz na snapshot obiektu.
Scena dostarczana przez publiczne API wymaga unikalnych object_id;
kontrola nie kwalifikuje niepoprawnych dokumentów z powielonymi ID.

Browser proof nowej normalizacji, remote CI/merge oraz lane/release
qualification pozostają NOT VERIFIED. Publikacja nadal oczekuje na odpowiedź
użytkownika dotyczącą kompilacji unit testów przez automatyczne CI.
## Korekta po review: identyczne wejście agregatu i drzewa

Bounded review nie znalazł P0/P1, ale wskazał nową niespójność przy
niepoprawnych duplicate raw object.id: drzewo zachowywało dwa snapshoty,
a deduplikacja ID w agregacie liczyła tylko pierwszy. Usunięto tę dodatkową
deduplikację; agregat liczy dokładnie tę samą listę snapshotów co drzewo.
Każdy rodzaj jest nadal rozwiązywany raz wewnątrz snapshotu. Publiczna
walidacja authoring unikalnych ID pozostała bez zmian; nie przedstawiamy
malformed scene jako legalnego wejścia wykonawcy.

Końcowy driver receipt `4ff5cba73f5d446dbf86844749137b1c`:
**PASS / exit 0 / 31 przypadków**. Nowy przypadek zachowuje dwa raw wpisy
z tym samym ID, explicit DMI true/false i wymaga objectCount=2 / enabledCount=1,
co odpowiada faktycznej liście snapshotów. Source digest before=after:
`3c18b069716870df9ac350ccb7da1662399607ce2a5d62cbd80daf15e5ec77bc`.
Końcowy adapter SHA-256:
`b33466686d791c93fd9bd9803fd5c228f809c747fbdb80a3c1ce4f28f610a5eb`.
Końcowy driver SHA-256:
`072f1bb83af8d36b0b6f4bc6d8d720d427130e9f6edff1da0da869dcd225aed5`.
Końcowy production source receipt `a1f721ad479f475085ea9eab61bb4c12`:
**PASS / exit 0**, po korekcie; bez kompilacji unit targets.
Review drivera i korekty agregatu zakończone: brak dalszych P0/P1/P2
w objętym zakresie. Pozostałe granice browser/remote/release pozostają otwarte.
## Checkpoint lokalnego commita i korekta drivera

Przyrost zapisano lokalnie w `c974b2e0654d2348743e44541ce76c7871af3d78`.
Pre-commit React Doctor wskazał warning JSON parse/stringify clone wyłącznie
w driverze. Konwersję wyniku zastąpiono structuredClone; daje lokalną
reprezentację obiektu z VM i zachowuje wartości bez JSON-owej utraty danych.
Po tej małej zmianie końcowy driver receipt
`392b3c8fdf2f4029846db7c9a0bf0bca`: **PASS / exit 0 / 31 przypadków**.
Adapter nie uległ dalszej zmianie; produkcyjny typecheck a1f721ad pozostaje
aktualnym dowodem jego źródeł. Driver SHA-256:
`9f51c860156dd3e8f1aeed31ccb2f2ecdc6bd0da765c809f851431a7f7bd2480`.
Commity pozostają lokalne; nie uruchomiono remote CI ani merge.

## Uzupełnienie dowodu UI

[P8-53BR](53br-explorer-physics-browser-proof.md) potwierdza produkcyjne
renderowanie per-object węzłów, statusów i badge: trzy scenariusze PASS,
receipt `96d56620e5914b2eb596927758850904`, exit 0. Agregaty nadal mają
odrębny dowód drivera 31/31; fixture nie kwalifikuje rzeczywistego API,
runtime, solvera ani wydania. Remote integracja pozostaje niezakończona.
