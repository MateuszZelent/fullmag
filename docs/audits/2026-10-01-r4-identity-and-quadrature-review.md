# Review tożsamości liniaryzacji i diagnostyki kwadratury

Data: 2026-10-01. Baza: `abbd0c451`; oceniane zmiany są lokalnym przyrostem
worktree `eigensolve-dispersion-plan-20260912`, poza kapsułą buildu #193.
Zakres: R4, publikacja kwadratury F01 oraz niezależny replay Python.

## Wynik i granice dowodu

Review źródeł nie zamyka R4 ani walidacji dyspersji. Nie kompilowano testów
natywnych. Build runtime-only #193 jest aktualnie running na obrazie MFEM 4.10; jego źródła
nie zawierają tego przyrostu. Pełny plan S00–S12 pozostaje obowiązujący.

| Problem | Priorytet i trigger | Stan oraz konkretna naprawa |
|---|---|---|
| Brak własnego exact preimage identity | P1: digest powstaje z kompaktowego `serde_json::to_vec` po wyzerowaniu `content_sha256`, publikowany JSON jest inną reprezentacją | Potwierdzony. Addytywny `linearization_identity_preimage.v1` ma zachować dokładne bajty, raw SHA-256 i framed digest. Python musi sprawdzić również zgodność wszystkich wartości z opublikowanym identity. |
| Brak identity w non-shared Floquet | P1: `eigen_native_window.rs` przekazuje brak state/handoff do publikacji, choć wykorzystano stan relaksacji | Potwierdzony przez niezależne review; wymagane przekazanie stanu i certyfikatów lub jawny brak kwalifikacji. Nie można nazywać tej ścieżki pełnym R4. |
| Rekonstrukcja danych producenta w bieżącym procesie | P1/P2: `from_exact_artifacts` przypisuje aktualny `build_identity_json()` bez transportu historycznej tożsamości producenta | Otwarte: sprawdzić faktyczną dostępność importu między runami. Kontrakt importu musi przenosić producer build/source-plan metadata; bieżąca tożsamość nie może zastępować nieznanej. |
| Null operator input signature w non-shared Floquet | P1: manifest nie wiąże rzeczywistych wejść operatora | Otwarte. Przekazać produkcyjną sygnaturę wraz z dokumentowanym zakresem; porównywać punkty poza jawną zmianą k. |
| Niepełne wiązanie semantyki dynamicznej | P2: statyczne identity pomija damping zgodnie z fizyką, lecz modal identity nie jest użyte produkcyjnie | Otwarte. Związać damping policy, k, Floquet boundary i operator przez modal identity. Damping relaksacji 0,5 i eigen 0 nie może sam zmieniać statycznej tożsamości. |
| Nieprawidłowy indeks identity multi-k | P1: wrapper stage-handoff przekazuje indeks 0, a późniejsze przeniesienie pliku nie zmienia podpisanego `sample_index` | Potwierdzony w focused review. Przekazać rzeczywisty indeks przed tworzeniem identity; testować co najmniej drugą próbkę. Naprawa w toku. |
| Nieaktualne ścieżki state w podpisanym identity | P1: identity wskazuje rootowe equilibrium/state, które później są przenoszone do `sample_NNNN` | Potwierdzony. Podpisywać finalne ścieżki; nie zmieniać rekordów po podpisaniu. Naprawa w toku. |
| Single-k pomijany przez discovery R4 | P1: producent zapisuje sidecary, ale manifest publikuje tylko singular identity paths | Potwierdzony. Wystawić komplet plural arrays dla jednej próbki zgodnie z kontraktem discovery. Naprawa w toku. |
| Zagnieżdżony klucz tłumi eksport kwadratury | P2: `.find("shared_domain_operator_provenance")` traktuje nested klucz jako top-level | Naprawiony źródłowo: guard top-level; prepared regresja przez kontrakt natywny i publiczne C ABI. Focused review bez nowych P1/P2; runtime NOT VERIFIED. |
| Końcowe whitespace i nieprecyzyjna dokumentacja append JSON | P2: helper wymaga ostatniego znaku `}`, a opis obiecuje więcej niż sprawdza kod | Naprawiony źródłowo: trailing whitespace i pusty obiekt `{ \n }` są obsługiwane. Opis ograniczonego skanera nie obiecuje pełnej walidacji JSON. Native runtime NOT VERIFIED. |

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

- Python exact identity/preimage replay: 10 grup regresji PASS, w tym mutacja
  każdego pola identity, nested bool/int/float, duplicate keys, raw/framed hash,
  UTF-8, zmiana formatowania, nieznane/brakujące pola i nesting limit. Łącznie
  z discovery sidecarów 48 testów PASS; dotychczasowy walidator 213 PASS.
- Source wiring kwadratury i jej scientific source-map: PASS po poprawkach P2.
- Native testy: przygotowane, **NOT VERIFIED**, zgodnie z zakazem kompilacji.
- Managed runtime, częstotliwości, residuale, podpisane ±k, zbieżność oraz COMSOL:
  **NOT VERIFIED dla tego przyrostu**.

## Kolejność domknięcia

### Dodatkowe focused review helpera fizycznego

- P2: Python parsuje leksykalne `-0` jako integer zero, a Rust w polu f64
  zachowuje znak i odrzuca ujemne zero Ku/osi. Wymagane regresje `-0`, `-0.0`
  i `-0e0`; poprawione leksykalnym parserem, regresje PASS.
- Helper pięciu par nie waliduje całego outer identity ani fizycznej legalności
  raw `MaterialIR`. Main uruchamia go dopiero po pełnym own-identity replay;
  dokument rozdziela raw shape/finite od legalności IR i solvera.
- Dodano pozytywną regresję rzeczywistego airboxu i obu rodzajów par PBC
  oraz negatywne mutacje typów i kanonicznego kształtu producenta.
- Root integration: 59 focused PASS i 213 testów głównego verifiera PASS.
  Pięć digestów jest zachowywanych także przy `missing_recomputed`;
  pełne R4 pozostaje `NOT VERIFIED`.

1. Naprawić P2 eksportu kwadratury i zapisać osobny zweryfikowany etap F01.
2. Opublikować own exact preimage wraz z single-/multi-k manifest links.
3. Zamknąć producer provenance i non-shared Floquet identity/operator binding.
4. Podłączyć pełny niezależny replay do głównego verifiera artefaktów; nie
   zastępować bramki naukowej samym poprawnym hashem identity.
5. Nowy build dokładnego spójnego SHA przez kolejkę, następnie C0/C1, signed
   DE/BV, zbieżność i porównanie A1. Pozostałe zadania S00–S12 nie są usuwane.
