# P5-C — izolowany rdzeń `ObservationRuntime`

Data: 29.09.2026

Status: **SOURCE CHECK PASS / RUNTIME QUALIFICATION NOT RUN**.

## Wynik

Runner ma pierwszy backend-neutralny rdzeń `ObservationRuntime` dla jednej
immutable ramki obserwacji. Konstrukcja przejmuje własność ramki i nie otrzymuje
uchwytu do `LiveRuntime`, publishera ani ścieżki komend. Publiczna powierzchnia
rdzenia zawiera wyłącznie odczyt źródła, listę cache i atomowe
`compute_quantities`.

Przed uruchomieniem evaluator sprawdza:

- kompletny `AcceptedStateId` oraz bitowo zgodny `ObservationClock`;
- `state_digest` wyliczony ponownie z kompletnej listy kanonicznych primary
  carriers;
- rozmiar gridu, maski, magnetyzacji i nazwanych pól oraz skończoność danych;
- zgodność zegara scalar row;
- niepusty, bezduplikatowy allow-list quantity ustalony przez adapter lane'u.

Żądanie musi wskazać dokładny `AcceptedStateId`. Lista quantity jest
bezduplikatowa i w całości dostępna dla źródła. Wyniki są sprawdzane względem
kanonicznego katalogu, oczekiwanego shape/komponentów oraz skończoności. Cache
jest aktualizowany dopiero po poprawnym wyliczeniu całego batchu; błąd jednej
quantity nie publikuje częściowego wyniku.

## Weryfikacja

- `cargo check -p fullmag-runner --lib`: **PASS**;
- `git diff --check`: **PASS**;
- zapisano trzy regresje jednostkowe: poprawny batch/cache, obce źródło i brak
  częściowego commit, niezgodność primary carriers ze `state_digest`;
- regresji jednostkowych nie budowano ani nie uruchamiano zgodnie z tymczasową
  regułą repozytorium zakazującą kompilacji testów jednostkowych.

## Granica dowodu

Ten przyrost nie ładuje jeszcze autosave frame z CAS, nie rekonstruuje operatorów
FDM/FEM, nie zapewnia admission/lease dla GPU i nie publikuje zasobu HTTP v2.
Nie jest dowodem `ComputeQuantities` w żadnym lane, historycznego readbacku,
managed runtime, browsera ani nauki. Adaptery lane'ów muszą dostarczyć pełny
allow-list i wszystkie pierwotne nośniki; brak carriera pozostaje błędem.

P5 rośnie do **97%**. Cały plan pozostaje około **49%**.
