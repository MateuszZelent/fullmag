# 04. Poprawki do planu i do migracji

Format: **P-xx** = poprawka. Każda podaje dokument, miejsce, powód i proponowane
brzmienie lub działanie. Poprawki redakcyjne (R-xx) na końcu.

---

## A. Poprawki blokujące start P0

### P-01 — Zsynchronizować checkout z bazą planu przed zamrożeniem fixtures

**Dokument:** `03-migracja.md`, faza P0.
**Powód:** lokalny `master` = `33aa26fe8` jest 18 commitów za deklarowaną bazą
`31bac350a`. Fixtures P0 zamrożone na `HEAD` nie odpowiadałyby cytowaniom E01–E16.

**Działanie:** dopisać do bramy P0 warunek zerowy:
> *„P0 startuje na commicie identycznym z bazą odczytu planu. Każdy fixture zapisuje SHA
> źródeł, z których powstał. Rozjazd bazy dokumentacji i bazy fixtures jest brakiem
> spełnienia bramy.”*

---

### P-02 — Dodać rozdział uzgodnienia z istniejącymi ADR

**Dokument:** `05-dowody-i-adr.md`, nowa sekcja przed „Rejestr decyzji ADR-CAE”.
**Powód:** luka L1 — 34 ADR-y w `docs/adr/`, 30 ze statusem accepted, część rozstrzyga te
same kwestie inaczej.

**Działanie:** dodać tabelę o kolumnach: *ADR* | *status* | *relacja* (supersedes /
consumed-by / unchanged / conflict) | *rozstrzygnięcie*. Minimalny zakres do pokrycia:
0004, 0005, 0006, 0008, 0009, 0010, 0011, 0012, 0016, 0020, 0022, 0023(×2), 0024, 0025,
0026, 0027, 0028, 0029, 0030, 0031.

Trzy pozycje wymagają rozstrzygnięcia jeszcze przed P1:
- **ADR-0025** — czy `AcceptedStateId`/`AcceptedStateGeneration`/`ObservationRuntime`
  są konsumowane przez K02/K09/K13, czy supersedowane. (Uwaga: są **accepted, ale
  niezaimplementowane** — brak `AcceptedStateId`, `ObservationRuntime`, `runtime_epoch`
  w `crates/`.)
- **ADR-0030** — kolizja terminologiczna „project”.
- **ADR-0009/0010** — reguła unieważniania mesh przez zmianę materiału (patrz P-03).

---

### P-03 — Usunąć sprzeczność §14.1 z ADR-0009/0010

**Dokument:** `01-architektura-cae.md` §14.1, wiersz „Ms/Aex”.

**Obecnie:**
> | Ms/Aex | Zależne operatory i rozwiązanie; także mesh, gdy używa kalibracji fizycznej. |

**Proponowane brzmienie:**
> | Ms/Aex | Zależne operatory i rozwiązanie. Mesh pozostaje ważny (ADR-0010). Receptura dyskretyzacji może *opt-in* zadeklarować zależność od parametru materiałowego (np. kalibracja `l_ex`); wtedy i tylko wtedy zmiana materiału unieważnia mesh, a deklaracja jest widoczna w recepturze i w fingerprintcie. |

**Dodatkowo** w §14 dopisać akapit odwołujący się do istniejącej implementacji:
> *„Klasyfikator `classify_region_realization_impact` (`crates/fullmag-authoring/src/
> region_revisions.rs:57`) i struktura `RegionRealizationImpact { topology, membership,
> coefficients, initial_state }` są istniejącą, działającą realizacją selektywnego
> unieważniania. Warstwa fingerprintów rozszerza ten mechanizm o tożsamość producenta
> i wersję kontraktu, a nie zastępuje go nowym.”*

---

### P-04 — Wyłączyć `fullmag session gc` albo wymusić dry-run

**Dokument:** `03-migracja.md` P0, sekcja „Brama”.
**Powód:** luka L3 — `collect_live_refs` nie dereferencjonuje `TensorDescriptor.chunks`,
`CasStore::gc` kasuje wszystko spoza zbioru. Ścieżka osiągalna z CLI.

**Działanie (niezależne od harmonogramu refaktoryzacji, do wykonania od razu):**
1. `SessionSubcommand::Gc` (`crates/fullmag-cli/src/main.rs:467`) — domyślnie `--dry-run`,
   `--apply` wymagane jawnie; zgodnie z precedensem ADR-0030 („Prune domyślnie wykonuje
   dry-run”).
2. `collect_live_refs` — przejść pełny graf korzeni:
   `manifest sesji → run_refs → manifesty runów → checkpointy → FieldRef →
   TensorDescriptor → chunks[].object_ref → recovery → pinned solutions`.
3. Test regresyjny: store z checkpointem zawierającym tensor chunkowany →
   `gc()` → liczba obiektów niezmieniona.

**Zmiana w scenariuszu CAE-47** — obecne brzmienie („Zachowane wszystkie referencje/leases;
brak usunięcia potrzebnych danych”) jest zbyt ogólne. Proponuję:
> | CAE-47 | Store z: aktywnym runem, przypiętym starym solution, checkpointem z tensorem chunkowanym, migawką recovery. Wykonaj GC. | Liczba obiektów CAS niezmieniona; dry-run raportuje 0 kandydatów; apply bez autoryzacji odrzucony. |

---

### P-05 — Przenieść spike „Working store durability” przed P1

**Dokument:** `03-migracja.md` §6 (tabela spike'ów) i brama P1.
**Powód:** luka L4 — `atomic_write` nie wywołuje `sync_all()` ani nie fsynchronizuje
katalogu; `CasStore::put` używa `flush()`, co nie jest fsync.

**Działanie:** oznaczyć spike jako **blokujący bramę P1** i doprecyzować jego zakres:
- `sync_all()` na pliku tymczasowym przed `rename`;
- `fsync` katalogu docelowego po `rename`;
- unikalne nazwy plików tymczasowych (`<nazwa>.<pid>.<uuid>.part` zamiast
  `with_extension("part")`, `store.rs:353`);
- kolejność publikacji w `commit_checkpoint` (`store.rs:115-136`): najpierw `common_state`,
  potem `checkpoint.json` jako marker zamykający — dziś odwrotnie;
- weryfikacja blokady `LOCK` z uwzględnieniem pola `host` (`store.rs:274-301`);
- fault-injection na NTFS oraz na udziale sieciowym (SMB), osobno.

Uzasadnienie dla K10 do dopisania: obecne `commit_checkpoint` jest konkretnym przykładem
publikacji jednoetapowej, w której awaria zostawia manifest wskazujący nieistniejący stan.

---

## B. Poprawki do fazowania P1–P8

### P-06 — Wstawić fazę pośrednią P3a: `/v2/sessions/{session_id}/...`

**Dokument:** `03-migracja.md` §4.
**Powód:** luka L5 — 288 z 293 endpointów to `/v2/sessions/current/*` i **nie ma ani
jednego** endpointu adresowanego identyfikatorem. Skok z niejawnego „current” prosto na
`/v2/projects/{project_id}/...` to zmiana 288 ścieżek naraz.

**Proponowana nowa faza (między P3 a P4):**

> ### P3a — jawna tożsamość sesji przed tożsamością projektu
>
> Wprowadzić `/v2/sessions/{session_id}/...` jako równoległy, pełny wariant istniejących
> ścieżek. `current` staje się aliasem rozstrzyganym **raz, w momencie przyjęcia żądania**,
> na konkretny `session_id`, który jest zwracany w odpowiedzi i wymagany w kolejnych
> wywołaniach klienta. Handlery przyjmują identyfikator jako parametr zamiast czytać stan
> globalny.
>
> **Brama:** każdy handler v2 przyjmuje jawny identyfikator; `current` jest wyłącznie
> warstwą rozstrzygającą i nie jest odczytywany po rozpoczęciu obsługi żądania; licznik
> `grep -c "sessions/current"` poza warstwą aliasu maleje monotonicznie i jest raportowany
> w każdym PR.

**Dlaczego to się opłaca:** frontend ma **jeden** punkt styku (`kernel/api/apiPaths.ts`,
995 linii, zasilany z `generated/openapi-v2-paths.ts`), więc koszt po stronie UI to
regeneracja kontraktu. Zysk: znikają wszystkie wyścigi typu „odczytaj current po długim
oczekiwaniu” (§22 planu wymienia je jako zagrożenie), a P5 (izolacja wykonania) dostaje
gotowy mechanizm adresowania. Bez tego kroku P5 musi jednocześnie wprowadzić projekt,
run i jawne adresowanie.

---

### P-07 — Dodać semafor zasobowy GPU do §18 i do planu wykonania

**Dokument:** `01-architektura-cae.md` §18 oraz `02-kontrakty.md` K09.
**Powód:** plan opisuje `ExecutionProfile`, capabilities i executed receipt, ale **nie ma
w nim limitu współbieżności na fizyczne urządzenie**. Po wdrożeniu P7 („wiele kontekstów
projektu”, kolejka runów) dwa runy na tej samej karcie to domyślny scenariusz.
Ustalenie Gemini jest tu słuszne, choć jego liczby (4–8 GB / 500k elementów) nie mają
oparcia w repozytorium i należy je traktować jako hipotezę.

**Proponowane uzupełnienie §18, punkt 8:**
> 8. Koordynator utrzymuje jawne, nazwane pule zasobów wykonawczych (co najmniej: urządzenie
>    GPU, pamięć hosta, liczba równoległych procesów meshingu). Zadanie deklaruje żądanie
>    zasobu w `ExecutionProfile`; przydział jest widoczny w planie i w executed receipt.
>    Domyślna współbieżność na jedno fizyczne urządzenie GPU wynosi 1; wyższa wartość
>    wymaga zmierzonego budżetu pamięci dla klasy zadania. Brak wolnego zasobu daje stan
>    `blocked` z podaną przyczyną, nigdy cichy fallback na inne urządzenie lub precyzję
>    (zgodnie z ADR-0028).

**Uzupełnienie K09:** przydział workerowi zawiera dziś `task_id, attempt_id,
ownership_epoch, input manifest, target requirements i limity`. Dodać: *`resource_lease`
— identyfikator i czas ważności dzierżawy zasobu wykonawczego; worker nie rozpoczyna
alokacji na urządzeniu bez ważnej dzierżawy.*

---

### P-08 — Przenieść ciężar migracji API z frontendu na Rust

**Dokument:** `03-migracja.md` §3 (mapa właścicieli) i fazy P3, P5, P8.
**Powód:** sprostowanie S2 — frontend ma 2 pliki produkcyjne dotykające `sessions/current`;
Rust ma 59 plików, w tym 54 wystąpienia w `fullmag-runner`.

**Działanie:** dodać do tabeli §3 wiersze:

> | `crates/fullmag-runner` — generatory manifestów (`eigen/artifacts/*`, `fem/eigen_*`, `hysteresis.rs`) | Usunąć adresy transportowe z produkowanych artefaktów; manifest niesie tożsamość, klient wylicza adres | Artefakt przenośny między projektami i hostami. |
> | `scripts/` i `apps/control-room/scripts/` (107 plików) | Wspólna warstwa pomocnicza adresująca API; jedno miejsce do przełączenia | CI nie blokuje migracji ścieżek. |

oraz skorygować wiersz `kernel/resources, fasada API` na:
> | `kernel/api/apiPaths.ts` + `generated/openapi-v2-*` | **Jedyny** punkt styku frontendu ze ścieżkami; migracja = regeneracja kontraktu + zmiana fasady | Frontend nie jest wąskim gardłem migracji. |

---

### P-09 — Reguła „manifest niesie tożsamość, nie adres” w K10

**Dokument:** `02-kontrakty.md` K10.
**Powód:** luka L2.

**Proponowane uzupełnienie po liście pól manifestu:**
> Manifest nie zawiera adresów transportowych. Zakazane są w nim ścieżki HTTP, nazwy
> hostów, portów i parametry zapytań. Zasób jest wskazany przez `artifact_id`,
> `content_hash` i `output_port`; adres wylicza warstwa API w momencie odczytu, na podstawie
> aktywnego kontekstu projektu. Istniejące pola `*_resource_key` produkowane dziś przez
> `fullmag-runner` (m.in. `eigen/artifacts/common.rs:346`, `fmr.rs:1363-1380`) są
> naruszeniem tej reguły i podlegają migracji wraz z przepisaniem treści zapisanych już
> manifestów.

---

### P-10 — Doprecyzować §22 o rzeczywistą skalę adaptera

**Dokument:** `01-architektura-cae.md` §22.

**Obecnie:** *„`/sessions/current` pozostaje wyłącznie ograniczonym adapterem zgodności.”*

**Proponowane brzmienie:**
> `/sessions/current` pozostaje adapterem zgodności. Należy jednak zapisać jego rzeczywistą
> skalę: w bazie odczytu 288 z 293 udokumentowanych ścieżek `/v2` to
> `/v2/sessions/current/*`, a endpointów adresowanych identyfikatorem sesji nie ma wcale.
> Adapter obejmuje więc początkowo niemal całą powierzchnię kontrolną i jest wygaszany
> endpoint po endpoincie według rejestru migracji, z licznikiem postępu raportowanym w
> każdej fazie. Nowy kod nie może używać go jako tożsamości datasetu ani wejścia zadania.
> Adapter wiąże kontekst w momencie przyjęcia polecenia i odrzuca niejednoznaczność.

---

### P-11 — Dopisać `fullmag-quantities` do mapy pakietów

**Dokument:** `03-migracja.md` §2; `01-architektura-cae.md` §19.3.
**Powód:** luka L6.

W §2 dodać wiersz:
> | `fullmag-quantities` | Kanoniczny katalog wielkości fizycznych, deskryptory, ewaluacja, redukcje i transport (ADR-0004) — fundament `FieldDescriptor` (K11) i `DerivedValueDefinition` (K12) | Bez zależności od UI, transportu HTTP i konkretnego runu. |

W §19.3 zamiast *„Rozwijamy tę warstwę, nie zastępujemy jej tablicami JSON”* napisać:
> *„Rozwijamy tę warstwę w oparciu o istniejący `fullmag-quantities` (`catalog`,
> `descriptor`, `eval`, `provider`, `reduction`, `registry`) i ADR-0004, nie zastępujemy jej
> tablicami JSON.”*

Dopisać też brakujące w tabeli `fullmag-bench` i `fullmag-build-info` (choćby z adnotacją
„poza zakresem zmian”).

---

### P-12 — Brama P1: jawna obsługa `rotation_quat` i `scale`

**Dokument:** `03-migracja.md`, brama P1 i P2.
**Powód:** ustalenie D-E — `SceneDocument.Transform3D` niesie rotację i skalę,
`GeometryEntryIR` zna tylko `Translate`.

**Dopisać do bramy P1** (roundtrip `.fms`):
> *„Dokument scene.v2 zawierający `rotation_quat != identity` lub `scale != [1,1,1]` po
> migracji albo zachowuje te wartości w definicji cechy, albo jest zgłoszony w raporcie
> migracji jako element nieobsługiwany. Cicha normalizacja do identyczności jest brakiem
> spełnienia bramy.”*

---

## C. Nowe scenariusze odbioru

Proponuję dopisać do `04-scenariusze.md` sekcję 19:

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| **CAE-61** | Zbuduj artefakt modalny i otwórz jego manifest. | Manifest nie zawiera żadnego URL-a ani ciągu `current`; adres zasobu jest wyliczany przez klienta z `artifact_id` i aktywnego kontekstu projektu. |
| **CAE-62** | Store z aktywnym runem, przypiętym solution, checkpointem z tensorem chunkowanym i recovery; wykonaj GC. | Dry-run domyślny; 0 kandydatów do usunięcia; `--apply` bez autoryzacji odrzucony; żaden obiekt CAS nie znika. |
| **CAE-63** | Wymuś `webglcontextlost` przy aktywnym viewportcie 3D (np. przez wyczerpanie VRAM przez solver GPU). | Powłoka nie jest odmontowana; scena odtworzona po `webglcontextrestored`; kamera i selekcja zachowane; run nie jest przerwany. |
| **CAE-64** | Przerwij proces w trakcie `commit_checkpoint` między zapisem stanu a manifestem; wykonaj restart. | Poprzedni kompletny checkpoint pozostaje czytelny; niekompletny nie jest widoczny jako dostępny do resume. |
| **CAE-65** | Otwórz projekt z katalogu na udziale sieciowym; równolegle otwórz go z drugiego hosta. | Drugi host dostaje read-only lub czytelną odmowę; blokada nie jest usunięta na podstawie samego nieistnienia PID-u lokalnie. |
| **CAE-66** | Uruchom dwa runy wymagające GPU na jednym fizycznym urządzeniu. | Drugi run otrzymuje `blocked` z przyczyną „resource lease unavailable”; brak OOM; brak cichego przejścia na CPU lub inną precyzję. |
| **CAE-67** | Przełącz zakładkę centralną 3D → wykresy → 3D. | Zero zamontowanych kanw 3D na zakładce nieaktywnej (ADR-0016); po powrocie brak ponownego pobrania geometrii z sieci; kamera i stan `OrbitControls` zachowane. |
| **CAE-68** | Zmień parametr materiałowy `Ms` przy zbudowanym meshu FEM. | Mesh pozostaje ważny; `coefficients` oznaczone jako stale; remesh wyłącznie wtedy, gdy receptura zadeklarowała opt-in zależność od materiału. |
| **CAE-69** | Wykonaj `Compute` i zmierz czas od komendy do pierwszego kroku fizycznego. | Wartość zmierzona i zapisana jako baseline w P0; w P5 brak pośrednictwa zapisu skryptu na dysk i startu interpretera; regresja względem baseline jest blokująca. |
| **CAE-70** | Zaimportuj `.fms` zapisane przed migracją, zawierające manifesty z `*_resource_key`. | Raport migracji wymienia przepisane klucze; artefakty pozostają odczytywalne; oryginał zachowany. |

---

## D. Uzupełnienia do listy spike'ów (`03-migracja.md` §6)

| Spike | Co rozstrzyga | Wynik wymagany | Kiedy |
|---|---|---|---|
| **Working store durability** *(istnieje — przenieść wcześniej)* | `fsync`, kolejność publikacji, blokada, udziały sieciowe | Log fault-injection dla NTFS i SMB; test kolizji nazw temp | **przed P1** |
| **CAS capacity boundary** *(nowy)* | Próg, powyżej którego obiekt nie trafia do CAS; koszt `get` z rehashowaniem | Profil czasu/pamięci dla obiektów 10 MB / 1 GB / 10 GB; reguła progu w K14 | przed P6 |
| **Manifest identity migration** *(nowy)* | Zakres pól `*_resource_key` i sposób przepisania istniejących artefaktów | Inwentarz pól, narzędzie migracji, test roundtrip | przed P6 |
| **API identity cutover** *(nowy)* | Koszt i kolejność przejścia 288 ścieżek na jawny identyfikator | Prototyp P3a na 5 reprezentatywnych endpointach + zmierzony koszt regeneracji kontraktu | przed P3a |
| **ADR reconciliation** *(nowy, dokumentacyjny)* | Relacja ADR-CAE do 34 istniejących ADR | Tabela supersede/consume/conflict zatwierdzona przez decydentów ADR | **przed P0** |

---

## E. Poprawki redakcyjne

- **R-01** — `05-dowody-i-adr.md`, E15: zmienić `SimulationStartupOverlay.tsx:580–655`
  na `:594–616` (`WorkspaceStartupGateView`) i `:583–592`
  (`preparationDuringRealtimeDisruption`). Plik ma 641 linii.
- **R-02** — `05-dowody-i-adr.md`, E16: zmienić `Cargo.toml:1–160` na `Cargo.toml:1–19`.
  Plik ma 42 linie; `members` kończy się w linii 19.
- **R-03** — `05-dowody-i-adr.md`, E03: zaznaczyć, że `ParameterSweep` jest wariantem
  `StudyMacroStageKind` (builder.rs:373), a nie `StudyPrimitiveStageKind` (325–342).
- **R-04** — `05-dowody-i-adr.md`, E02: dopisać dowód inkrementacji rewizji
  (`crates/fullmag-api/src/main.rs:3947-3953`) — bezwarunkowe `saturating_add(1)` przy
  każdym PUT sceny. To mocniejszy dowód tezy niż sama struktura `SceneDocument`.
- **R-05** — `05-dowody-i-adr.md`, E04: dopisać pomiar `288/293` ścieżek oraz dowód
  z `WorkspaceShellClient.tsx:17-28` + `EmptyWorkspace.tsx` (bez sesji UI pokazuje
  wyłącznie „Create simulation”).
- **R-06** — `01-architektura-cae.md` §5.1: dopisać, że `SceneEditorState` (scene.rs:567)
  i `VisualizationCameraState` (scene.rs:400, użyte w 559) są dziś częścią
  `SceneDocument` — to konkretne miejsce, z którego „czwarty właściciel” ma zostać
  wyodrębniony.
- **R-07** — `03-migracja.md` §8 („Stan wykonania tego planu”): dopisać jedno zdanie
  o bazie SHA i o tym, że dokumenty nie były weryfikowane przeciwko lokalnemu checkoutowi.
- **R-08** — `02-kontrakty.md` K13: dopisać, że dzisiejszy `CheckpointCompatibility`
  (`types.rs:304-335`) już zawiera `restart_abi`, `problem_hash`, `plan_hash`, `engine_id`,
  `discretization_signature` — K13 je rozszerza, nie tworzy od zera.
- **R-09** — `02-kontrakty.md` K02: dopisać, że UI ma już prymitywną epokę
  (`sessionResourceIdentity.ts:31-36`, `session=<id>&epoch=<epoch>|<key>`), którą należy
  rozszerzyć o `projectId`/`runId`, a nie zastępować nowym mechanizmem.
- **R-10** — `02-kontrakty.md` K11: rozstrzygnąć redundancję
  `TensorChunk.object_ref` vs `TensorChunk.sha256` (`types.rs:427-433`) przy okazji
  wprowadzania reprezentacji zespolonej.
- **R-11** — `04-scenariusze.md` §17: dopisać, że baseline narzutu obecnej pętli
  (render skryptu + 2 × start interpretera Pythona) musi zostać **zmierzony w P0**;
  liczby cytowane w raportach zewnętrznych bez pomiaru nie są dopuszczalne jako dane
  wejściowe.
