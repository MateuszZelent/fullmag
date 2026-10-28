# Odtwarzanie zapisanych wyników z folderu

Status: zaimplementowano dla regularnego FDM/Zarr; rzeczywisty zapis YIG przeszedł kwalifikację API i UI. Dowody i zakres: saved-results-playback-verification-20261027.md.

## Cel i własność

Użytkownik dodaje istniejący folder wyników w Home i wybiera Open results viewer. Folder otwiera się tylko do odczytu. Inspector wybiera etap, klatkę, składową m oraz skalę koloru; istniejący moduł viewport-3d pokazuje zapisane pole. Solver i skrypt źródłowy nie są uruchamiane. Podgląd nie zależy od aktywnej sesji ani obecności projektu źródłowego i nie zmienia ich stanu.

Historyczne źródło jest identyfikowane przez workspace item id, rewizję manifestu, stage_id i indeks klatki. Jedynym właścicielem buforów jest warstwa zasobów; kontroler kernela przechowuje wybór UI. Geometria nie jest przebudowywana po zmianie klatki. Nie dodajemy drugiego modułu renderera ani osobnego drzewa FDM/FEM.

## Obsługiwany zapis

Pierwsza realizacja obsługuje zapis regularnej siatki FDM i pole m w formacie Zarr v2: float64 little endian, C order, układ [sample, value], value = nz*ny*nx*3, AoS xyz i X najszybszy. Jeden chunk zawiera jedną pełną klatkę. Brak kompresji/filtrów. Inne formaty są jawnie odrzucane; obecność tablicy nie pozwala zgadywać geometrii.

Folder musi zawierać jawny playback.json:

```json
{
  "schema": "fullmag.saved_playback.v1",
  "complete": true,
  "name": "Example result",
  "source_note": "Optional original publication context",
  "grid_cells_xyz": [2, 1, 1],
  "cell_size_m": [5e-9, 5e-9, 20e-9],
  "origin_m": [-5e-9, -2.5e-9, -10e-9],
  "stages": [{
    "stage_id": "propagate",
    "array_path": "yig.zarr/stages/stage_0000_propagate/fields/m",
    "times_s": [0.0, 1e-11],
    "quantity_ids": ["m"]
  }]
}
```

origin_m jest dolnym narożnikiem siatki, a centra komórek wynikają z origin+(index+1/2)*cell_size. times_s są jawną osią fizyczną w sekundach; czytnik nie przesuwa czasu automatycznie. Dla odzyskanego YIG deskryptor zawiera −4…+4 ns, chociaż solver zapisywał 0…8 ns.

Deskryptor jest addytywnym dokumentem odtwarzania: nie zmienia Zarr, manifestu uruchomienia ani receiptów. complete oznacza deklarowaną kompletność danych, nie udaną publikację native runtime. source_note zachowuje ten kontekst. Starszy zapis bez geometrii/deskryptora wymaga jawnego przygotowania opisu; wejściowy Python nigdy nie jest wykonywany do odtworzenia modelu. Automatyczne wystawianie deskryptora przez każdy writer oraz FEM/nieregularne siatki nie są kwalifikowane przez tę implementację.

## Kontrakt HTTP i klient

- GET /v2/workspace/items/{id}/playback: SavedPlaybackResource: schema, revision, name, source_note?, grid_cells_xyz, cell_size_m, origin_m i stages[{stage_id,frame_count,times_s,quantity_ids}]. array_path pozostaje prywatnym szczegółem czytnika.
- GET /v2/workspace/items/{id}/playback/frames/{frame_index}?stage_id=...&revision=...: application/octet-stream, dokładnie 3*N liczb float64 little endian. Brak tablic w statusie, bez transportu pól przez WebSocket.
- Niezgodna rewizja albo zmiana źródła podczas odczytu odrzuca odpowiedź. Brak chunku nie zwraca wartości fill ani zer.
- Wszystkie ścieżki są względne, bez symlinków i wyjścia poza wybrany folder. Limity: 16 MiB deskryptora, 64 etapy, 100000 klatek, 64 MiB na klatkę. Czas i wartości pola muszą być skończone; czas rośnie ściśle w obrębie etapu.
- Backend wykonuje I/O w blocking pool. Generated OpenAPI -> facade ControlRoomApi -> resource hooks -> dekoder -> adapter -> istniejący Canvas. Komponenty nie wykonują fetch.

## Prezentacja i cykl życia

Kolorowanie coolwarm przedstawia jedną składową m_x/m_y/m_z, bez normalizacji wektorów po odczycie. Legenda jest symetryczna: użytkownik może wybrać stały dodatni limit albo skalę automatyczną osobno dla każdej klatki. Jednostka m to 1, czas w Inspectorze to ns. Renderowana geometria zachowuje proporcje i używa µm w przestrzeni kamery.

Szybkie przewijanie anuluje stare żądanie. Stara klatka nie może pojawić się z etykietą nowego czasu. Brak aktywnej sesji nie blokuje otwarcia historycznego folderu. Canvas renderuje na żądanie, zasoby Three są zwalniane przy zamknięciu, kamera nie jest resetowana przez zmianę bufora pola.

W Docker folder musi być dostępny w przestrzeni plików backendu. Podczas kwalifikacji YIG zachowujemy oryginał i udostępniamy kopię niezmiennych danych w przestrzeni danych użytkownika grupy testowej; nie rozszerzamy mountów na inne grupy ani nie przejmujemy ich runtime.

## Kryteria odbioru

Wykonywalne testy dekodera i adaptera obejmują poprawną kolejność komórek/składowych, błędny rozmiar, NaN, skale i zmianę źródła. Testy źródeł czytnika obejmują traversal/symlinki, źródło niekompletne, rewizję, brak chunku i granice.

Wymagany dowód przeglądarkowy: rzeczywisty folder YIG, co najmniej dwie różne klatki, poprawna etykieta czasu i zmieniony kolor, niezmieniona geometria/kamera/Inspector, widoczny canvas, gl.isContextLost()==false oraz dodatnie drawingBufferWidth/Height. Typecheck, lint, testy i architecture/API hygiene pozostają osobnymi bramkami. Zakaz kompilacji testów Rust obowiązuje do osobnego odwołania i nie jest obchodzony.

Rewizja identyfikuje deskryptor, metadane Zarr i sąsiednie manifesty, nie checksum treści chunków. Odczyt wykrywa zmianę wybranego pliku w trakcie żądania, błędny rozmiar i NaN; poprawna skończona podmiana przed żądaniem nie zmienia rewizji. Pełna kontrola integralności oryginalnego YIG pozostaje w SHA256SUMS i recovery.json.
