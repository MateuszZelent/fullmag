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

## Dowody checkpointu fe28cb31d

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

Lokalna część P2 jest naprawiona: replay odtwarza wagi przypisania
z rotacji Procrustesa i niezależny Hungarian sprawdza optimum branch→raw
wewnątrz wybranej grupy. Jednoznacznie gorsza permutacja jest odrzucana.
Równoważne optima są dopuszczalne w tolerancji średniej wagi 1e-9
i jawnie raportowane wraz z odczytanymi/optymalnymi raw IDs.

Regresja unikalnej złej permutacji była RED na źródłach
`fe28cb31d6ca9edc0158d73488861bf4845a1ae8`; po poprawce jest GREEN.
Aktualnie 45 interpretowanych testów trackingu PASS. Optymalizator sprawdzono
na 80 macierzach względem niezależnej enumeracji permutacji, znanym dużym
optimum i wagach 1e-300. Zespolona rotacja 3×3 o niesymetrycznych modułach
chroni orientację previous-row/current-column. 2 regresje agregacji gate
oraz focused source-map PASS. Review nie znalazł blokera implementacji;
wskazany brak testu transpozycji i nieaktualny status zostały poprawione.

Pozostaje wybór kandydatów cluster/pair i globalne przypisanie krawędzi.
`subspace_raw_assignment_replay=pass` nie zastępuje pełnego
`assignment_replay`, który nadal pozostaje NOT VERIFIED. Bramka główna
utrzymuje osobny brak assignment replay i blokuje `QUALIFIED` C1/A1.

Kolejny etap: odtworzyć globalny wybór/przydział z pełnego zbioru
kandydatów, sprawdzić grupowanie oraz pokrycie kandydatów
rzeczywistymi polami. Nie zastępować tego sortowaniem częstotliwości.
Replay obecnie dotyczy pełnej ciągłej ścieżki C1/A1: brak/gap/restart
jest błędem, a nie zgodą na pominięcie krawędzi.

Runtime pozostaje zablokowany przez storage. #196 jest queued; ostatni
pomiar 720 535 552 B jest poniżej progu 8 GiB. Source capsule #196 pozostaje
niezmienna i nie zawiera tych późniejszych poprawek replayu.
