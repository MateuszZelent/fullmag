# Zapisane pole anteny: wybór danych i weryfikacja frontendu — 27.10.2026

## Cel i granica dowodu

Ułatwić wybór zapisanych V/J/H oraz sprawdzić rzeczywisty tor danych używany przez viewport. Nie uruchamiano kolejnego Solve. Ten checkpoint nie zamyka E0–E12 ani nie stanowi niezależnej kwalifikacji fizyki.

Bazowy commit przed tym fragmentem: `18d24312ee0d91bdbb0de43dc29c551ce54eb2fe`.
Grupa Docker: `fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1`.
Weryfikacja odbyła się w istniejącym kontenerze frontend tej grupy, z API backendu tej samej grupy.

## Zmiana listy wyników

Lista Saved Results wyświetla kanoniczny `descriptor.quantity_id`, jednostkę i pokrycie próbkami przed Inspect. Nie rozpoznaje fizyki po nazwie artefaktu. Lokalna strona obejmuje najwyżej cztery pola; dotychczasowa strona artefaktów i niezależna obsługa wyników skalarnych pozostają zachowane. Każdy widoczny wiersz ma jednego właściciela metadanych, używanego również do przypięcia Inspect. Zmiana nie wprowadza alternatywnego API, magazynu zasobów ani renderera.

## Kontrole poprawki UI

- 16/16 nowych montowanych regresji: etykiety H/V/J, maksymalnie czterech właścicieli metadanych, paginacja bez utraty pól, brak dodatkowego odczytu po Select/Inspect, błędny owner/path/artifact/digest i stan loading/error/refreshError.
- Pozostałe 70 testów modułu przeszło. Pierwszy pełny przebieg miał 85/86: jedna asercja testu oczekiwała starego aliasu `H_antenna` po aktualizacji fixture do kanonicznego `H_ant`. Poprawiono wyłącznie asercję i ponowiono cały zmieniony plik: 16/16. Nie przedstawiamy pierwszego pełnego przebiegu jako zielonego.
- Kontrola typów, lint zmienionych plików i architektura: exit code 0.
- Nie kompilowano testów jednostkowych Rust i nie przebudowywano backendu dla tej zmiany frontendowej.

## Rzeczywisty zapisany wynik

Projekt: `project-1f48487cf16342ca9524e0795d39597b`.
Run: `run-5654db21201dd6c660f7ecae78baf8588477fe2a7d90480d9d64b30e4d050080`.
SolutionSet: `recovered-solution-82e8f2e82ae2989cdd17519be89552b34085aa792e9d47b46285797bd9a1687a`, rewizja 1.
Member: `member-3b95b7b2e4db7105c0882033765b478eee4060e53896a127af2130f793d2620f`.

Oryginalne wykonanie zachowuje **Failed**, a ocenę naukową **Unassessed**. Odzyskanie zakończonych danych obliczeń nie oznacza zmiany statusu zadania na sukces ani zakwalifikowania bazy do sprzężenia z LLG.

| Pole | Jednostka | Próbki | Składowe | Tet4 domeny | Utworzone glyphy |
|---|---|---:|---:|---:|---:|
| H_ant | A/m | 1145 | 3 | 6428 | 1145 |
| V_electric | V | 677 | 1 | 1856 | 0 |
| J_charge | A/m² | 7424 | 3 | 1856 | 2048, istniejący limit renderowania |

Próbki J są lokalnymi próbkami elementów: cztery węzły dla każdego z 1856 Tet4; liczba 7424 nie oznacza 7424 niezależnych globalnych węzłów przewodnika. Limit glyphów J dotyczy prezentacji, nie zapisanych danych.

## Co faktycznie uruchomiono

Weryfikator ładuje aktualne moduły aplikacji i wykonuje bez mocków:

1. Odczyt metadanych przez `ControlRoomApi.persistence.projects.materializedDataset`.
2. Montaż prawdziwego `useSavedFieldViewportResources` w istniejącym testowym środowisku React.
3. Rzeczywiste żądania geometrii, topologii, supportu i FMDS; dekodery oraz bramki tożsamości produkcyjnego klienta.
4. `buildSavedFieldViewportSceneModel` na otrzymanych danych.
5. Porównanie wszystkich surowych wartości f64 z przypiętymi SHA256 wyniku producenta, sprawdzenie skończoności, liczby próbek, składowych i jednostek.
6. Sprawdzenie buforów skali kolorów, liczby strzałek i odrzucenia obcego layoutu; SSR bez żądań oraz brak powtórnych żądań podczas 250 ms bezczynności.

Wynik: **PASS**, exit code 0. Każde pole wymagało dokładnie pięciu GET: metadane, geometria, topologia, support i slice. Łącznie 15 odpowiedzi 200 z jednej instancji API `eb961129-ee95-452d-9e7f-2dd3560c46b9`.

Atrybut `scalarValues` GPU zawiera znormalizowaną wartość koloru, a nie surowe H. Weryfikator porównuje ten atrybut z normalizacją fizycznej wartości w zachowanym zakresie; największy błąd bezwzględny wyniósł poniżej `2.98e-8`. Surowe f64 pozostają niezmienione. Zakres |H| wyniósł 2343.7042903279566–298473.635519647 A/m.

Pierwsze dwie próby technicznego weryfikatora zachowano: pierwsza błędnie oczekiwała loading zamiast idle pola podczas SSR, druga traktowała znormalizowany atrybut GPU jako surową wielkość fizyczną. Poprawiono założenia weryfikatora po odczytaniu kontraktu; nie zmieniano kodu aplikacji ani tolerancji solvera.

## Artefakty dowodowe i odtworzenie

W wolumenie frontend tej grupy:

- `/state/development/verification/saved-field-real-client-20261027/verify.mjs` — rzeczywisty weryfikator;
- `report.json` — udany przebieg, SHA256 `3109e0e756601507a84f12dcfed0c43e75c2f0b92c3a5081c1b7fd3fe42b2ad9`;
- `source-pins.json` — hashe pięciu modułów i weryfikatora;
- `report-attempt-01.json`, `report-attempt-02.json` — zachowane wcześniejsze próby;
- `/state/development/verification/saved-field-row-labels-20261027/` — regresje i review listy pól.

Powtórzenie w istniejącym kontenerze frontend, z katalogu `/state/development/workspace/apps/control-room`:

```sh
node /state/development/verification/saved-field-real-client-20261027/verify.mjs
```

Odczyt wymaga dostępnego, tego samego zapisanego wyniku w backendzie tej grupy. To diagnostyka klienta i adaptera, bez tworzenia nowej usługi i bez kompilacji solwera.

## Obrazy i brakująca kontrola UI

Przygotowane wcześniej wykresy pochodzą z tych zapisanych danych:

- `D:/git/fullmag/exports/antenna-field-20261027/pole-oersteda-3d.png` — widok 3D, 321 z 1145 próbek H, stała długość strzałki i kolor |H|;
- `D:/git/fullmag/exports/antenna-field-20261027/pole-oersteda-przekroj-v2.png` — przekrój x=1.0024 µm, interpolacja wyłącznie w zapisanych Tet4; linie pokazują rzut H na płaszczyznę przekroju.

Są to wykresy naukowe, **nie screenshoty UI**. Narzędzie przeglądarki zgłaszało timeouty sterowania kartą; nie uzyskano zrzutu ani potwierdzenia widocznego canvasu, stabilnego kontekstu WebGL i niezerowego drawing buffer. Testowe środowisko React również tego nie dowodzi. Kontrola wizualna listy pól i rzeczywistego viewportu pozostaje **NOT VERIFIED**. Nie wnioskować z tej ograniczonej obserwowalności, że sam renderer jest uszkodzony.

## Dalszy krok

Po przywróceniu sterowania przeglądarką wybrać Results → Saved → wskazany run → odzyskany SolutionSet rev1 → member → H_ant [A/m] → Inspect pinned dataset. Wykonać kontrolę canvas/WebGL i dwa rzeczywiste screenshoty: cały Universe z czytelnymi wektorami oraz przekrój. Osobno pozostaje kwalifikacja clippingu zapisanego nośnika i niezależna walidacja fizyki.
