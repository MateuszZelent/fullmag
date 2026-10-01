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
| Rekonstrukcja danych producenta w bieżącym procesie | P1/P2: `from_exact_artifacts` przypisywał aktualny `build_identity_json()` bez transportu historycznej tożsamości producenta | Naprawa źródłowa w review: typed producer record powstaje przy zapisie relaksacji, exact verified constructor i loader przenoszą rzeczywisty build/source-plan metadata. Root potwierdził brak produkcyjnych wywołań starego exact konstruktora. Prepared pełne regresje live/import oraz managed runtime nadal wymagane. |
| Null operator input signature w non-shared Floquet | P1: manifest nie wiąże rzeczywistych wejść operatora | Otwarte. Przekazać produkcyjną sygnaturę wraz z dokumentowanym zakresem; porównywać punkty poza jawną zmianą k. |
| Niepełne wiązanie semantyki dynamicznej | P2: statyczne identity pomija damping zgodnie z fizyką, lecz modal identity nie jest użyte produkcyjnie | Otwarte. Związać damping policy, k, Floquet boundary i operator przez modal identity. Damping relaksacji 0,5 i eigen 0 nie może sam zmieniać statycznej tożsamości. |
| Nieprawidłowy indeks identity multi-k | P1: wrapper stage-handoff przekazuje indeks 0, a późniejsze przeniesienie pliku nie zmienia podpisanego `sample_index` | Naprawa źródłowa w niezależnym review: rzeczywisty indeks jest przekazywany przed tworzeniem identity; przygotowane regresje dla dalszych próbek. Runtime NOT VERIFIED. |
| Nieaktualne ścieżki state w podpisanym identity | P1: identity wskazuje rootowe equilibrium/state, które później są przenoszone do `sample_NNNN` | Naprawa źródłowa w niezależnym review: podpisywane są finalne ścieżki; remap zachowuje exact bytes. Runtime NOT VERIFIED. |
| Single-k pomijany przez discovery R4 | P1: producent zapisuje sidecary, ale manifest publikuje tylko singular identity paths | Naprawa źródłowa w niezależnym review: komplet ośmiu plural arrays dla jednej próbki, nieobecne rodziny puste. Runtime NOT VERIFIED. |
| Błędna nazwa indeksu ścieżki state | P1: cztery wywołania używały niezdefiniowanego `artifact_state_sample_index` | Poprawiono na rzeczywisty parametr `state_artifact_sample_index`. Parser Rust PASS, przegląd czterech call sites PASS; production build aktualnego źródła nadal wymagany. |
| Częściowe sidecary i niekanoniczne indeksy w manifeście | P2: filtry po nazwach nie zapewniają pełnego computed sample-set ani powiązania digestów dla każdej próbki | Potwierdzone w kolejnym review. Naprawa coverage, kanonicznych nazw i mapy rzeczywistych identity digestów w toku. Historyczny brak R4 nie może dostać pełnej kwalifikacji. |
| Replay mesh porównuje tylko zadeklarowane digesty | P1: nowy helper może oznaczyć mesh binding jako poprawny bez rzeczywistych węzłów i elementów | Naprawione w helperze: actual topology fingerprint v3, zgodność node-count i struktury CSR/roles/PBC oraz regresje mutacyjne. 20 testów wrapper/base replay i 29 testów siatki PASS. Integracja pełnego R4 z głównym verifierem pozostaje NOT VERIFIED. |
| Zagnieżdżony klucz tłumi eksport kwadratury | P2: `.find("shared_domain_operator_provenance")` traktuje nested klucz jako top-level | Naprawiony źródłowo: guard top-level; prepared regresja przez kontrakt natywny i publiczne C ABI. Focused review bez nowych P1/P2; runtime NOT VERIFIED. |
| Path z próbkami pola pomija relaksację per sample | P1: adapter czyści `bias_field_samples`, nie przenosi producer identity i nie buduje nowego handoffu | Potwierdzone w niezależnym review producenta. Poprawka obejmuje wspólnie dispatch, orchestrator ścieżki i per-sample relaksację z właściwym indeksem. W implementacji; nie jest zakończona przez samo dodanie argumentu. |
| CSV dyspersji wpisuje sample 0 | P1: `dispersion_v2_csv` hardkoduje `0`, `sample-0000` i identyfikator pola próbki zero | Potwierdzone w niezależnym review nonshared. Generator musi otrzymać rzeczywisty indeks z każdego call site, także fallbacku. Poprawka w implementacji. |
| Brak kontroli dependency digestu odpowiedzi native | P1: żądanie przekazuje digest, lecz odbiornik kopiuje diagnostykę bez odrzucenia brakującej/obcej odpowiedzi | Potwierdzone w niezależnym review. Wymagana kontrola dependency digestu względem żądania; digest Rust i native mają różne preimage i nie wolno porównywać ich bezpośrednio. Poprawka w implementacji. |
| Publiczny Python nie zapisuje producer identity | Luka integracyjna: `_core.run_problem_json` wywołuje runner bez metadanych orkiestratora CLI | Bez fałszywej kwalifikacji: sidecar był pomijany, a eigen pozostawał fail-closed. Dodano lokalne wiązanie rzeczywiście nowej standalone execution przed dispatch w czterech entrypointach runnera i w unified InteractiveRuntime. Import zachowuje historyczne identity. Regresje przygotowane, parser PASS; testów natywnych nie kompilowano. Review/build/runtime jeszcze OPEN. |
| Adapter źródła porównuje tylko własny hash identity | P1: pełny own-preimage replay nie porównywał source IDs, build/plan/mesh/m0 i payload refs identity z rzeczywistym producentem | Wykryte przez root przed integracją głównej bramki. Wymagane bezpośrednie semantic bindings i mutacje z ponownie obliczonym own hash, aby obce source metadata nie przeszły przez sam poprawny digest. Poprawka w toku; adapter nie kwalifikuje jeszcze R4. |
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

Niezależne review nowego wrappera accepted/recomputed wykryło dodatkowe
błędy przed jego publikacją:

- P1: liczba węzłów rzeczywistej siatki nie była porównywana z `node_count`
  pól i m0. Niepoprawny fixture miał cztery węzły siatki i jeden węzeł pól.
- P1: fingerprint Python odrzucał brak pustych tablic PBC, choć Rust
  poprawnie pomija je przez `skip_serializing_if` i odtwarza przez `default`.
- P2: potrzebna jest kontrola struktury siatki, a nie sam digest topologii.
- P2: raport musi jawnie ujawniać zakres caller-validated sygnatur;
  ekstrakcja preimage certyfikatu nie weryfikuje całego identity v2.

Poprawki node-count/PBC/struktury i jawnego zakresu sygnatur są obecne
w źródłach. Końcowe review root wykryło dodatkowo brak zgodności liczby
`facets.roles` z liczbą facets; dodano kontrolę i regresję z pasującym
digestem wadliwej siatki. Kolejne niezależne review wykryło akceptowanie
jednoczesnych kluczy `tolerance` i `tolerance_m`, które Rust traktuje jako
zduplikowane pole. Oba konsumery odrzucają ten przypadek; dodano regresje.
Aktualne kontrole: 20 testów wrapper/base replay oraz 29 testów fingerprintu
PASS. Literalny frozen digest certyfikatu pochodzi
z `types.rs`, nie z samodzielnej serializacji fixture'u Pythona.

Pełny validator dokumentacji wrappera ujawnił braki mapy źródeł, tabel i
przykładu; po korekcie PASS. Review fizyczne poprawiło jednostkę `m0` na
bezwymiarowy kierunek oraz opis wyboru V2 przez `Some(Ku)`, także zero.
Review prepared regresji Rust wykryło nieprawidłową ponowną serializację
`serde_json::Value` zamiast typed serde field order; porównanie używa teraz
zamrożonych bajtów producenta. Parser Rust PASS; tej regresji natywnej
nie kompilowano ani nie uruchamiano.

Wrapper nie jest jeszcze podłączony jako pełna bramka R4 w głównym verifierze.
Nie sprawdza natywnych Jacobianów ani orientacji i nie dowodzi wykonania solvera.

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
- Końcowe niezależne review checkpointu
  `ff1f823fe9ac078403299989b0ce4319ca77023e`: bez nowych P1/P2 w zakresie
  Pythonowego replayu i integracji. Nie jest to review końcowe aktywnych zmian
  Rust ani dowód wykonania solvera.

1. Naprawić P2 eksportu kwadratury i zapisać osobny zweryfikowany etap F01.
2. Opublikować own exact preimage wraz z single-/multi-k manifest links.
3. Zamknąć producer provenance i non-shared Floquet identity/operator binding.
4. Podłączyć pełny niezależny replay do głównego verifiera artefaktów; nie
   zastępować bramki naukowej samym poprawnym hashem identity.
5. Nowy build dokładnego spójnego SHA przez kolejkę, następnie C0/C1, signed
   DE/BV, zbieżność i porównanie A1. Pozostałe zadania S00–S12 nie są usuwane.

## Integracja replayu producenta z verifierem — checkpoint źródłowy

Główny verifier wywołuje adapter producenta dla kompletnych pakietów z identity v2.
Wiąże rzeczywisty sample-set, ścieżki, schema i content digest equilibrium/state
z identity oraz przekazuje dokładne copied payloads. Brak historycznych danych
pozostaje NOT VERIFIED; uszkodzona deklarowana relacja zostaje odrzucona.
Nonshared bez identity v2 wymaga osobnego replayu source-state i nie otrzymuje
fikcyjnej identity shared. Wynik source replay pozostaje oddzielony od operator
replay, także dla nonshared z jawnie dostarczoną identity. Consumer plan digest
jest dotąd sprawdzany składniowo; brak jego dokładnych bajtów nadal blokuje
pełne odtworzenie operatora.

Kontrole przyrostu: 25 unittest PASS; dotychczasowy verifier i signed sidecars:
252 pytest oraz 15 subtests PASS. Test routingu używa mocku adaptera wyłącznie
do kontroli przekazywanych ścieżek i separacji bramek; nie jest dowodem fizyki.
Pełny pakiet producenta bez mocków przeszedł kontrolę: realny producer fixture,
przeniesienie payloadów do sample_0000 i odrzucenie obcego artifact/path/hash
po ponownym przeliczeniu własnego digestu identity. Aktualne suite producenta,
routingu i nonshared: 30 unittest PASS; validator dokumentacji adaptera PASS.
Build #193 nie zawiera tych zmian; pełny R4 i kwalifikacja nadal otwarte.
