# GSG: lokalne 25 nm przy narożach — propozycja jednej próby przygotowania

Status: **siatka corner25 wygenerowana i zachowana w WSL; publiczny eksport przygotowania odrzucony przez starszy CLI. Brak gotowego requestu i nowego V/J/H**.
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


## Aktualizacja gotowości po zakończeniu naprawy eksportu — 07.11.2026

Wpisy powyżej opisujące utratę domeny przez SceneDocument są historyczne.
[Raport zakończonej naprawy](2026-11-07-explicit-domain-roundtrip-result.md)
potwierdza pełny roundtrip obu przypiętych wejść, również corner25, przez
rzeczywiste adaptery Rust i Python. Końcowy
[CI 42402270407](https://github.com/MateuszZelent/fullmag/actions/runs/42402270407)
dla kodu d8d35943caca6d894562077828ea077555bdbf21 zakończył się success.
Guardy potwierdziły zero tworzenia siatek i zero zgłoszeń Solve.
Ta kontrola authoringu nie kwalifikuje wyniku fizycznego.

Odczytowy docker_gsg_reference.qualified_backend przeszedł dla istniejącej
pary usług 3203: development attempt 894d4efb43eb483eb6179d8d49fd449e,
config SHA256 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4,
backend 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Potwierdził bieżącą inkarnację, zdrowie usług, powiązany pakiet i manifest
archiwum. Nie wykonano control.prepare, operacji przygotowania ani restartu.
Nowe poprawki Rust authoringu nadal nie są wdrożone w tym starszym pakiecie.

Osobna ścieżka prepare-only nie wymaga zwalniania zawieszonej rezerwacji
obliczeniowej. Nie jest to zgoda na Solve ani dowód, że kolejny Solve zostanie
przyjęty. Kontroler ponownie sprawdzi tę samą grupę przed przyjęciem operacji.
Ponowny odczyt kandydata, patcha i walidacji potwierdził niezmienione SHA256
z tabeli. Patch pozostaje niewdrożony, corner25 nie wykonano; wymagana jest
decyzja o tej jednej próbie. Dotychczasowe limity i fizyka pozostają bez zmian.


## Zatwierdzone wykonanie i odmowa przed kontrolerem — 07.11.2026

Użytkownik zatwierdził patch bbc7ce18eff5512560df50c1695035cc45fcb49624b9241cdfb955f1896d22a0
i jedną próbę prepare-only. Dostarczono oba przypięte pliki do katalogu
runtime-free-inputs-v1 bez nadpisania starych wejść. Test nowego profilu
odtworzył brak wyboru corner25, a po zastosowaniu patcha przeszły 22 testy
kontrolera. Jego SHA256 jest zgodne z zapowiedzianym
e721b84fd2be2b6fae34c35fbedbd058656164bf9fb98b94d31570fce0eac3b8.

Pierwsze wywołanie nie znalazło just w PATH, przed uruchomieniem recepty.
Odnaleziono istniejące /home/kking/.local/bin/just (wersja 1.42.4); niczego
nie instalowano. Jedna właściwa recepta docker-dev-gsg-mesh-prepare zakończyła
się exit 2 po 0,076 s: „invalid GSG mesh preparation recipe”.

Przyczyna: scripts/just_storage_shell.sh dopuszczał wyłącznie 50/35/25.
Pierwotny patch i trzy testy profilu nie obejmowały tej drugiej granicy.
Nie wywołano kontrolera Python ani Gmsh. Wskaźnik gsg-mesh-preparation/current.json
nadal wskazuje wcześniejszą udaną próbę 155483362d284e87a8113daddc76119b
poziomu 50; nie utworzono zarządzanej próby corner25.

Dodano wyłącznie corner25 do zamkniętej alternatywy profili w bramce just
oraz rozszerzono regresję rzeczywistej recepty/shella o ten profil,
corner35 i ../corner25. Test trasy odtworzył odmowę przed poprawką.
Po poprawce cały dobrany zestaw kontrolera, trasy i producenta cache:
34/34 PASS w obecnym backendzie. Testy trasy używają atrapy interpretera,
nie uruchamiają kontrolera, Dockera ani meshera. Sprawdzają zachowanie
wszystkich pinów, starych profili, odmowę obcych profili, dodatkowych flag
wykonania i dopisanych poleceń. Bash -n: PASS.

| Uzupełnione przypięcie | SHA256 |
|---|---|
| Bramka shell po integracji | e8943a6ce6c5935eb56e6fbbdd44465a39f274d8fb26672f471d3e07815064dc |
| Test kontrolera | 0dbdd6f94872bbfd2ffa3e5beafcb09ad4c72e8ee4f488367d91d4114c101b6a |
| Test trasy | 83701d552aa410a7f48c7dc29cfb21bbdb1b7e34990595d0d77dd89838744a93 |
| Kompletny patch względem stanu sprzed tego etapu | 50e67ad52a00ba54a903987dfc7bd9c20b8244a7fd1d22bd8303f7e1487bcd1c |

Pełne dowody są w prywatnym control volume grupy 3203:
verification/gsg-corner-refinement-20261107/approved-execution-v1/.
Pliki: test-red.log, test-green.log, route-red.log, integrated-green.log,
managed-recipe.log, managed-recipe-result.json, final-source-pins.json,
preparation-pointer-after-shell-refusal.json i complete-profile-integration.patch.
Pierwszy wrapper odbioru RED błędnie oczekiwał innego tekstu odmowy; właściwy
log wskazuje Invalid preparation selection i został sprawdzony przed zmianą
produkcji. Nie podmieniano testu ani logu, aby ukryć ten błąd wrappera.

## Konkretny następny odbiór po poprawce trasy

Zgodnie z punktem 5 zakresu wykonania każda odmowa kończy jedną próbę;
nie uznano tej odmowy za zgodę na retry. Potrzebna jest decyzja wyłącznie
o jednym nowym wywołaniu tej samej recepty prepare-only z corner25.
Kandydat, nośnik H, pięć części, source cut, fizyka i limity pozostają
dokładnie takie jak powyżej. Wykonanie dopiero po ponownej kontroli SHA
czterech zmienionych plików i bieżącej inkarnacji grupy przez kontroler.

Nowa próba kończy się po odbiorze gotowego requestu, rzeczywistych długości
krawędzi/objętości naroży, potwierdzeniu cache i zebraniu dzieci. Każda
odmowa ponownie kończy tę próbę. Bez Submit/Solve, native buildu, restartu,
podnoszenia limitów lub zmiany rezerwacji. Obecne wyniki pozostają.
Zastosowane zmiany kodu nadal są w roboczym drzewie z wcześniejszymi
niezacommitowanymi zależnościami kontrolera; sam commit dokumentu nie
stanowi opublikowania samodzielnego pakietu tych źródeł.


## Odbiór jednej zatwierdzonej kontynuacji — 07.11.2026

Zgoda na nowe wywołanie wpłynęła. Wykonano dokładnie jedną receptę
docker-dev-gsg-mesh-prepare z corner25 i niezmienionymi pinami grupy 3203.
Próba 8b99f132491b4c0f9e6305186a252b87 ma failed-confirmed; recepta exit 2,
czas 186,566 s. To stan całej próby, mimo udanego wykonania Gmsh.

Trzy fazy inventory-before, mesh-producer i inventory-after zakończyły się
exit 0. Cache producenta:
1673b40a6b14d4732336229340b5d063e2252f2652a27cdcc5d3e8d8a8e05f7a.npz,
1 863 470 B, SHA256 69c7e3322e25fcf309c8eab7698e5b724f4aad6fe51e0c67a82f7704622b06c3.
Kontrola po zakończeniu ponownie potwierdziła identyczny SHA256.

| Obserwacja | Local50 | Corner25 |
|---|---:|---:|
| Surowe węzły Gmsh przed cięciem | 12 573 | 14 193 |
| Tet4 | 34 243 | 40 783 |
| Pola rozmiaru ze statusem applied | 2 | 10 |
| Objętość przewodnika [m³] | 1,314e-18 | 1,314e-18 |
| Dodatnie objętości Tet4 | 34 243/34 243 | 40 783/40 783 |
| Medianowa najdłuższa krawędź przy narożach [nm] | 68,74–76,79 | 39,60–40,90 |

Ostatni wiersz obejmuje osiem osobnych otoczeń: centroidy do 100 nm od
zadanych pionowych odcinków naroży, z rozłącznym przypisaniem do najbliższego
odcinka. Dla każdego Tet4 obliczono długości sześciu krawędzi, potem medianę
najdłuższej. Ilorazy median corner25/local50 wynoszą 0,523–0,581.
To opis zrealizowanej geometrii, nie estymator błędu J/H i nie kwalifikacja.
W raporcie producenta po cięciu źródła jest 14 209 węzłów i 18 par.
Wszystkie pięć części istnieje. Nośnik H pozostaje niezmieniony; znaczniki
przekroczenia 72 911 komórek i 4 mln par są false. Nie uprawnia to do Solve.

### Ujawniona niezgodność spójnego pakietu

Publiczny CLI zakończył się exit 1, stdout 0 B, stderr 410 B:
antenna_field_solve odrzuca interactive_session_requested oraz wait_for_solve.
Działający pakiet ma wersję 0.1.0-dev.20261105.g006e8f024f89.dirty.s42d570eca01a+9805.
Jego binaria nie zawierają późniejszej, już przetestowanej poprawki flag.
Nie usunięto flag z wejścia ani nie podmieniono ich wartości dla starszego
czytnika. Gotowy request nie powstał. Nie uruchomiono kolejnego prepare,
transportu, H-only, LLG, buildu lub restartu. Dzieci zostały zebrane;
terminalny receipt nie oznacza zgody na automatyczne ponowienie.

Dalszy krok wymaga wdrożenia spójnego nowszego pakietu przez managed build,
a dopiero potem osobno uzgodnionego odbioru przygotowania. Ostatnia zgoda
jawnie wykluczała build; niniejszy raport go nie uruchamia ani nie rozszerza
istniejącego recovery. Rezerwacja starego solvera pozostaje osobnym warunkiem
kontrolowanego okna. Nie deklarujemy gotowości do następnego Solve.

### Trwałe dane i dowody

Dowody techniczne w control volume:
verification/gsg-corner-refinement-20261107/approved-continuation-v2/
(managed-recipe-result.json, managed-recipe.log,
realized-corner-mesh-comparison.json). Raport porównania ma SHA256
43728368759ab7f878343eb8193b09f4afe105eb0808e6bd67707e4324741192.
Oryginalny receipt i pełny stderr:
verification/gsg-junction-preparation-20261106/attempts/8b99f132491b4c0f9e6305186a252b87/.

Unikalną siatkę i wejścia zachowano również na ext4 hosta WSL w
examples/sushruth_2020_closed_gsg/corner25_preparation_20261107_8b99f132
obecnego worktree. Katalog zawiera 9 plików z kontrolowanym SHA256,
README i manifest-integrity.json. Manifest ma SHA256
f7d52aeb046dd00bbb3628a391dcf0b56eb25ce4a47319bc285e0ad0f62564c9.
Osobny odczyt z WSL potwierdził wszystkie kopie. To archiwum przygotowania
z oryginalnym .npz; nie nazywamy go wynikiem Zarr ani gotowym requestem.

Niezależnie od tej próby odczytano z hosta WSL wszystkie 1 958 unikalnych
obiektów CAS wskazanych przez ostatni run V/J/H 40c6990b…, jego 1 980
referencji assetów, definicję, study, katalog i dwa opublikowane artefakty.
Łącznie 222 741 485 B; każdy SHA256 zgodny, run intent i artifact catalog
nie zmieniły się podczas odczytu. Sam pakiet V/J/H ma 124 406 331 B.
Dowód host-cas-persistence-20261107-v1.json jest w poprzednim katalogu
approved-execution-v1 i ma SHA256
58f2b7f52af0201c094cdc9a724d90399d337ac7a4de1151bcde506bd2fcf453.
To dowód trwałości bajtów w WSL, nie nowy cold-load runtime, przenośny
sąsiedni Zarr lub potwierdzenie nauki. Nie kopiowano całego magazynu CAS.
