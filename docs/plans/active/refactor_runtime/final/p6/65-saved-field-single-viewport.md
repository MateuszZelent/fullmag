# P6-65 — zapisane pole w jednym viewportcie

Data: 02.10.2026. Baza: `d6d1b31cd7eb5e706210e7c0e2c7d4815b362acf`.
Status: **źródła i browser fixture PASS; backend/native odbiór otwarty**.

## Zakres

Historyczny wybór materializowanego datasetu uruchamia zasoby przypięte do
projektu, runu, rewizji SolutionSet, membera i pełnego artefaktu. Wspólny
viewport otrzymuje neutralny model renderowania; nie tworzymy drugiego
canvas ani sztucznej sesji solvera. Geometry/support używają transportu
P6-64, a pełne wartości używają integralnego FMDS.

Limit pełnego pola wynosi 64 MiB i 4096 chunków. Przyrost dopuszcza wyłącznie
bezpośrednie nodalne `m`, trzy składowe, jednostkę `1`. Wartości F32/F64
zachowują precision producenta. Niepełne pokrycie, niezgodna tożsamość,
nieobsługiwana reprezentacja lub brak supportu mają jawny stan niedostępny.
Nie powstaje nowa interpolacja, rekonstrukcja modalna ani projekcja
współczynników FEM na fizyczne pole.

Support określa węzły renderowalnego pola; nie oznacza własności obiektów.
FMMT v2 nie dostarcza object/Airbox ownership, dlatego model zapisanej
geometrii ma jawny whole-domain carrier i puste semantyczne mapy własności.
Status reprezentacji pozostaje `not_verified`.

Kamera zapisanej tożsamości ma oddzielny cache LRU do ośmiu pozycji i fence
epoki. Gesty oraz adaptery fit/reset/projection nie zapisują aktywnego
CameraRegistry. Błąd zasobu lub `refreshError` wygasza zapisaną scenę.
F32 przechodzi przez inline mapping; worker przyjmuje rzeczywiste F64.

## Usunięte przyczyny błędów

- Saved carrier używa jednego fallback layer, bez drugiej białej powierzchni.
- Topology i field dzielą rewizję geometry manifest; osobna tożsamość datasetu
  nadal chroni transport, cache i build. Nie osłabiono compatibility guardu.
- Manager uploadu jest tworzony i sprzątany w tym samym efekcie, więc
  StrictMode nie używa ponownie permanentnie disposed managera.
- Materiał fallback jest odtwarzany przy przejściu na vertex colors.
- Callbacki kamery mają stabilne zależności; render nie kasuje oczekującego
  commita gestu. Fixture obserwuje rzeczywisty commit, zamiast próbki po 120 ms.
- Synchroniczny guard wymaga geometrii i retention key. Vertex oraz shader
  scalar/vector/complex zapisują chunki do oddzielnych staging arrays.
  Adopcja w `onVisible` zachowuje tożsamość istniejącego BufferAttribute.
  Abort przed adopcją nie zmienia podłączonego pola; rollback przywraca array
  i zakresy aktualizacji. Dodatkowy staging ma ograniczenie rozmiarem pola;
  pełny pomiar pamięci pozostaje NOT VERIFIED.

## Dowody odbioru przyrostu

| Bramka | Wynik i granica dowodu |
|---|---|
| Production TypeScript | PASS, `d703e256e3cd44ad8a8610a7968058bb`; późniejsze poprawki zachowania dotyczą wyłącznie fixture JS. Przed commitem usunięto dodatkową pustą linię EOF w dwóch nowych plikach TS. |
| API hygiene | PASS, `4f617264618e4aae8b6b7ba67c8c3594`; granica API pozostaje niezmieniona. |
| Focused ESLint | Zmienione produkcyjne TS: exit 0. Fixture: exit 0, dwie uwagi o istniejących niewykorzystanych helperach. |
| Niezależny review | Admission, identity/camera fences, F32/F64, staging/rollback/StrictMode oraz finalny fixture: brak P0/P1. |
| Browser fixture | PASS, `d836530e926145f58d371a3f3506764d`, exit 0, źródła niezmienione podczas próby, serwer fixture zakończony. |
| F64 i F32 WebGL | Oba mają rzeczywiście rysowany atrybut color i support: `active_color_mask_seen=true`; canvas 615×634, `contextLost=false`, odpowiednio 1855 i 2038 draw calls. |
| Kamera | Osobne gesty F64/F32, powrót A/B przywraca właściwe pozycje; brak live camera mutation. |
| Izolacja | Saved nie pobiera aktywnej geometrii/pola. Po zamknięciu i ponownym otwarciu workspace live nie korzysta z saved resources ani saved camera. Powrót live jest dowodem reopen, nie bezpośredniego deselect w tym samym zamontowanym workspace. |
| Negative cases | Forged manifest, geometry identity mismatch i HTTP 503 mają jawny unavailable; freshness unknown; brak last-good sceny i live fallbacku. |
| Regresje unit | Źródła zapisane, NOT COMPILED / NOT RUN zgodnie z aktualnym zakazem. |

Browser receipt przypina źródła do digestu
`31e8caf728b17d8b2abd13231670e5f9508f3ebfcd7b1c490eb1526f0958b4ff`.
Digest opisuje zamrożone źródła próby przed kosmetyczną normalizacją EOF.
Dowody znajdują się pod rozwiązaną ścieżką storage:
`builds/fullmag-0950f4dca4ffe38f/windows-control-room-browser-fixture/pinned-dataset-browser/d836530e926145f58d371a3f3506764d/`.

Pełny lint pozostaje FAILED (`6bdd2d2bb4bc44cfbfa38c29135cd266`): wcześniejszy
wynik obejmuje istniejące błędy FieldMap/FdmCuboidLayer/testu Inspectora oraz
zmianę fixture podczas kontroli; nie jest finalnym odbiorem całego repozytorium.
Nieudane browser receipts zachowano. Jeden z nich (`c9e04a0b6fe64410a73d1d5b51fccf01`)
wykazał pusty generowany Next `dev/build-manifest.json` i HTTP 500; świeży
izolowany bundle pozwolił wykonać finalną próbę bez usuwania cache.

Fixture rozróżnia dokładny POST visualization/client-acks od mutacji state.
Odczyty globalnych katalogów są raportowane osobno od geometrii/pola.
Limity requestów i ostrzeżeń są sprawdzane per mount; limity geometry,
topology/support i FMDS zachowują oddzielne liczniki. Negatywny saved workspace
jest zamykany przed przywróceniem poprawnego fixture, aby jego pending retry
nie był przypisany do nowo otwartego live. Niezależny review potwierdził te
korekty jako poprawę zakresu dowodu, bez maskowania właściwych mutacji.

## Review przy commicie

Commit przyrostu: `c25bb5ae8314e74dd5f426e407442d16c0e04029`.
Hook React Doctor przeskanował 20 staged plików: 70/100, 15 nieblokujących
ostrzeżeń. Nie wyłączono ani nie suppressowano reguł.

- `html-label-has-single-control`: istniejący OrbitDebugField obejmuje output
  i input w jednej etykiecie; potwierdzona uwaga dostępności, wysoka pewność,
  zakres istniejącego debug UI pozostaje do osobnej korekty.
- Pięć `async-await-in-loop`: celowe yield między bounded batchami, aby
  przeglądarka mogła przetwarzać klatki/anulowanie; nie jest niezależnym
  zewnętrznym I/O do bezwarunkowego Promise.all. Wysoka pewność.
- Trzy porównania długości: kamera jest konstruowana i klonowana jako
  dokładne trójki; `toFiniteVector3` normalizuje patche. W tym kontrakcie
  brak długości nie zmienia wyniku porównania. Wysoka pewność.
- Chained iteration, trzy kopie przed sortowaniem i dwa dostępy w pętli:
  sygnały do pomiaru wydajności; brak wykazanego błędu lub nieograniczonego
  kosztu w tym przyroście. Nie zastępują otwartej bramki peak memory/performance.

## Nadal otwarte

Backend HTTP z rzeczywistym native snapshotem, archive roundtrip, semantyczna
własność Object/Airbox, pozostałe reprezentacje/quantities, fit/reset/projection w browserze, pomiar peak memory,
parytet CPU/GPU, nauka i release pozostają osobnymi bramkami.

Fixture nie kwalifikuje solvera ani native representation. P6 około 52%,
cały plan około 49%; ten przyrost nie zamyka całego etapu.

Bezpośredni powrót saved→current bez reopen został odebrany osobno w
[P6-65a](65a-direct-current-viewport.md); wcześniejszy receipt P6-65 pozostaje
dowodem reopen, a nie tej późniejszej akcji.
