# Odbiór eksportu przywróconej sceny GSG przez wdrożone API

Data: 08.11.2026. Sprawdzono istniejące API grupy 3203 po aktualizacji
8857232e70bc47aca8dea77ad9da0f86. Nie zmieniano kodu, kontraktów ani fizyki.

## Rzeczywisty przepływ i wynik

1. Odczyt model/script zwrócił 400: sesja authoringu nie miała jeszcze
   wygenerowanego skryptu. Odczyt ten nie wykonuje eksportu.
2. Publiczne POST model/syncs z expected_scene_revision=1 wygenerowało
   kanoniczny skrypt 5483 B; endpoint uczciwie zwrócił fidelity=not_checked.
3. Publiczne GET model/script odczytało tę samą treść jako canonical=true.
4. Publiczne POST persistence/projects/from-script przyjęło dokładnie tę
   treść (HTTP201), wyeksportowało scenę i porównało oba obniżenia do IR:
   script_import.fidelity.round_trip=verified.
5. Import nie aktywował projektu, nie zmienił bieżącej sceny/sesji ani listy
   runów. Własny katalog solvera nadal ma tę samą historię. Run pozostaje null.
6. Kopie skryptu i projektu zapisano i odczytano również na ext4 hosta WSL.

API i CLI pozostają w wersji
0.1.0-dev.20261107.g3f57151a9c1a.dirty.s08b4e431e3fe+9807.
Wdrożone binaria pochodzą ze snapshotu
08b4e431e3fefee766ff997dc73ca65de7ed9f1dbd945bf2b7524dcd6bab810c.
Aktywna sesja to session-18e5e104d696c55200004eab, scene revision 1.

## Zakres porównania

Dokładnie zachowane są current_transports, antenna_port_modes oraz
antenna_field_solve_stages, w tym cięcie źródła i napięcie, definicja
normalizacji, wybór źródła i sampling. Sprawdzono też requested
backend/device/precision/mode, brak exchange/demag, zasoby authoringu,
output_storage i study_pipeline.

Identyfikatory, role, nazwy, transformacje obiektów i ich bounds są zgodne.
Parametry pełnego obwodu CPW/GSG są identyczne poza dodanym jawnym kluczem
nazwy geometrii. Rozmiary siatki i rząd są zachowane.

Nie deklarujemy identyczności surowego JSON: porównanie wykazało 262 różnice,
głównie dodanie pustych pól domyślnych. Próbka Box ma po imporcie jawny
wrapper Translate, ten sam rozmiar, bounds i transformację obiektu.
Algorytmy 2D=6/3D=1 oraz quality=true/per_element_quality=true z wejścia
nie są jawnie ponownie emitowane w tabeli domyślnej; odpowiadają wartościom
MeshOptions w packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py.
Ten odbiór nie dowodzi zachowania dowolnych niedomyślnych ustawień siatki.

Importer nie dodał materiału ferromagnetycznego, stanu magnetyzacji,
solved drive ani transportu spinowego. Nadal jest to niemagnetyczny model
inspekcji anteny z osobnym obiektem próbkowania.

## Artefakty i dowody

W bieżącym worktree WSL, examples/sushruth_2020_closed_gsg:

| Plik | SHA256 |
|---|---|
| restored_gsg_scene_20261108.py | d6c8d55caf95638089ba71b5a0f326f7f00094520bf79bd810f0f4aa7c0b2e94 |
| restored_gsg_scene_20261108.fms | 4373b2d4ba8fbd3a6c2465855744d3f1d7fd23495b214c81b12b657da9f7ed0f |

Projekt ma 9994 B i manifest/project.json. Parser składni Pythona,
manifest archiwum i oba hashe przeszły kontrolę z hosta WSL.
Eksportowany skrypt zachowuje istniejące jawne ścieżki output_storage;
ten odbiór nie jest deklaracją jego przenośności na inną instalację.

Dowody techniczne są w control volume pod prefiksem
verification/gsg-corner-refinement-20261107/runtime-upgrade-audit-v1/
standalone-supervisor-proposal-v1/approved-execution-v1/:
script-export-intent.json, script-export-response.json,
script-reimport-intent.json, script-reimport-response.json,
script-roundtrip-scene-differences.json oraz
restored-authoring-roundtrip-result.json.
Ostatni ma SHA256
6a5a4323ce8b224c60e91d39917fcd76251a068daa502c7395a524a95fc66cbe.

Pierwszy wrapper odbioru po eksporcie błędnie porównał całe session:
oczekiwanie zawiodło, ponieważ eksport prawidłowo dodał opis script.
Odczyt wykazał, że to jedyna różnica sesji; scena i run nie zmieniły się.
Kontrolny skrypt porównania błędnie szukał translation w geometry_params
Box; właściwy transform należy do obiektu. Sprawdzono rzeczywiste położenie
z transform i bounds, bez zmiany danych lub ponawiania importu.

## Otwarte bramki

- Browser/WebGL po aktualizacji: NOT VERIFIED; obie stare karty są nadal
  stronami błędu, a pytanie o świeżą kartę pozostaje otwarte.
- Przygotowanie gotowego requestu corner25: niewykonane po nowym buildzie.
- Nowy transport/pole na corner25 i wartość eta: niewykonane.
- Kwalifikacja bazy, LLG, m(k,omega), odtworzenie publikacji: niepotwierdzone.

Odbiór naprawia lukę dowodową wdrożonego authoringu. Nie zastępuje kolejnego
kontrolowanego eksperymentu fizycznego ani wizualnej kontroli pola.
