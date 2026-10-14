# CPW: model przekrojów dla przyszłego podglądu UI

## Zakres przyrostu

`apps/control-room/src/shared/domain/geometry/authoredMicrostripGeometry.ts`
+ `buildAuthoredCpwGeometry` buduje trzy rozdzielone loftowane przewodniki:
signal, ground_left i ground_right. W każdej stacji stosuje niezależne
signal width, left/right gap i left/right ground width, zgodnie z
`packages/fullmag-py/src/fullmag/model/geometry.py::CPWAntennaLayout._sections`.

Wspólny prywatny `buildAuthoredAntennaGeometry` zachowuje dotychczasowy
`buildAuthoredMicrostripGeometry` i jego publiczny typ. Współdzieli walidację
stacji, transformacje, triangulację i bounds, nie tworzy drugiej implementacji
tych samych transformacji. CPW nie jest aproksymowane microstripem ani boxem.
Trzy części zachowują własne ID; trójkąty nie łączą ich przez szczeliny.

To model autorskiego podglądu, **jeszcze nie podłączony do viewportu CPW**.
Nie dodano komendy kreatora, Inspectora CPW, nowych zasobów, stanu Zustand,
subskrypcji ani HTTP. Nie zmieniono fizyki, writer IR, backendów czy siatki
solverowej. Nazwa istniejącego pliku pozostaje kompatybilna z odbiorcami
microstrip; publiczny typ wspólny to `AuthoredAntennaGeometry`.

Kontrakt naukowy pozostaje w
`docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
+ `antenna-round-trip-and-failure-semantics`. Zmienna szerokość wzdłuż prądu
wymaga pełnego 3D conductor/current solve; powierzchnie podglądu nie stanowią
rozwiązania transportu ani pola anteny.

## Wykonane kontrole

`apps/control-room/scripts/check-cpw-authored-geometry.mjs`: **5 kontroli PASS**.
Skrypt interpretuje rzeczywisty model TS przez natywne usunięcie typów Node;
bez kompilacji/bundlowania testów, bez Three/WebGL, bez solvera.

- Sześć stacji z przewężeniem: 72 wierzchołki, 132 trójkąty, trzy części.
  Signed volume porównane z niezależnymi wartościami trapezoidalnymi:
  signal $0.904\cdot10^{-18}\,\mathrm{m^3}$ i oba grounds po
  $10^{-18}\,\mathrm{m^3}$, razem $2.904\cdot10^{-18}\,\mathrm{m^3}$.
  Każda krawędź ma dwie przeciwne orientacje; żaden trójkąt nie przekracza
  zakresu wierzchołków swojego przewodnika.
- Asymetryczne gaps/grounds: szerokości i oba puste odstępy sprawdzone
  niezależnie w każdej stacji; bounds z wszystkich wierzchołków.
- Inner rigid transform oraz osobny outer scale/quaternion/translation:
  każda współrzędna porównana z niezależnym przekształceniem, signed volume
  ze skalą determinantową. Renderowa obsługa scale/rotation nie znosi
  ograniczeń publicznego capture/export owner-frame.
- Każdy z pięciu wymiarów stacji odmawia zera, wartości ujemnej, braku,
  NaN i Infinity.
- Odmowy błędnego porządku stacji, conductor kinds/ID, reflection, pivot,
  niejednostkowego kwaternionu, zerowej skali, overflow i ponad 8192 stacji.

Dotychczasowy `check-microstrip-viewport-model.mjs`: **12 kontroli PASS**,
także rzeczywiste geometrie Three, bounds, utrzymanie conductor metadata,
aktualność siatki i priorytet złotego koloru. To regresja modelu, nie solvera.

Osobne wykonane porównanie z Pythonem: `CPWAntennaLayout.to_ir` i `_sections`
wygenerowały trzy stacje asymetryczne z Rz(90°), translacją i własnymi ID.
Produkcja TS odczytała ten JSON; wszystkie **108 współrzędnych** zgodne,
maksymalny błąd $0\,\mathrm m$. To dodatkowa kontrola przekrojów, nie
kompletny UI→Python round-trip ani kwalifikacja native.

`just check-control-room-production-source`: **passed**, exit 0,
receipt `81ad531fb7b34a6cac2de8f3299dcfff`, profil
`windows-control-room-source-check/production-source`.
Digest przed/po identyczny:
`0e464c32abe8580048e19c80dc659ad87e55c55c87843fffbf0b3a230173ad8b`.
`source_changed_during_run = false`; `tsc --noEmit`, bez budowania testów.

Architecture hygiene: PASS po uruchomieniu z katalogu `apps/control-room`,
wymaganego przez skrypt. Pierwsze wywołanie z root repo błędnie szukało
plików pod rootem; nie jest dowodem brakujących manifestów w aplikacji.

Istniejący microstrip widoczny w browserze na porcie 3197, bez zmiany modelu
czy restartu sesji. Osobny read-only Playwright smoke świeżego workspace:
canvas visible, `contextLost=false`, drawing buffer `532×281`.
Przeglądarkowy adapter DOM nie udostępnia `getContext`; wymagany odczyt
wykonano przez właściwy Playwright. Nie jest to wizualny dowód CPW.

Lint całego Control Room: pierwsze wykonanie odmówiło nazwy lokalnej zmiennej
`module` w nowym skrypcie (`@next/next/no-assign-module-variable`). Nazwę zmieniono
na `geometryModule`, bez zmiany geometrii i bez wyłączania reguły; ponowny lint
**passed**, exit 0, receipt `0eb7e8b9604540b0b22169ecf72fab82`.
Digest przed/po identyczny:
`bdc6b3d8359f6d54f19c5a5718649e54d786e9c155d6d84be017ead2654fc1f7`;
`source_changed_during_run = false`. Produkcyjny model TS nie zmienił się po zielonym source-check.
Pierwsze równoległe wywołanie odmówiło zajętej blokady source-check;
nie obchodzono jej. Właściwy lint uruchomiono po zakończeniu typecheck.

## Otwarte wymagania

FDM CPU/GPU: model podglądu wspólny, CPW authoring solverowy nadal FEM-only.
FEM CPU/GPU: zgodność modelu przekrojów, **brak nowej kwalifikacji runtime**.
Build 38 nadal działa na wcześniejszej kapsule i nie obejmuje przyrostu.

Następna spójna ścieżka UI wymaga:

1. komendy tworzącej CPW, transport z sześcioma terminalami i jawny port;
2. edytora wszystkich pięciu wymiarów stacji, z zachowaniem draft/conflict,
   rewizji, sesji i immutable ID;
3. podłączenia modelu CPW do viewportu i aktualności siatki, bez box fallback;
4. bounds/placement above/below, conductor details i Inspector;
5. browser Object/Airbox stability i rzeczywistego WebGL obrazu CPW;
6. backendowego eksportu/importu i naukowej ścieżki current→field→basis→LLG/FFT.

Nie zamknięto T04/T15 ani pozostałych zadań całego celu. PR #147 pozostaje Draft.
