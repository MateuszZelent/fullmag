# Projektowy zapis wyników — 2026-10-04

Cel: formularz nowej symulacji i Python opisują tę samą politykę katalogu wyników, prywatnego tmp i formatu danych. Ograniczenie użytkownika: nie kompilujemy ani nie uruchamiamy unit tests.

1. Typowana polityka `output_storage`: Python `study.storage(...)` → `ProblemIR.problem_meta.runtime_metadata.output_storage` ↔ `SceneStudyState.output_storage` → eksport Python.
2. Właściciel runtime rezerwuje nowy katalog, tworzy oznaczony prywatny tmp i publikuje receipt. Domyślnie czyści tmp po sukcesie; zachowuje go po błędzie. Nigdy nie usuwa wyników ani wybranego rodzica tmp. Kolizja generuje nową nazwę albo kończy się jawnym błędem.
3. Zasób `platform/output-storage`: domyślne rodzice katalogów, format i sprzątanie w istniejącym `workspace.db`, z dostępnymi formatami rzeczywistego buildu. Nie dodajemy browser localStorage dla ustawień kanonicznych.
4. Formularz: nazwa/podpowiedź, FEM/FDM, katalog wyników, tmp, format, sprzątanie, kolizje, zapis preferencji, podgląd rzeczywistych ścieżek. CPU/double przedstawione jako obecnie obsługiwany profil. Tworzenie sesji, dokumentu i późniejszy zapis mają odrębne stany ACK/retry.
5. Bramka: interpretowane sprawdzenie Python lower/export, produkcyjne TypeScript i ESLint, przeglądarka w jasnym/ciemnym motywie i małym oknie, managed build runtime bez unit tests, dowody katalogów/formatu/tmp. Po domknięciu bieżących operacji i scoped commicie scalamy zmiany lokalnie na `master`, zgodnie z jawnym poleceniem użytkownika. Dalszą implementację i dowody runtime wykonujemy bezpośrednio w głównym checkoutcie. Nie kompilujemy testów jednostkowych także w CI.

Właściciele zmian: rodzic — filesystem lease/safety, formularz, facade, dokumentacja i integracja; worker `creation_storage_contract` — Python/CLI; worker `output_storage_api` — IR/authoring/API/baza; worker `new_problem_browser_proof` — cztery nowe pliki bramki przeglądarkowej. Buildy i staging wyłącznie rodzic. Bazowy commit: c8936c7fe4ac375c76d03bbe81a42a435d9b6886.


## Checkpoint 04.10.2026

- Formularz i klient: produkcyjny browser fixture 54/54, TypeScript bez źródeł testowych,
  ESLint bez ostrzeżeń i React Doctor changed-scope zakończyły się kodem 0.
  Receipt: `storage/builds/new-simulation-form-20261004-31aa3b4f873195d6/windows-control-room-browser-fixture/new-problem-browser/ed88f63ea7b44ccfbccd3d0c2a6f2e6a/receipt.json`.
- OpenAPI oraz klient zostały wygenerowane zarządzanymi trasami. Końcowy codegen klienta:
  `storage/builds/new-simulation-form-20261004-31aa3b4f873195d6/windows-control-room-browser-fixture/new-problem-client-codegen/9447ad33b2f64fcab248aecfc7707be6/receipt.json`.
- Interpretowany Python lower/export/round-trip: `scripts/check_output_storage_contract.py`, exit 0.
- Review objął odmowę dowiązań, prywatne uprawnienia tmp, no-write preflight ścieżek
  i trwały zapis odmowy storage przed skutkiem solvera. Końcowy source check oraz runtime
  pozostają oddzielnymi bramkami; nie są dowodem kwalifikacji FEM/GPU/HDF5.
- Jawna dyspozycja użytkownika: po bieżących operacjach merge na master, następnie praca
  na masterze. Nie zakładamy kolejnego worktree dla kontynuacji.
- Python multi-stage chroni istniejący root i manifest przez exclusive creation;
  na masterze domknięto `timestamp` dla całego root, zachowanie wcześniejszych danych
  oraz odmowę `..` przed zapisem. Interpretowany regression check przeszedł.
  Commit: `80e2b612e9075035ee386ac8dd89d3a809bbf6c9`.
  Native CLI używa wspólnego lease dla całego projektu.

- Końcowy produkcyjny API source check: exit 0, `state=passed`, bez kompilowania testów.
  Receipt: `storage/builds/new-simulation-form-20261004-31aa3b4f873195d6/windows-api-source-check/api-source-check/77f0fe1001e9493b9697e0fb522b980e/receipt.json`.
  Próba zapisu rzeczywistych wyników pozostaje osobną bramką runtime.

- Lokalna integracja: commit `ea53fab1b8f7b03465074c9a97603022bbf08045`, merge na master
  `eae25cc2b393f78e7ff0e9da727344f08c62ee41`. Dalsze zmiany wykonujemy w głównym checkoutcie.
  Nie wykonano push ani integracji remote.
- Produkcyjna kontrola CLI/PyCore/desktop na masterze: exit 0, `state=passed`,
  `source_changed_during_run=false`; nie kompilowano testów jednostkowych.
  Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/windows-project-entrypoint-check/project-entrypoint-check/9787e4eb166343978927e0e6d4309413/receipt.json`.

## Naprawa uruchomienia Windows

- Odtworzono błąd `ENOENT` ze zgłoszonego logu: wcześniejsza publikacja kopii źródeł
  usuwała importowany plik przed ponowną próbą podmiany. Nowa publikacja zachowuje
  poprzedni plik podczas przejściowej blokady Windows. Nie usuwa też pliku, który
  powrócił w źródłach po wykonaniu snapshotu.
- Interpretowana bramka odtworzyła lukę na wcześniejszej wersji i przeszła cztery
  kontrole poprawki: krótka i trwała blokada, nieaktualny snapshot usunięcia oraz
  aktualizacja po zwolnieniu blokady. Bez kompilowania unit tests.
  Kontrola składni Node i ESLint zmienionego modułu także zakończyły się kodem 0.
  Dowody: `storage/tmp/dev-source-publication/5c773979c66b445fb5526f7e078675f9/baseline.json`
  i `publication.json` w tym samym katalogu.
- Guard zmienionych zależności Python wymaga zamknięcia poprzedniego workspace
  i nowego buildu; nie obchodzimy zamrożonej tożsamości zależności.
- `windows-runtime-recover 3197` odmówił działania z powodu wcześniejszego API
  PID 249132, bundle `3ce0f1a6852543eabc545bbc08da369b`. Solver jest bezczynny,
  model sesji `session-18db45d639cc30f00003cd2c` ma revision 3 i został zachowany
  wraz z digestami w `storage/runs/diagnostics/native-recovery/3cbcebd24c384428b1341c98a77452a6`.
  Pytanie o zatrzymanie tego konkretnego procesu jest oczekujące. Pełny rebuild
  i nowy start pozostają `NOT VERIFIED` do bezpiecznego odzyskania uruchomienia.
