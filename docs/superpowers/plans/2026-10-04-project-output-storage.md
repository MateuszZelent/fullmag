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
  obsługę `timestamp` dla całego root należy domknąć na masterze przed uznaniem pełnej
  zgodności polityki wieloetapowej. Native CLI używa wspólnego lease dla całego projektu.

- Końcowy produkcyjny API source check: exit 0, `state=passed`, bez kompilowania testów.
  Receipt: `storage/builds/new-simulation-form-20261004-31aa3b4f873195d6/windows-api-source-check/api-source-check/77f0fe1001e9493b9697e0fb522b980e/receipt.json`.
  Kompilacja CLI/PyCore/desktop oraz próba zapisu rzeczywistych wyników pozostają do weryfikacji na masterze.
