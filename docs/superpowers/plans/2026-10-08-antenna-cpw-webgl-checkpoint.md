# CPW — wykonana regresja produkcyjnej warstwy WebGL

## Zakres, właściciel i odtwarzanie

Przyrost T04/T15, po commicie modeli/regresji
`8cab4273821d4aea6344371974377cfb963d13a9`, w istniejącym worktree
`D:/git/fullmag/worktrees/microwave-antenna-latest-20260909`, branch
`codex/microwave-antenna-latest-20260909`. PR #147 pozostaje Draft.
To dowód renderowania proceduralnej geometrii anteny, nie nowa fizyka.

Uruchomienie: `just verify-antenna-cpw-viewport-browser`.
Recepta używa istniejącego resolvera oraz
`scripts/verify_pinned_dataset_browser.py::run`, niemutowalnej kopii źródeł
i własnego serwera Next na 127.0.0.1:3260. Nowy wpis w `SCENARIOS` wskazuje
wyłącznie fixture i smoke CPW. Guard w `scripts/just_storage_shell.sh`, gałąź
`scripts/verify_pinned_dataset_browser.py`, akceptuje dokładną parę
`--port 3260 --scenario antenna-cpw-viewport`; nie wykonuje dowolnego recipe text.
Pierwsza próba bez tego wpisu została odrzucona przed startem serwera;
uzupełniono whitelistę, nie obchodzono preflightu.

`apps/control-room/scripts/fixtures/antenna-cpw-viewport-page.tsx::AntennaCpwViewportFixturePage`
montuje prawdziwą `PrimitiveObjectLayer` wewnątrz jednego `Canvas`
z `frameloop="demand"` i `Viewport3DInvalidationProvider`. Kolory pochodzą
z produkcyjnego `useViewport3DColors`, z zachowaniem gate SSR/hydration.
Obwiednie pozycjonowania wyznacza produkcyjny `resolveAntennaPlacement`.
Fixture nie tworzy produktu-route w checkoutcie, własnego API ani solvera.

## Wykonane wyniki

Finalny managed Chrome smoke: **passed/0, 4/4 grupy**, receipt
`721e1bae48fe4445930103c488138c70`, profil
`windows-control-room-browser-fixture/antenna-cpw-viewport-browser`.
Źródła przed/po mają identyczny digest:
`d891facd8d250c4a0c9515619714c1b7f8068f0a60ae2e4825a8204c31890d79`.
`source_changed_during_run=false`, `owned_server_terminal=true`.

`apps/control-room/scripts/smoke-antenna-cpw-viewport.mjs` potwierdza:

- Jeden widoczny canvas, kontekst WebGL niezagubiony, drawing buffer 1000×620.
- Trzy przewodniki CPW z sześcioma stacjami: 72 wierzchołki, 396 indeksów,
  oddzielne ID `signal-custom`, `ground-left-custom`, `ground-right-custom`.
- Położenie całego zespołu nad oraz pod próbką, odstęp world Z 200 nm.
  Po zmianie wymagana jest nowa rzeczywista klatka `useFrame`, nie tylko
  zaktualizowana obwiednia sceny przy starym framebufferze.
- Kolor anteny zgodny z jej centralnym tokenem, różny od próbki i tła.
  Nad próbką: 20 194 złote piksele; pod: 16 715; po odrzuceniu CPW: **0**.
  Odczyt pochodzi z rzeczywistego bufora WebGL, nie deklaracji DOM/modelu.
- Niepoprawna szczelina stacji daje diagnostykę i pozostawia tylko próbkę;
  antena nie zostaje zastąpiona boxem.
- Brak nowych klatek podczas dwóch ustalonych okien idle po 600 ms.
- Trzy cykle unmount/remount produkcyjnej warstwy: liczba śledzonych geometrii
  wynosi odpowiednio **0 → 4** w każdym cyklu, bez utraty kontekstu.
- Brak błędów strony/konsoli. Ostrzeżenie o deprecated `THREE.Clock` pozostaje
  ostrzeżeniem stosu R3F/Three, nie jest ukrywane ani opisane jako warning-free.

Raport `browser/antenna-cpw-viewport.json` zachowuje wyniki invalid i każdego
cyklu oraz cztery screenshoty. Obrazy nad/pod próbką obejrzano: widoczne złote
przewodniki z taperem, jasna próbka i zmiana wzajemnego położenia/zasłaniania.
Wszystkie artefakty znajdują się pod resolverowym storage tego worktree.
Własny serwer zatrzymano; aktywnego workspace użytkownika na 3197 nie zamykano.

`just check-control-room-production-source`: **passed/0**, receipt
`6cccc676f3e94246a2e4b1afd25304c3`, ten sam finalny digest przed/po.
`just lint-control-room-source`: **passed/0**, receipt
`20e5a73e699e486ab2db42f750c03a14`, ten sam digest, źródła niezmienione
w trakcie pełnej kontroli. Bez wyłączenia reguł lub ukrywania ostrzeżeń.
`scripts/check-architecture-hygiene.mjs`: **PASS** z `apps/control-room`.
Testów jednostkowych ani natywnego solvera nie kompilowano.

## Review i ograniczenia dowodu

Niezależny review usunął dwie możliwości pozornego PASS: fallback koloru
anteny do koloru próbki oraz odczyt starego framebufferu po zmianie sceny.
Po wzmocnieniu asercji reviewer nie znalazł nowych Required/Blocker w tym zakresie.

Pełny ESLint ujawnił modyfikowanie refa przekazanego jako prop do licznika
klatek (`react-hooks/immutability`, receipt `a37ecfe00745454082ac637ab23ffd52`).
Zapis przeniesiono do stabilnego callbacku właściciela refa; `FrameCounter`
jedynie rejestruje callback w `useFrame`. Bez wyłączenia reguły. Focused ESLint
obu nowych plików przeszedł exit 0, a powyższe finalne typecheck i Chrome
wykonano już dla poprawionego właściciela licznika.

Cleanup kwalifikuje **śledzone geometrie**, nie całkowitą pamięć GPU,
lifetime wszystkich materiałów/tekstur ani długotrwały memory stress.
Pozycjonowanie w fixture nie wykonuje produkcyjnej transakcji Apply/ACK.
Nie jest to dowód kompletnego `/workspace`, kreatora CPW, inspekcji pól,
conductor/current bridge, closed-circuit solve, FFT, LLG/Relax, czterech lane
lub trwałego zapisu. Pełny T00–T18 pozostaje otwarty.

Następny krok: domknąć tworzenie CPW przez produkcyjny kreator i jego eksport
oraz wykonać browser regression kanonicznych transakcji pozycjonowania.
Sprawdzone bieżące luki: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts::defaultMicrostripAntennaObject`
i command `geometry.add-microstrip-antenna` tworzą tylko microstrip;
`apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx::conductorDetails` nadal pokazuje szczegółowe
parametry wyłącznie dla microstrip, a hint w `apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementEditor.tsx::AntennaPlacementEditor` mówi
o signal/return zamiast całym zespole przewodników. Podgląd CPW i jego edytor
stacji nie usuwają tych braków produkcyjnego wejścia i inspekcji.
`apps/control-room/src/modules/ribbon/ribbonContributions.tsx::physicsTab`
w grupie `rf-sources` nadal oznacza akcję `add-cpw` jako disabled, bez komendy;
obecna akcja `add-microstrip` wskazuje produkcyjny command microstrip.
Podgląd authored geometry nie może zastępować rzeczywistego przewodnika,
current source ani field-sampling domain w solve.
