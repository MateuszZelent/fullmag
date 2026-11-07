# GSG: lokalne 25 nm przy narożach — propozycja jednej próby przygotowania

Status: **projekt do decyzji; patch niewdrożony, siatki nie wygenerowano**.
Baza: `5c57d680b379b53b4f29c614f091ab92864352e2`.
Celem jest rzeczywiste zagęszczenie źródła 3D w miejscach dominujących w
błędzie prądu, przed dalszą kwalifikacją pola i odpowiedzi LLG.
To plan eksperymentu z istniejącą metodą, nie nowa nota fizyki lub
kwalifikacja publikacyjna. Obowiązują dotychczasowe równania i progi
[noty anteny](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).

## Uzasadnienie i wybór wariantu

[Wykonany audyt](2026-11-07-gsg-discrepancy-diagnosis.md) wykazał, że około
99,9% energii korekty prądu przypada na końcowe połączenia, a 83,12% ich
energii leży do 100 nm od ośmiu ostrych naroży. Dotychczasowy lokalny wariant
50 nm nie był w tych połączeniach drobniejszy od dawnego globalnego 50 nm.
Zachowany wynik ma eta=0,03464604656814306; nowy wariant nie ma jeszcze eta.

Można zagęścić całe połączenia istniejącym wariantem 25 nm albo ograniczyć
25 nm do naroży, zachowując 50 nm w pozostałych połączeniach i 75 nm na
paskach. Proponujemy drugi wariant: obejmuje zidentyfikowane skupiska błędu
przy mniejszym koszcie. Nie wygładzamy naroży i nie zmieniamy obwodu.

## Dokładny kandydat wejścia

Kandydat pochodzi z zachowanego `gsg_junction_prepare_50nm.py` o SHA256
`6da40fc7342d7c3b78223c7ae21b14111a3172be3adcea697ccef1d37f734050`.
Geometria, transformacja, przewodność, źródło napięciowe, cięcie źródła,
normalizacja prądu, polityka solvera i nośnik 20 punktów H pozostają identyczne.

| Parametr | Kandydat |
|---|---|
| Rozmiar w długich paskach | 75 nm |
| Dwa dotychczasowe pola końcowych połączeń | 50 nm, zachowane dokładnie |
| Minimalny dozwolony rozmiar | 25 nm |
| Położenia ośmiu pionowych linii | x = ±100, ±350 nm; y = ±11,8 µm; z = 30…120 nm |
| Odległość od linii do 100 nm | zadane 25 nm |
| Pojedyncze pole naroża przy 100…200 nm | liniowe 25→75 nm |
| Pole wynikowe w połączeniu | minimum pól: osiąga 50 nm przy 150 nm; dalej 50 nm |
| Materiał, długość, grubość, źródło | bez zmian |

Zdegenerowane `BoundsMin`/`BoundsMax` opisują linię w istniejącym polu
`AxisAlignedBoxDistanceThreshold`, nie nową bryłę przewodnika. Zachowanie
minimum chroni przed przypadkowym zagęszczeniem całego obwodu do 25/50 nm.
Źródła: `model/geometry.py::CPWAntennaLayout.connection_solids`,
`meshing/_gmsh_fields.py::_box_outside_distance_expression`,
`meshing/_gmsh_fields.py::_add_axis_aligned_box_distance_threshold_field`
i `_configure_mesh_size_fields` pod `packages/fullmag-py/src/fullmag/`.

## Zakres patcha i wykonania po zgodzie

Patch zmienia tylko `scripts/docker_gsg_mesh_preparation.py` i jego test:
addytywny wybór `corner25`, dwa dodatkowe przypięte pliki wejścia oraz test
wyboru `--prepare-only`. Stare osiem pinów, wersje kontraktów, guardy,
obsługa końca procesu i stare profile pozostają zachowane. Dotychczasowe
profile także będą wymagały obecności dwóch nowych plików: należy je
utworzyć i sprawdzić **przed** aktywacją kontrolera.

Po ponownej kontroli SHA źródeł i `git apply --check`:

1. Dostarczyć dokładnie kandydat i jego metadane do dotychczasowego katalogu
   `runtime-free-inputs-v1`, bez nadpisania starych plików. Odmówić przy kolizji.
2. Zastosować przypięty patch; wykonać właściwe testy zmienionych źródeł.
3. W aktualnym worktree WSL wykonać dokładnie jedną zarządzaną receptę
   `justfile::docker-dev-gsg-mesh-prepare`, z profilem `corner25`, bieżącym
   zweryfikowanym backendem i jego zgodnymi pinami. Nie tworzyć nowego runtime.
4. Odebrać trwały wynik przygotowania, prawidłowe zakończenie helpera,
   identyczny nośnik H, komplet pięciu części materiałowych i cięcie źródła.
   Porównać rzeczywiste objętości i długości krawędzi przy ośmiu narożach
   ze starą siatką. Sprawdzić zastosowanie pól i odczyt gotowego cache.
5. Zatrzymać się po odbiorze danych. Nie uruchamiać Submit/Solve automatycznie.
   Każda odmowa kończy tę jedną próbę; zachować pełny log, bez retry.

Przypięcia propozycji:

| Artefakt | SHA256 |
|---|---|
| `gsg_junction_prepare_corner25nm.py` | d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148 |
| `corner-input-validation.json` | 0539442bb331a432a19a0acafa57102540cebe606662cfa69d977d29a1aef3d5 |
| `controller-profile.patch` | bbc7ce18eff5512560df50c1695035cc45fcb49624b9241cdfb955f1896d22a0 |
| Kontroler przed zmianą | e7d67b33ad251c8f0b2d5d39e8e4b924cd422d56513a1d289fed19b3abee7e76 |
| Kontroler po proponowanej zmianie | e721b84fd2be2b6fae34c35fbedbd058656164bf9fb98b94d31570fce0eac3b8 |

## Koszt, limity i czego nie obejmuje decyzja

Proxy z centroidów zachowanych 34 243 Tet4 daje około 43 031 komórek oraz
58,47 MB skompaktowanego requestu. Dotyczy 1888 istniejących centroidów,
wyłącznie w inlet/outlet. Jest to suma sześcianów ilorazów zadanych rozmiarów,
nie prognoza liczności, dowód ograniczenia błędu lub limit czasu. Nie obejmuje
propagacji zagęszczenia, nowych podziałów powierzchni ani jakości Tet4.

Pozostają istniejące limity: helper 1 CPU, 4 GiB przestrzeni adresowej,
request 96 MiB, spool 256 MiB. Limit przestrzeni adresowej nie jest limitem
faktycznego RAM; limitów kontenera nie zmieniamy. Istniejące znaczniki
`exceeds_eta_cell_limit` (72 911 komórek) i
`exceeds_native_20_target_pair_budget` (4 mln par) muszą zostać jawnie ocenione
na rzeczywistym wyniku. Sam ich zapis nie dopuszcza kolejnego Solve.
Brak wystarczających zasobów lub niezgodność preflight oznaczają odmowę,
nie zgodę na podniesienie limitów czy alternatywny launcher.

Bez nowego V/J/H, H-only, LLG, buildu native, restartu, usuwania danych,
zmiany statusów i ręcznego zwalniania rezerwacji. Odczyt bieżącego ledgeru
potwierdził, że solverowa rezerwacja ostatniego zadania nadal ma stan
`quarantined`, a przygotowawcza `released`; ten plan ich nie zmienia.
Wynik ostatniego V/J/H pozostaje zachowany jako Succeeded.

## Wykonana weryfikacja i otwarte bramki

- Pełny authoring IR kandydata jest dokładnie równy bazie po zastosowaniu
  wyłącznie zadeklarowanej zmiany nazwy i parametrów siatki: PASS.
- 86 sprawdzeń rzeczywistego generatora wyrażeń pola, w SI i skali Gmsh
  1e9, potwierdziło 25/37,5/50 nm przy narożach oraz 75 nm w środku: PASS.
- Trzy właściwe testy niezaaplikowanego kontrolera: piny, wybór nowego
  profilu i zachowanie prepare-only/odmowy nieznanych poziomów: PASS.
- `git apply --check` względem bieżącego worktree: PASS; patch niewdrożony.
- Niezależny przegląd współrzędnych, pełnego delta IR, pinów, składania
  minimum i ograniczeń proxy: bez wykrytej zmiany fizyki.
- **Python→Python: PASS po naprawie flag**, zgodnie z zachowanym późniejszym
  audytem opisanym w uzupełnieniu. Wcześniejszy FAILED wynikał z dopisywania
  wait_for_solve=True; historyczne dowody odmowy pozostają zachowane.
  Definicje siatki i progi nie zostały zmienione w celu zaliczenia testu.
  Roundtrip przez SceneDocument nadal nie przechodzi. Ewentualna zatwierdzona
  próba przygotowania użyje oryginalnego kandydata, nie eksportu UI.

Pierwsze odczyty kontrolne ujawniły niewłaściwe użycie `Problem.to_ir`
z domyślną materializacją. Guard zablokował `gmsh.model.mesh.generate`
przed jej wykonaniem. Poprawny audyt użył jawnego
`include_geometry_assets=False` oraz `source_root`; siatki nie wygenerowano.
Nieukończony test pełnego round-trip pozostawiono wraz z dowodami odmowy.

Dowody, patch i oba źródła kandydujące znajdują się w prywatnym wolumenie
istniejącej grupy 3203:
`/opt/fullmag/control/verification/gsg-corner-refinement-20261107/proposal-input-v1/`.
Istotne pliki: `ir-delta.json`, `profile-and-cost-audit.json`,
`roundtrip-complete-differences.json`, `roundtrip-baseline-control.json`,
`controller-offline-review.json`, `controller-offline-tests.log`.

Ta decyzja dotyczy wyłącznie wyżej przypiętego przygotowania i pomiaru.
Nie kwalifikuje anteny do konsumenta LLG ani nie dowodzi zgodności z publikacją.


## Uzupełnienie po zatwierdzonej naprawie flag wykonania

Powyższy FAILED opisuje historyczny eksporter. Późniejszy zachowany audyt
verification/antenna-authoring-roundtrip-20261107/real-gsg-inputs-v1/result.json
(SHA256 e0f7f428cc7f24119f608224b0e234f98f9a66074da871128d8f468e57dc8163)
potwierdził dla obu przypiętych skryptów:
Python→Python bez różnic pełnego IR, identyczny mesh_workflow i flagi etapów.
Guardy potwierdziły zero Popen i zero gmsh.generate. Nie powtarzano tego audytu.

Python→Scene→Python nadal traci jawną domenę i mapę region_markers.
[Osobny audyt](2026-11-07-gsg-scene-domain-mesh-audit.md) oraz
[projekt naprawy](2026-11-07-explicit-domain-mesh-roundtrip-proposal.md)
opisują granicę i brak gotowości ogólnego kontraktu. Poprawka flag/ID nie
stanowi naprawy wyboru domeny. Zgoda na corner25 i wykonanie prepare/Solve
nadal nie nastąpiły; ten wpis nie aktywuje profilu ani nie kwalifikuje źródła.
