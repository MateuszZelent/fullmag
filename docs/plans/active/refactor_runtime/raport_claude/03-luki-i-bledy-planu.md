# 03. Luki i błędy planu — L1–L6 oraz ustalenia dodatkowe

Poniżej wyłącznie rzeczy, których **nie ma ani w dokumentach `01`–`05`, ani w
`raport_gemini/`**. Każda pozycja ma dowód plik:linia sprawdzony w tej sesji.

---

## L1 — Plan nie uzgadnia się z 34 istniejącymi ADR-ami repozytorium

**Waga: krytyczna. Blokuje P0.**

`05-dowody-i-adr.md` wprowadza 18 decyzji `ADR-CAE-01..18` ze statusem `PROPOSED`
i zastrzega: *„Prefiks nie zajmuje automatycznie numeracji ADR w repozytorium. Akceptacja
i mapowanie na repozytoryjne ADR należą do wdrożenia.”*

To zastrzeżenie jest zbyt słabe, bo w `docs/adr/` leży **34 dokumentów, z których 30 ma
status accepted / accepted for implementation**, a kilka z nich rozstrzyga **dokładnie te
same kwestie**, co nowe ADR-CAE — czasem inaczej.

### 1.1. ADR-y bezpośrednio kolidujące lub pokrywające się

| Istniejący ADR | Status | Relacja do planu | Co trzeba rozstrzygnąć |
|---|---|---|---|
| **0016** center viewport tabbed surfaces | accepted | §23.3, ADR-CAE-10 | ADR-0016 **nakazuje** odmontowanie nieaktywnej powierzchni 3D. Plan jest z tym zgodny, ale audyt Gemini nie — wymaga jawnego zapisu „ADR-0016 pozostaje w mocy”. |
| **0025** trwały runtime i źródła obserwacji | accepted | K02, K09, K13, ADR-CAE-06 | **Największa kolizja.** ADR-0025 definiuje już `AcceptedStateId` (run_id, stage_id, accepted_step, clock/state/domain/plan digests), `AcceptedStateGeneration` (`runtime_epoch`, `accepted_revision`) i rozdział `LiveRuntime`/`ObservationRuntime`. To jest wcześniejsza wersja K02+K09+K13. Plan musi powiedzieć: supersede czy konsumuje. |
| **0009** geometry invalidates mesh | accepted | §14.1 | ADR-0009 zawiera **gotową macierz unieważnień** (mutacja × FDM grid × FEM mesh × membership × coefficients × initial state). Tabela §14.1 planu jest z nią częściowo sprzeczna (patrz 1.3). |
| **0010** magnetization does not invalidate mesh | accepted | §14.1 | Wprost: `material override → mesh unchanged, coefficients stale`, z **jawną klauzulą opt-in** dla przyszłych wyjątków. |
| **0011** resource-first API | accepted | §22, ADR-CAE-14 | Definiuje obowiązujący kontrakt zasobowy; zmiana na `/v2/projects/{id}/...` jest zmianą tego ADR, nie tylko planu. |
| **0012** canonicalization backbone | accepted | §7, K05 | Istniejąca reguła kanonizacji vs nowy `ParameterContext`/AST. |
| **0023** physics-first results explorer | accepted | §19, P6 | Istnieje już zaakceptowany model przeglądarki wyników. |
| **0029** analysis result dataset and slice selection | accepted for implementation | K12, §19.2 | Istniejący kontrakt datasetu/slice — `DatasetDefinition` musi być jego nadzbiorem lub następcą. |
| **0022** live charts / analysis boundary | accepted | §19.4, §23.1 | Rozdział akwizycji online i postprocessingu już rozstrzygnięty. |
| **0008** inspector draft/apply transaction | accepted | K17, §23.4 | Istniejąca semantyka draftu — K17 ją rozszerza, ale nie cytuje. |
| **0005** stable docking layout lifecycle | accepted | §23.1 | Kontrakt `DockLayoutEnvelope` i naprawa layoutu — istnieje. |
| **0006** selection is not focus | accepted | §23.3 `WorkspaceContext` | Rozróżnienie zaznaczenia i fokusu już zdefiniowane. |
| **0026** frozen spins constraint and selection model | zaakceptowany projekt implementacyjny | §8.3, §18.1, CAE-11 | Istniejący model Frozen Spins — §18.1 planu go nie cytuje. |
| **0027** canonical FEM mesh policy and quality evidence | accepted for implementation | §10.2, K10 | Certyfikaty meshu, o których mówi plan, mają już własny ADR. |
| **0028** FDM CUDA precision policy | accepted for implementation | §18, ADR-CAE-16 | Polityka precyzji i zakaz cichego fallbacku już istnieje. |
| **0030** project storage and build concurrency | accepted for implementation | §20, §24 | **Kolizja terminologiczna** — patrz 1.2. |
| **0031** runner observability storage UI | accepted for implementation | §18.5, §19.4 | Kontrakt obserwowalności runnera już istnieje. |

### 1.2. Kolizja terminologiczna „project”

ADR-0030 używa słowa **project** w znaczeniu *repozytorium źródeł i katalog wyników
buildów*: `project root`, `project storage root` = `C:\git\fullmag\storage`,
`FULLMAG_PROJECT_STORAGE_ROOT`, `storage/runs/<worktree-id>/`.

Plan używa **project** w znaczeniu *dokument użytkownika CAE* (`ProjectDefinition`,
`ProjectId`, `/v2/projects/{project_id}/...`, `ProjectRepository`).

To są dwa różne byty o tej samej nazwie, oba z akceptowanym statusem, oba z własnym
„repository” i „runs”. Bez rozstrzygnięcia nazewnictwa wdrożenie wygeneruje ścieżki typu
`storage/runs/<worktree>/…` obok `projects/<project_id>/runs/<run_id>/…` i nikt nie będzie
wiedział, które `runs` jest które.

**Zalecenie:** albo przemianować byt CAE (np. `StudyDocument`/`ModelProject`), albo dopisać
do ADR-0030 sekcję rozróżniającą *build storage* od *user project*. Decyzja **przed P1**.

### 1.3. Konkretna sprzeczność merytoryczna: §14.1 vs ADR-0009/0010

Tabela w `01-architektura-cae.md` §14.1:

> | Ms/Aex | Zależne operatory i rozwiązanie; **także mesh, gdy używa kalibracji fizycznej**. |

ADR-0009, macierz *Region edits*:

> | material override | FDM grid: **unchanged** | FEM mesh: **unchanged** | membership: unchanged | coefficients: **stale** | initial state: unchanged |

ADR-0010, *Exception*:

> *„If a future magnetization feature affects discretization requirements … that specific
> feature **must opt-in to mesh invalidation explicitly**. The default path does not
> invalidate mesh.”*

Plan formułuje wyjątek jako regułę domyślną („także mesh, gdy…”), ADR jako opt-in.
Różnica jest praktyczna: decyduje o tym, czy zmiana `Ms` w inspektorze wywołuje remesh.
**Wymaga jednoznacznego zapisu.**

### 1.4. Istniejący klasyfikator unieważnień nie jest w planie skredytowany

`crates/fullmag-authoring/src/region_revisions.rs:23-33` i `:57`:

```rust
pub struct RegionRealizationImpact {
    pub topology: bool,
    pub membership: bool,
    pub coefficients: bool,
    pub initial_state: bool,
}
pub fn classify_region_realization_impact(...)
```

Wywoływane w `crates/fullmag-api/src/main.rs:3935-3945` przy każdym commicie sceny.
To jest **działająca implementacja selektywnego unieważniania**, dokładnie ta klasa
mechanizmu, którą §14.1 proponuje jako nową. Plan powinien wskazać ją jako punkt wyjścia
(analogicznie jak robi to dla `problem.py` cache w §14.2), zamiast opisywać fingerprinty
tak, jakby nic takiego nie istniało.

### 1.5. Higiena numeracji ADR

W `docs/adr/` istnieją **zduplikowane numery**: dwa `0019` (`regional-field-drive…`
accepted i `spin-transport…` proposed), dwa `0021` (`fem-runtime-crossover-policy`
i `native-mixed-p1-fem-topology`), dwa `0023` (`physical-bias-sweep…`
i `physics-first-results-explorer`). Dodanie równoległej przestrzeni `ADR-CAE-*` pogłębi
nieporządek. **Zalecenie:** nadać decyzjom planu kolejne numery repozytoryjne
(0032–0049) przy akceptacji, a prefiks `ADR-CAE` porzucić.

---

## L2 — Runner zapisuje `/v2/sessions/current/...` do trwałych manifestów artefaktów

**Waga: krytyczna. Dotyka K10, K14, CAE-04, CAE-37, CAE-58.**

`03-migracja.md` §2 zakłada dla `fullmag-runner`: *„Nie odczytuje mutowalnego globalnego
modelu”*. Stan faktyczny jest gorszy: runner **wpisuje adres globalnego „current” do danych
zapisywanych na dysk**.

Dowody (kod produkcyjny, nie testy):

`crates/fullmag-runner/src/eigen/artifacts/common.rs:346-350`
```rust
pub(super) fn eigen_mode_field_resource_key(mode_field_id: &str) -> String {
    format!(
        "/v2/sessions/current/data/fields/{mode_field_id}/samples/vector?view=phase_rotated_real&phase_rad=0"
    )
}
```

`crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs:35, 172-173`
```rust
pub mode_field_resource_key: Option<String>,
...
mode_field_resource_key: field_payload_valid
    .then(|| eigen_mode_field_resource_key(&mode_field_id)),
```

`crates/fullmag-runner/src/eigen/artifacts/common.rs:226-235` — dziesięć pól
`*_resource_key` w strukturze manifestu; `fmr.rs:1363-1380` wypełnia je stałymi
`/v2/sessions/current/...`.

Łącznie **54 wystąpienia** `sessions/current` w `crates/fullmag-runner/src`.

### Konsekwencje, których plan nie przewiduje

1. **Migracja `.fms` (K14, CAE-04) musi obejmować przepisanie treści manifestów**, nie
   tylko ich schematu i układu katalogów. Dziś manifest wskazuje zasób, który po migracji
   na `/v2/projects/{id}/...` przestanie istnieć.
2. **CAE-37 („Otwórz solved archive na hoście bez dostępnego solvera”) jest dziś nie do
   spełnienia nawet po zbudowaniu warstwy Dataset**, bo artefakt wskazuje zasób sesyjny,
   a nie treść.
3. **K10 wymaga uzupełnienia:** manifest nie może zawierać adresów transportowych.
   Powinien zawierać wyłącznie tożsamości (`artifact_id`, `content_hash`, `output_port`),
   a URL-e mają być wyliczane przez warstwę API w momencie odczytu.
4. **CAE-58 („Otwarcie nowego schematu starszym klientem”)** zyskuje drugi wymiar:
   stary klient dostanie manifest z adresem, którego nowy serwer nie obsługuje.

### Zalecenie

Dodać do P0 inwentaryzację wszystkich pól `*_resource_key` w produkowanych artefaktach
i do P6 **regułę: manifest przechowuje tożsamość, nie adres**. Dodać scenariusz odbioru
(propozycja **CAE-61**): *„Manifest artefaktu nie zawiera żadnego URL-a zawierającego
`current`; klient wylicza adres z `artifact_id` i aktywnego kontekstu projektu.”*

---

## L3 — `SessionStore::gc()` kasuje żywe dane (błąd osiągalny z CLI)

**Waga: krytyczna. Odpowiada wprost scenariuszowi CAE-47.**

`crates/fullmag-session/src/store.rs:315-338`
```rust
pub fn collect_live_refs(&self) -> Result<HashSet<String>> {
    let mut refs = HashSet::new();
    let runs_dir = self.root.join("runs");
    ... for each runs/<run>/checkpoints/<cp>/checkpoint.json ...
        for field_ref in &cp.field_refs {
            refs.insert(field_ref.tensor_descriptor_ref.clone());
        }
    Ok(refs)
}

pub fn gc(&self) -> Result<usize> {
    let live = self.collect_live_refs()?;
    self.cas.gc(&live)
}
```

`crates/fullmag-session/src/cas.rs:92-107`
```rust
pub fn gc(&self, live_refs: &HashSet<String>) -> Result<usize> {
    for entry in fs::read_dir(self.root.join("sha256"))? {
        if let Some(name) = entry.file_name().to_str() {
            if !live_refs.contains(name) {
                fs::remove_file(entry.path())?;   // kasuje wszystko spoza zbioru
            }
        }
    }
}
```

`crates/fullmag-session/src/types.rs:373-382, 427-433`
```rust
pub struct TensorDescriptor { ... pub chunks: Vec<TensorChunk> }
pub struct TensorChunk { pub object_ref: String, pub offset: usize, pub length: usize,
                         pub sha256: Option<String> }
```

### Na czym polega błąd

`collect_live_refs` zbiera wyłącznie hash **deskryptora tensora**
(`FieldRef.tensor_descriptor_ref`, `types.rs:442`). **Nie dereferencjonuje deskryptora**,
więc nigdy nie dodaje `TensorDescriptor.chunks[].object_ref` — czyli hashów blobów
z faktycznymi danymi pól. Nie obejmuje także:

- obiektów wskazywanych przez `FmsSessionManifest` (w tym `run_refs`),
- manifestów runów (`commit_run`, `store.rs:89`),
- migawek recovery (`write_recovery`, `store.rs:231`),
- blobów z `store_magnetization` / `store_blob` (`store.rs:190, 204`) niewskazanych
  z checkpointu,
- dokumentów zapisanych przez `write_document` (`store.rs:211`) — te akurat leżą poza
  `objects/sha256`, ale referencje z nich do CAS nie są zbierane.

Wynik: wywołanie `gc()` usuwa **dane pól wszystkich checkpointów** i wszystko, co nie jest
przypadkiem hashem deskryptora.

### Ścieżka osiągalna dla użytkownika

`crates/fullmag-cli/src/main.rs:467-472`
```rust
SessionSubcommand::Gc { store } => {
    let ss = SessionStore::open(&root)?;
    ss.gc()?;
    println!("Garbage collection complete on {}", root.display());
}
```

To jest publiczna podkomenda CLI (`fullmag session gc`), bez `--dry-run`, bez
potwierdzenia, z komunikatem sugerującym sukces.

### Zalecenie

1. **Natychmiast, niezależnie od refaktoryzacji:** wyłączyć podkomendę albo wymusić
   `--dry-run` jako domyślny tryb (wzorem ADR-0030, który dla prune wymaga dokładnie tego:
   *„Prune domyślnie wykonuje dry-run”*).
2. Naprawić `collect_live_refs`: przejść pełny graf korzeni (manifest sesji → `run_refs` →
   manifesty runów → checkpointy → deskryptory → chunki → recovery → pinned solutions).
3. Ująć to jako **warunek wejścia do P0**, nie jako element P6. Plan słusznie wymaga
   w §20.3, by GC uwzględniał „wszystkie te korzenie”; tutaj mamy dowód, że dziś nie
   uwzględnia nawet jednego poziomu pośredniego.
4. `CAE-47` powinien zostać przepisany tak, by testował konkretnie: run aktywny + solution
   przypięte + checkpoint z chunkami → `gc()` → **żaden obiekt nie znika**.

---

## L4 — Brak `fsync`: „atomic write” nie jest trwały

**Waga: wysoka. Dotyczy §20.2, CAE-45, spike „Working store durability”.**

`crates/fullmag-session/src/store.rs:352-358`
```rust
fn atomic_write(dest: &Path, data: &[u8]) -> Result<()> {
    let temp = dest.with_extension("part");
    fs::write(&temp, data)?;      // brak sync_all()
    fs::rename(&temp, dest)?;     // brak fsync katalogu
    Ok(())
}
```

`crates/fullmag-session/src/cas.rs:36-46`
```rust
let mut f = fs::File::create(&temp_path)?;
f.write_all(data)?;
f.flush()?;                        // flush bufora usera, NIE fsync
}
fs::rename(&temp_path, &dest)?;    // brak fsync katalogu
```

`flush()` opróżnia bufor `File` w przestrzeni użytkownika; **nie wymusza zapisu na nośnik**.
Po utracie zasilania lub twardym zabiciu procesu możliwy jest stan, w którym `rename` jest
widoczny, a zawartość pliku — nie. Dotyczy to `commit_session`, `commit_run`,
`commit_checkpoint`, `write_document`, `write_recovery` i wszystkich obiektów CAS.

Plan §20.2 pisze: *„Na lokalnym systemie plików wymagamy zweryfikowanego kontraktu
zapisu/flush/rename”* — słusznie, ale bez świadomości, że **dziś ten kontrakt nie jest
spełniony nawet w najprostszym przypadku**.

**Drugi, mniejszy defekt w tym samym miejscu:** `dest.with_extension("part")` zamienia
rozszerzenie zamiast je dodawać. Dla `manifest.json` temp to `manifest.part`. Dwa różne
pliki o wspólnym rdzeniu nazwy w jednym katalogu (`x.json`, `x.bin`) kolidują na
`x.part`. Bezpieczniejsze: `<nazwa>.<pid>.<uuid>.part`.

**Trzeci:** `commit_checkpoint` (`store.rs:115-136`) zapisuje `checkpoint.json`, a potem
`common_state.json` dwoma niezależnymi `atomic_write`. Awaria między nimi zostawia
checkpoint wskazujący nieistniejący stan. To jest dokładnie przypadek, dla którego
K10 wprowadza dwuetapową publikację — warto ten przykład w K10 zacytować jako uzasadnienie.

### Zalecenie

Spike „Working store durability” przenieść **przed P1** (dziś jest w luźnej liście §6
`03-migracja.md`), z minimalnym zakresem: `sync_all()` na pliku, `fsync` katalogu po
`rename`, unikalne nazwy temp, kolejność publikacji stan→manifest, test fault-injection
na NTFS i na udziale sieciowym.

---

## L5 — Skala `/sessions/current` jest ~10× większa, niż zakłada §22

**Waga: wysoka. Dotyczy §22, ADR-CAE-14, faz P3 i P8.**

Pomiar na `crates/fullmag-api/src/router_v2/handlers`:

```text
path = "/v2/sessions/current/*"   : 288
path = "/v2/sessions/<cokolwiek innego>" : 0
path = "/v2/platform/*"           :   5
-------------------------------------------
razem udokumentowanych ścieżek v2 : 293
```

Poza handlerami: 59 plików `.rs` w `crates/`, 64 pliki w `scripts/`, 43 pliki w
`apps/control-room/scripts/` zawierają literał `sessions/current`.

§22 planu mówi: *„`/sessions/current` pozostaje **wyłącznie ograniczonym adapterem
zgodności**”*. Przy 288/293 endpointach „ograniczony adapter” obejmuje **98,3%
powierzchni kontrolnej produktu**. Taki adapter nie jest wyjątkiem — jest główną ścieżką,
i będzie nią jeszcze przez wiele faz.

Dodatkowo: **nie istnieje ani jeden endpoint adresowany po `session_id`**. Nie ma więc
nawet punktu zaczepienia typu „przekaż jawny identyfikator zamiast `current`”. Skok
z `current` na `project_id` jest skokiem z zera.

### Zalecenie

1. Przeredagować §22: zamiast „ograniczony adapter” — **„adapter obejmujący początkowo
   całą powierzchnię v2, wygaszany endpoint po endpoincie według rejestru migracji”**,
   z jawnym licznikiem postępu (`migrated / 288`) jako miarą fazy P3→P8.
2. Wprowadzić krok pośredni, którego plan nie ma: **`/v2/sessions/{session_id}/...`
   przed `/v2/projects/{project_id}/...`**. To jest tania zmiana (routing + fasada
   `apiPaths.ts` + regeneracja OpenAPI), która natychmiast usuwa niejawny globalny
   kontekst z 288 ścieżek i pozwala wykryć wszystkie miejsca, które dziś milcząco polegają
   na „current”. Dopiero potem sensowne jest wprowadzenie projektu jako korzenia.
3. Uzupełnić bramę P8 o warunek: `grep -c "sessions/current"` w `crates/` **poza
   adapterem** = 0.

---

## L6 — Pominięty crate `fullmag-quantities` i inne istniejące fundamenty

**Waga: średnia.**

Mapa pakietów w `03-migracja.md` §2 nie wymienia trzech crate'ów obecnych w
`Cargo.toml:2-19`: `fullmag-quantities`, `fullmag-bench`, `fullmag-build-info`.

Pominięcie `fullmag-quantities` jest merytorycznie istotne. Crate ma **3 033 linie**
i moduły: `catalog.rs`, `descriptor.rs`, `eval.rs`, `id.rs`, `provider.rs`,
`reduction.rs`, `registry.rs`, `schema_version.rs`, `step_data.rs`, `transport.rs`.
Jest powiązany z ADR-0004 („backend canonical quantities”, accepted).

To jest **istniejący właściciel katalogu wielkości fizycznych, ich deskryptorów,
ewaluacji i redukcji** — czyli dokładnie fundament, na którym mają stanąć:
- `FieldDescriptor` z K11 (semantyczny quantity ID, jednostka, tensor rank, frame),
- `DerivedValueDefinition` z K12 (`expression/operator + integration/support measure`),
- „quantity providers”, o których §P6 planu wspomina jednym zdaniem, nie nazywając crate'u.

**Zalecenie:** dopisać wiersz do tabeli §2:

> | `fullmag-quantities` | Kanoniczny katalog wielkości, deskryptory, ewaluacja i redukcje; fundament `FieldDescriptor` i `DerivedValueDefinition` | Bez zależności od UI, transportu HTTP i konkretnego runu. |

oraz w §19.3 zastąpić ogólne „Rozwijamy tę warstwę” odwołaniem do `fullmag-quantities`
i ADR-0004.

---

## Ustalenia dodatkowe (niższa waga, ale warte poprawki)

### D-A. `sessionEpoch` istnieje już w UI — plan tego nie odnotowuje

`apps/control-room/src/kernel/resources/sessionResourceIdentity.ts:3-6, 31-36`:
```ts
export interface SessionResourceIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: string;
}
export function sessionScopedResourceKey(identity, resourceKey) {
  return `session=${...sessionId}&epoch=${...sessionEpoch}|${resourceKey}`;
}
```

Frontend ma już **prymitywną wersję `OwnershipEpoch` z K02** — klucze zasobów są
unieważniane przy zmianie epoki sesji. Plan mówi „W UI nie ma pojęcia projectId ani runId”
(cytat Gemini) i ma rację, ale pomija, że **mechanizm epoki już działa** i jest naturalnym
miejscem dopięcia `projectId`/`runId`. To obniża koszt K02 po stronie UI.

### D-B. `.fms` — `run_refs` istnieje, ale nie ma `project_refs` ani indeksu solutions

`FmsSessionManifest` (`types.rs:48-90`) ma `run_refs: Vec<String>`. Nie ma odpowiednika
dla `solutions`, `datasets` ani `plots`. K14 proponuje katalogi `solutions/<id>/`,
`datasets/definitions.json` — to jest **rozszerzenie manifestu**, nie tylko rozszerzenie
układu plików. Warto to w K14 powiedzieć wprost, bo inaczej migracja P6 natrafi na
manifest bez miejsca na te referencje.

### D-C. Blokada `LOCK` jest PID-owa i niebezpieczna na udziałach sieciowych

`store.rs:274-301`: `try_lock` czyta `LOCK`, sprawdza `is_pid_alive(lock.pid)` i **usuwa
„stale lock”**, jeśli PID nie żyje. Struktura zapisuje też `host`, ale `is_pid_alive`
sprawdza PID **lokalnie**. Na współdzielonym katalogu (a plan §20.2 i §24 dopuszczają taki
scenariusz) dwa hosty z przypadkowo zgodnymi PID-ami — albo host, na którym proces o danym
PID nie istnieje — doprowadzą do usunięcia cudzej blokady i dwóch writerów.

K01 mówi *„W pierwszym wdrożeniu jeden projekt ma jednego writera”*. Ten mechanizm tego
**nie gwarantuje**. Do spike'u „Working store durability” dodać: weryfikacja `host` przed
usunięciem stale locka, lease z czasem wygaśnięcia, odmowa na nierozpoznanym FS.

### D-D. `CasStore::get` re-hashuje cały blob przy każdym odczycie

`cas.rs:56-68`:
```rust
let data = fs::read(&path)?;
let actual = hex_sha256(&data);
if actual != hash { bail!("CAS integrity error: ...") }
```
Każdy odczyt obiektu to pełny odczyt do RAM **plus** pełne SHA-256. Dla pól
wielogigabajtowych to sprawia, że scenariusz **CAE-37** („otwórz solved archive,
postprocessing bez solvera”) i **CAE-38** („zmień tylko skalę/komponent/przekrój”) będą
liniowo kosztowne w rozmiarze artefaktu, nawet gdy potrzebny jest jeden przekrój.
`put` również przyjmuje `&[u8]` — cały blob w pamięci, brak API strumieniowego.

To jest realny, mierzalny powód, dla którego rekomendacja „CAS dla metadanych, strumień
dla trajektorii” jest słuszna — i zarazem dowód, że jest **już stanem faktycznym**
(`crates/fullmag-runner/src/autosave_zarr.rs`, 485 linii, pisze poza CAS).
K14 powinien to zapisać jako **regułę** („CAS nie przyjmuje obiektów powyżej progu N;
dane objętościowe idą przez chunked store z osobnym manifestem pokrycia”), a nie zostawić
jako domyślną praktykę.

### D-E. `GeometryEntryIR` nie ma `Rotate` ani `Scale`

`crates/fullmag-ir/src/model.rs:40-130` — warianty: `ImportedGeometry`, `Box`, `Cylinder`,
`SinWaveguide`, `ArchWaveguide`, `Ellipsoid`, `Sphere`, `Ellipse`, `Difference`, `Union`,
`Intersection`, `Translate`. Natomiast `SceneDocument.Transform3D`
(`scene.rs:165-174`) niesie `rotation_quat` i `scale`.

Plan §8.1 przewiduje to poprawnie („Rotacja, skala, wzory, import, partycjonowanie…
są rozwijane jako kolejne typy cech”). Warto jednak dopisać do P2 jawny warunek bramy:
*„migracja nie może zgubić ani milcząco zignorować `rotation_quat`/`scale` obecnych
w istniejących dokumentach scene.v2 — albo są lowerowane, albo raportowane jako
nieobsługiwane”* — inaczej `.fms` roundtrip z §P1 przepuści cichą utratę danych, czego
brama P1 wprost zakazuje.

### D-F. `TensorChunk` ma podwójną tożsamość treści

`types.rs:427-433`: `object_ref: String` (hash CAS) **oraz** `sha256: Option<String>`.
Skoro CAS adresuje po SHA-256, te pola są redundantne albo znaczą co innego — a nie jest
to nigdzie udokumentowane. K02 wymaga rozdzielenia `id` / `revision` / `fingerprint`;
tutaj mamy dwa pola content-hash bez zdefiniowanej semantyki. Rozstrzygnąć przy
wprowadzaniu `C64`/`C128`.
