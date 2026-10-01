# Review tożsamości liniaryzacji i diagnostyki kwadratury

Data: 2026-10-01. Baza: `abbd0c451`; oceniane zmiany są lokalnym przyrostem
worktree `eigensolve-dispersion-plan-20260912`, poza kapsułą buildu #193.
Zakres: R4, publikacja kwadratury F01 oraz niezależny replay Python.

## Wynik i granice dowodu

Review źródeł nie zamyka R4 ani walidacji dyspersji. Nie kompilowano testów
natywnych. Build runtime-only #193 nadal czeka za aktywnym #192; jego źródła
nie zawierają tego przyrostu. Pełny plan S00–S12 pozostaje obowiązujący.

| Problem | Priorytet i trigger | Stan oraz konkretna naprawa |
|---|---|---|
| Brak własnego exact preimage identity | P1: digest powstaje z kompaktowego `serde_json::to_vec` po wyzerowaniu `content_sha256`, publikowany JSON jest inną reprezentacją | Potwierdzony. Addytywny `linearization_identity_preimage.v1` ma zachować dokładne bajty, raw SHA-256 i framed digest. Python musi sprawdzić również zgodność wszystkich wartości z opublikowanym identity. |
| Brak identity w non-shared Floquet | P1: `eigen_native_window.rs` przekazuje brak state/handoff do publikacji, choć wykorzystano stan relaksacji | Potwierdzony przez niezależne review; wymagane przekazanie stanu i certyfikatów lub jawny brak kwalifikacji. Nie można nazywać tej ścieżki pełnym R4. |
| Rekonstrukcja danych producenta w bieżącym procesie | P1/P2: `from_exact_artifacts` przypisuje aktualny `build_identity_json()` bez transportu historycznej tożsamości producenta | Otwarte: sprawdzić faktyczną dostępność importu między runami. Kontrakt importu musi przenosić producer build/source-plan metadata; bieżąca tożsamość nie może zastępować nieznanej. |
| Null operator input signature w non-shared Floquet | P1: manifest nie wiąże rzeczywistych wejść operatora | Otwarte. Przekazać produkcyjną sygnaturę wraz z dokumentowanym zakresem; porównywać punkty poza jawną zmianą k. |
| Niepełne wiązanie semantyki dynamicznej | P2: statyczne identity pomija damping zgodnie z fizyką, lecz modal identity nie jest użyte produkcyjnie | Otwarte. Związać damping policy, k, Floquet boundary i operator przez modal identity. Damping relaksacji 0,5 i eigen 0 nie może sam zmieniać statycznej tożsamości. |
| Zagnieżdżony klucz tłumi eksport kwadratury | P2: `.find("shared_domain_operator_provenance")` traktuje nested klucz jako top-level | Potwierdzony. Zastąpić sprawdzaniem top-level lub kontrolą publikacji; regresja z nested `operator_diagnostics_json`. |
| Końcowe whitespace i nieprecyzyjna dokumentacja append JSON | P2: helper wymaga ostatniego znaku `}`, a opis obiecuje więcej niż sprawdza kod | Naprawa wspólnie z eksportem: jawny kontrakt parsowania i zachowania błędów; regresja trailing whitespace. |

## Potwierdzone właściwości źródeł

- Exact accepted/certified/recomputed bytes są zachowywane i wiązane z typowanymi
  payloadami; główna ścieżka używa zweryfikowanego handoff.
- Statyczne sygnatury fizyczne są oddzielone od raw material provenance.
- Kwadratura jest agregowana w tej samej pętli magnetycznych elementów co digest;
  `GetOrder()` i `GetNPoints()` pochodzą z MFEM, bez stałej liczby punktów.
- Agregacja jest deterministyczna. Dotychczasowy preimage operatora zachowuje
  kolejność i wartości na poziomie źródeł. Nowy `std::string` nie zmienia C ABI.
- Ścieżki k0, sparse Floquet i legacy dynamic-demag-k zachowują diagnostykę po
  udanym składaniu, także przy późniejszym błędzie solvera.

## Weryfikacja bieżącego przyrostu

- Python exact identity/preimage replay: 9 grup regresji PASS, w tym mutacja
  każdego pola identity, nested bool/int/float, duplicate keys, raw/framed hash,
  UTF-8, zmiana formatowania i nieznane/brakujące pola.
- Source wiring kwadratury i jej scientific source-map: PASS przed poprawką P2;
  po zmianie trzeba ponowić właściwe sprawdzenia.
- Native testy: przygotowane, **NOT VERIFIED**, zgodnie z zakazem kompilacji.
- Managed runtime, częstotliwości, residuale, podpisane ±k, zbieżność oraz COMSOL:
  **NOT VERIFIED dla tego przyrostu**.

## Kolejność domknięcia

1. Naprawić P2 eksportu kwadratury i zapisać osobny zweryfikowany etap F01.
2. Opublikować own exact preimage wraz z single-/multi-k manifest links.
3. Zamknąć producer provenance i non-shared Floquet identity/operator binding.
4. Podłączyć pełny niezależny replay do głównego verifiera artefaktów; nie
   zastępować bramki naukowej samym poprawnym hashem identity.
5. Nowy build dokładnego spójnego SHA przez kolejkę, następnie C0/C1, signed
   DE/BV, zbieżność i porównanie A1. Pozostałe zadania S00–S12 nie są usuwane.
