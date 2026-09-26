# Trwały receipt wykonania workera i wznowienie publikacji — 25.09.2026

## Zmiana

Accepted worker zapisuje immutable receipt `started` przed uruchomieniem solvera.
Wiąże on pełny claim/lease, identyfikator i sekwencję komendy `Start`, case oraz
fingerprint planu. Plik powstaje wyłącznie raz w prywatnym katalogu konkretnego
attempt/epoch; brak receipt-u albo receipt niezgodny z bieżącym Start blokuje
ponowne wykonanie.

Po zakończeniu runnera API przechodzi przez dotychczasową allow-listę, zapisuje
typed payloady do CAS i publikuje immutable receipt `completed` z ich portami,
case, codecami, SHA-256 i rozmiarami oraz statusem i liczbą kroków. Gdy proces
próbuje wznowić ten sam pending Start dla istniejącego katalogu, helper wymaga
zgodności obu receiptów z bieżącym claimem i planem, ponownie waliduje dokładny
zestaw deklarowanych portów, odczytuje CAS z kontrolą hashy i dekoduje payloady.
Zwraca zapisane wyniki bez ponownego uruchomienia solvera.

Regresja API wywołuje helper drugi raz po rzeczywistym przebiegu FDM CPU, ale
przed publikacją outputów do study catalogu. Drugi odczyt używa nowego uchwytu
`SessionStore`. Porównuje bajty wyników i potwierdza
odzyskanie z receipt-u, a następnie w fixture usuwa receipt ukończenia i
potwierdza odmowę replay dla niepewnego attemptu. Pierwsza publikacja może
dokończyć zapis i terminalny barrier bez powtórnego obliczenia.

## Weryfikacja

- `just verify-api-project-runs`: **6 passed, 0 failed, 2 ignored**, receipt
  `166e583a00154010bdb56f9537fd803a`; `source_changed_during_run=false`.
- `just check-api-source`: **PASS**, receipt
  `50ab5033dddc4cacbe39bec14b6ec495`; `source_changed_during_run=false`.
- `rustfmt --edition 2021 --check` adaptera: **PASS**.
- Wspólny checker repozytorium, linki checkpointu i scoped `git diff --check`:
  **PASS**; jedyne wyjście diff check to znane ostrzeżenie LF/CRLF dla dwóch
  szeroko zmienionych dokumentów planu.

## Granice

Jeśli istnieje tylko receipt `started`, brakuje receipt-u ukończenia albo CAS
jest uszkodzony/niekompletny, helper odmawia replay. To fail-closed zachowanie
zapobiega drugiemu side effectowi, ale wymaga osobnego production supervisor
do rozpoznania procesu, oznaczenia attemptu jako niepewnego i obsługi operatora.
Nie ma jeszcze rzeczywistego procesu workera ani transportu, testu po restarcie
procesu/power loss, fizycznego zwalniania zasobu ani walidacji naukowej. CAS
może zawierać przypięte obiekty przed zapisem receipt-u ukończenia; osierocony
pin wymaga późniejszego reconciliation/GC. Power-loss durability katalogu na
Windows pozostaje **NOT VERIFIED**; receipt-y nie kwalifikują globalnego
limitu katalogu outputów.

Procenty bez zmian: **P3 50%, cały plan około 27%**. Kolejny krok to production
supervisor/transport, który odzyskuje receipt-y po restarcie, utrzymuje lease,
zamyka completion barrier i nie ponawia niepewnego side effectu.
