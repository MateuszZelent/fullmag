# Jednokrotny odczyt dowodu zwolnienia zasobów — 26.10.2026

## Problem i zmiana

Walidacja dokumentu ledgera powtarzała walidację dowodu Released przed
kontrolą epoki, a sama kontrola epoki ponownie czytała JSON. Dawało to do trzech
odczytów i dwóch pełnych walidacji tego samego dowodu na rezerwację i snapshot.
`read_validated_release_proof` zwraca teraz obiekt po pełnej dotychczasowej
walidacji. Wrapper `validate_release_proof` zachowuje Result<()> pozostałych
konsumentów. Kontrola epoki i dokumentu wykorzystuje ten sam zweryfikowany obiekt.

Nie zmieniono schematu, polityki, modelu rezerwacji, zakresów tożsamości ani
warunków odrzucenia. Nie ma cache między iteracjami. Każda kolejna walidacja
czyta aktualny plik i ponownie sprawdza digest oraz wszystkie powiązania.

## Weryfikacja

- `python3 -B scripts/check_release_proof_single_read.py`: 11 kontroli
  źródłowych PASS względem caad5331841d7895e8b124719746579d1cff7db3.
  Porównanie obejmuje zachowanie treści wszystkich gałęzi walidatora; nie jest
  testem wykonania uszkodzonych dowodów.
- Niezależny przegląd źródeł: bez blockerów, sprawdzony również Copy dla rodzaju
  dowodu i zgodność Result<()> dotychczasowych konsumentów.
- Zarządzany build i start: `just docker-dev-restart-idle` z pierwotną próbą
  aa0121dc39f84ebfa89b804f13881921, konfiguracją
  5ae11c7ec51fbc05cebde982e3b7281f82e5318d23d6765ab136d45302b33fb6,
  worktree zadania, portem 3203 i allow_prepared_session=true; exit 0.
- Iteracja de82bcc9229548cd999efcb7b7338d71: succeeded. Snapshot faktycznie
  zbudowanych źródeł: 3b8996049e6e1960fde6c36e2cca716c72c116c18245b4922c3a30294bd3cc85.
  Biblioteka native: 22c08a0585a5511d6737b9d429de180b9f22bdf4ed249382665ed7c42815c909.
- Te same kontenery backend/frontend i cache. Scena przywrócona przez publiczny
  import visualization_only, HTTP 200, dokładnie zgodna z zachowanym FMS;
  bez nowego Solve.
- Archiwalne V/J/H po cold-load: metadata, geometry, topology, support i slice
  HTTP 200, wszystkie binaria identyczne ze stanem sprzed restartu.
  V: 678 próbek, J: 7460 próbek po 3 komponenty, H: 14 próbek po 3 komponenty.
  Zakres slice pochodzi z coverage.total_elements, komponenty są osobne.
  Pierwszy pomocniczy odczyt błędnie pomnożył zakres J przez komponenty i dostał
  prawidłową odmowę 400; poprawiono skrypt diagnostyczny, nie kontrakt API.

## Pomiar i ograniczenia

Trzy odcinki po około 5 s, bez workera naukowego, z niezmienionymi 33 intentami
(23 616 441 B): runtime średnio 9,99%, compute 94,59%, preparation 55,56% jednego
rdzenia. Wcześniejszy pojedynczy pomiar wynosił odpowiednio 16,78%, 93,68% i 65,32%.
To obserwacja ograniczonego usprawnienia, nie statystyczna kwalifikacja wydajności.
Idle CPU nadal jest nadmierne. Compute weryfikuje duże captured source dwóch
starszych accepted runów; dalsza naprawa wymaga osobnego pomiaru i zachowania
pełnych strażników admission/CAS. Nie zdejmowano blokad ani nie usuwano historii.

Nie kompilowano testów jednostkowych. Nie wykonano nowych testów odmowy na
celowo uszkodzonym ledgerze. Nie wykonano nowego Solve, pełnego Universe,
bazy pola ani kwalifikacji naukowej zmienionego pakietu. Odbiór UI/WebGL nie
jest częścią tej poprawki i pozostaje otwarty w głównym planie E0–E12.

## Dowody i retencja

W wolumenie kontrolnym grupy zadania:
`verification/antenna-release-proof-single-read-20261026/` zawiera zachowanie
sceny przed buildem, odpowiedź importu, potwierdzenie odtworzenia, idle-cpu-after
oraz saved-vjh-cold-http. Receipt:
`iteration/attempts/de82bcc9229548cd999efcb7b7338d71/terminal.json`.
Brak skilla fullmag-build-stage-cleanup: zastosowano reguły governance.
Zachowano wszystkie wyniki, historię, receipty, obecny i rollback pakiet oraz
cache. Niczego nie usunięto. Ponowna ocena retencji po odbiorze całego etapu
oraz potwierdzeniu, że starsze pakiety nie są potrzebne do rollbacku.


## Uzupełnienie: rzeczywiste obliczenie nowego pakietu po commicie

Po zapisaniu poprawki wykonano jedną nową próbę przez publiczne API, z dokładnie
zachowanymi wejściami fizycznymi i blokadą ponowienia:
`run-antenna-release-proof-20261026-01`, task
`task-bc5bac4afdc77341761b1aef4ec3fceaf4ff1e8d324efff9f996c7f67044af39`,
attempt `attempt-a3cf2ec7130045e7b75f21a1ce8e9026`, epoch 1. Stan Succeeded,
obserwator i porównanie exit 0. Bundle:
`6bacf94351693955f5b97ab7485613e5a23cc29e835ffaf02527cdb6389e0ca4`.
Wszystkie 21 payloadów naukowych są identyczne z referencją
`0c6d035aa25b2cf9dddf9794b4609ccbe9662efb0ca3a99175a4edd217fae1bf`.
Pełne diagnostyki binary64/80/120 i liczniki pracy są zgodne po wyłączeniu
pomiarów czasu/RSS. Profil ma dziewięć faz, dokładną sumę czasu i nie zgłasza
accounting_issue. Receipt SHA256:
`7373d691953aa597b0cb5e8d1affc5f496a7993a4e31fa3f4f7d7ae84312184f`.

Operator: 363,113 s; całe działanie: 437,958 s. Fazy wysokiej precyzji:
112,266 s i 194,390 s, łącznie około 84,5% native operatora. Dokładna geometria:
31,339 s; consistency: 19,394 s. Nie deklarować przyspieszenia z pojedynczego
porównania. Krótka próbka aktywnego workera: około 125% CPU przy limicie 3 CPU,
brak throttlingu w tej próbce; nie jest to kwalifikacja całego czasu wykonania.

Dowody tej próby w podkatalogu `on/` katalogu kontrolnego tego raportu:
submit-request/response, materialization, run-latest, output-catalog,
verified-profile-receipt i comparison. Osobno `active-worker-cpu.json`.
Zakres naukowy pozostaje ograniczony: 14 targetów, nie pełny Universe.
Nie uzyskano jeszcze kwalifikowanej bazy pola, sprzężenia LLG ani odbioru UI.
