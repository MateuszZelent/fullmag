# Replay metryk trackingu — 2026-10-02

## Zakres i wynik

Dodano rzeczywisty replay metryk wybranych krawędzi ścieżki FEM P1 Tet4.
Jest wykonywany przez scientific gate C1/A1, zamiast przyjmowania deklaracji
statusu z JSON. Nie zamyka weryfikacji przydziałów ani kwalifikacji fizycznej.

`scripts/comsol_tracking_replay.py::replay_tracking_fields` czyta widmo,
gałęzie, metadata i pola binarne z dysku. Porównuje byte hashes z bindingiem
głównej bramki. Odczyt pól odtwarza support magnetyczny, connectivity,
objętości i fingerprint siatki; pola demoduluje zgodnie z signed Bloch.

`replay_recorded_frames` sprawdza endpointy, częstotliwości i signed k.
Odtwarza masowe overlapy oraz kąty główne grup. Po degeneracji zachowuje
przetransportowaną ramę dla następnej krawędzi. Aktualizuje ramy po całej
próbce, więc kolejność uczestników nie powoduje wykorzystania bieżącej
ramy zamiast poprzedniej. Score odtwarza heurystykę producenta; nie jest
to miara residualu eigenproblem ani budżet zgodności z analityką.

## Dowody

- 36 interpretowanych testów trackingu PASS: algebra, odczyt, provenance
  i replay; 12 kontroli replayu obejmuje rzeczywistą syntetyczną ścieżkę
  z dysku, degenerację, zmienny raw ID, nieprawidłowe score i signed k,
  uszkodzone pola, niewłaściwy hash binding oraz fałszywy werdykt JSON.
- 50 istniejących i rozszerzonych testów scientific gate PASS, 68,028 s.
- 2 kontrole agregacji na końcowym wariancie bindingu PASS, 6,302 s.
- Mapa źródeł noty 0831 PASS; scoped review endpointów i transportu bez P1.
- Nie kompilowano testów natywnych; nie wykonano nowego punktu solvera.

Fixture'y są syntetyczne. Sukces testów nie dowodzi wykonania FEM,
poprawności widma COMSOL, fizycznego crossing ani zbieżności kroku k.

## Pozostałe korekty

P2: replay metryki jest niezmienniczy względem części permutacji raw IDs
wewnątrz grupy. Nie odtwarza jeszcze Hungarian branch→raw ani wyboru
kandydatów cluster/pair. Test z zamianą raw IDs przechodzi metrykę,
ale zachowuje `assignment_replay=NOT VERIFIED`. Bramka główna wymaga
osobnego assignment replay; jego brak zawsze blokuje `QUALIFIED` C1/A1.

Kolejny etap: odtworzyć rotację i optimum przypisań z pełnego zbioru
kandydatów, sprawdzić permutacje i grupowanie oraz pokrycie kandydatów
rzeczywistymi polami. Nie zastępować tego sortowaniem częstotliwości.
Replay obecnie dotyczy pełnej ciągłej ścieżki C1/A1: brak/gap/restart
jest błędem, a nie zgodą na pominięcie krawędzi.

Runtime pozostaje zablokowany przez storage. #196 jest queued; ostatni
pomiar 729 821 184 B jest poniżej progu 8 GiB. Source capsule #196 pozostaje
niezmienna i nie zawiera tych późniejszych poprawek replayu.
