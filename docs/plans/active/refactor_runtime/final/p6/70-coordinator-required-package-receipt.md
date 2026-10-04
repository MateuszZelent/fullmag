# P6-70 — jednolity odbiór kompletnego pakietu przez koordynator

## Problem

P6-68/P6-69 uzupełniły wymagania entrypointu buildu o dziewięć binariów
accepted flow. Koordynator `build_executor.validate_build_receipt` nadal
sprawdzał tylko pięć bazowych outputów. W konsekwencji receipt ze statusem
`succeeded`, poprawnymi hashami, lecz bez accepted runtime mógł przejść odbiór.
Ten sam walidator jest konsumentem w natywnej kwalifikacji archiwum FEM.
Hash pustego pliku również nie dowodzi gotowego obowiązkowego artefaktu.

## Zmiana

- `build_entrypoint.py` definiuje wspólne `BASE_REQUIRED_OUTPUTS` i pełne
  `REQUIRED_OUTPUTS`; koordynator importuje te same kontrakty zamiast utrzymywać
  drugą listę release outputs.
- Trzy profile release: FDM CPU, FEM CPU, FEM GPU wymagają w receipt wszystkich
  14 outputów — pięć bazowych oraz dziewięć binariów accepted flow.
- Pozostałe istniejące profile specjalistyczne zachowują wcześniejszy zestaw
  pięciu bazowych outputów. Przyrost nie nadaje im kwalifikacji wydania.
- Wymagany plik musi występować w receipt, mieć zgodny rozmiar i hash oraz być
  niepusty. Istniejące kontrole ścieżek i provenance pozostają w odbiorze.
  Puste opcjonalne logi są dozwolone.
- `verify_saved_fem_archive_roundtrip.driver_identity` obejmuje teraz również
  `local_runner/build_entrypoint.py`, nową zależność kontraktu odbioru.
  Zmiana tej zależności jest widoczna w kontroli niezmienności kodu drivera.

## Dowody źródłowe

| Kontrola | Wynik |
|---|---|
| Baseline receipt bez accepted runtime | FAIL regresji dla wszystkich trzech profili: dawny kod akceptował brak |
| Baseline pustego obowiązkowego pliku ze zgodnym hashem | FAIL regresji: dawny kod akceptował pusty CLI |
| Koordynator i entrypoint po poprawce | 34 testy `unittest` PASS, exit 0 |
| Osobna regresja każdego binarium w receipt | PASS — 27 przypadków: 9 binariów × 3 profile |
| Kompletny receipt z pustym opcjonalnym logiem | PASS dla trzech profili, w powyższej bramce |
| Baseline driver identity | FAIL regresji: brak nowej zależności w tożsamości |
| Konsument archiwum po uzupełnieniu identity | 32 testy `pytest` PASS, exit 0 |
| Niezależny source review i follow-on identity | PASS — brak P0/P1, potwierdzony brak cyklu importów |

Kontrole wykonano 02.10.2026 przez Python z `-B` i
`PYTHONDONTWRITEBYTECODE=1`; pytest z wyłączonym cache providerem.
Nie kompilowano testów Rust/native i nie wykonywano buildu solvera.
Wynik 34 obejmuje moduły koordynatora i entrypointu; osobny test 27 braków
uruchomiono po rozszerzeniu pokrycia. Regresje archiwum wykonano przez pytest,
a nie przez `unittest`, który nie zbiera tych funkcji testowych.

## Granice

Zmiana jest dowodem kontroli źródłowej. Nie wdraża nowego koordynatora ani
trusted entrypointu, nie uruchamia joba i nie usuwa danych. Następny managed
build musi mieć niezmienną tożsamość źródeł, terminalny receipt, właściwy hash
trusted kodu i wszystkie wymagane artefakty. Runtime, archiwum na rzeczywistym
accepted FEM dataset, nauka i clean-install release pozostają **NOT VERIFIED**.

Przyrost nie uzasadnia podniesienia procentu pełnej kwalifikacji P6 ani
zamknięcia P6-60/P6-61. Nadal oczekuje osobna zgoda na dokładne cele cache
z P6-67 przed zwolnieniem pojemności runnera.
