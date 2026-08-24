# Frozen spins — bardzo szczegółowa instrukcja implementacji punktów 3 i 4

## Cel dokumentu

Ten plik jest instrukcją wykonawczą dla kolejnego modelu, który ma domknąć
dwa zakresy zatwierdzonego planu produkcyjnego Frozen Spins. Dokument nie jest
dowodem ukończenia i nie upoważnia do oznaczenia funkcji jako produkcyjnej na
podstawie samej obecności kodu, kompilacji albo testu kontraktowego.

W tym dokumencie numeracja jest jawnie zmapowana na oryginalny plan
`docs/superpowers/plans/2026-08-20-frozen-spins-production-implementation.md`:

| Punkt | Odpowiada zadaniu | Zakres |
|---|---|---|
| **3** | **Task 14** | atomowa aktywacja, snapshot stanu, checkpoint/restart, persistence, telemetry i provenance |
| **4** | **Task 15** | Control Room: ribbon, Explorer, dedykowany Inspector, typed selector builder, FDM/FEM overlay i browser proof |

Punkt 3 ma zagwarantować, że wznowienie symulacji używa dokładnie tej samej
rozwiązanej maski i referencji, a nie ponownie uruchamia selektora. Punkt 4 ma
zagwarantować, że użytkownik może utworzyć, znaleźć, edytować, zweryfikować i
obejrzeć constraint w Control Room bez tworzenia drugiego modelu fizycznego.

---

## Instrukcja nadrzędna dla modelu wykonującego pracę

Pracuj w repozytorium `/home/kkingstoun/git/fullmag/fullmag`.

1. Przeczytaj `AGENTS.md` przed zmianą.
2. Zachowaj wszystkie niezwiązane zmiany w dirty worktree. Nie używaj
   `git reset --hard`, szerokiego formatowania, `git checkout --`, commitowania
   ani pushowania.
3. Przed edycją sprawdź:
   `git status --short`, `git diff --stat` oraz
   `git diff --cached --stat` w osobnych poleceniach.
4. Przeczytaj źródła semantyki:
   `docs/physics/0996-frozen-spins-constraint.md`,
   `docs/specs/frozen-spins-v1.md`,
   `docs/validation/frozen-spins-qualification-matrix.md` oraz
   `docs/adr/0026-frozen-spins-constraint-and-selection-model.md`.
5. Przeczytaj źródłowy Task 14 i Task 15 w
   `docs/superpowers/plans/2026-08-20-frozen-spins-production-implementation.md`.
6. Przed modyfikacją każdego symbolu wykonaj `rg` i otwórz cały plik, w którym
   symbol jest definiowany oraz pliki bezpośrednich konsumentów. Nie zakładaj,
   że aktualna nazwa albo layout pozostały bez zmian.
7. Dla backendu używaj istniejących recept `just` i managed runtime. Hostowe
   `cargo`, `cmake` i bezpośrednie binaria są pomocniczą diagnostyką, a nie
   końcowym dowodem native/GPU.
8. Dla frontendu trzymaj się resource-first API v2, centralnego
   `ControlRoomApi`, wygenerowanych typów, command registry i resource hooks.
   Komponent nie może budować endpointu ani wykonywać ręcznego `fetch`.
9. Wszystkie raporty, plany i komunikaty użytkowe pisz po polsku. Symbole,
   ścieżki, nazwy zmiennych i komentarze w kodzie pozostają po angielsku.
10. Po każdym etapie uruchom test właściwy dla tego etapu. Nie przechodź do
    kolejnego etapu po nieudanym teście przez wyciszenie asercji albo obniżenie
    tolerancji.

Jeżeli dwa źródła są sprzeczne, obowiązuje hierarchia z `AGENTS.md`:
physics note, architektura/spec, API i ProblemIR, dopiero potem UI i
implementacja backendowa. Nie rozszerzaj zakresu o nowe lane'y tylko dlatego,
że łatwo dodać flagę capability.

---

## 0. Stan wyjściowy i aktualne blokery

### 0.1. Co już istnieje

Przed rozpoczęciem pracy potwierdź obecność następujących elementów:

- `FrozenSpinsActivation` w
  `crates/fullmag-runner/src/constraints/activation.rs`;
- `FrozenSpinsCheckpointV1` w
  `crates/fullmag-runner/src/constraints/checkpoint.rs`;
- eksport walidacji i resume w
  `crates/fullmag-runner/src/lib.rs`;
- typy .fms, `SaveProfile`, `RestoreClass`,
  `FmsCheckpoint`, `CheckpointCompatibility` i `BackendStatePayload` w
  `crates/fullmag-session/src/types.rs`;
- endpointy checkpointów w
  `crates/fullmag-api/src/session_persistence.rs` i
  `crates/fullmag-api/src/router_v2/mod.rs`;
- aktualne dane `max_rhs_*`, `max_torque_*`, `frozen_dof_count` i
  `free_dof_count` w FDM CPU/reference;
- OpenAPI i resource facade dla Frozen Spins;
- ribbon command, Explorer node, `FrozenSpinsInspectorPanel`,
  `SelectionExpressionBuilder` i `FrozenSpinsOverlay`.

Obecność tych elementów oznacza, że repozytorium ma częściowy szkielet. Nie
oznacza poprawnej transakcji aktywacji, pełnego resume ani zdrowego browser
runtime.

### 0.2. Blokery, które muszą zostać rozwiązane

#### Punkt 3

1. `create_checkpoint` najpierw czyta snapshot, a dopiero potem bierze write
   lock i linkuje checkpoint. Między tymi operacjami stan może się zmienić.
   Implementacja musi wprowadzić compare-and-swap albo ponowną walidację
   capture tokenu.
2. `FrozenSpinsCheckpointV1` przechowuje maskę, referencję, magnetyzację,
   krok, czas i metadata, ale nie przechowuje automatycznie całej historii
   integratora ani RNG. Nie wolno nazywać każdego takiego resume
   `ExactResume`.
3. `read_checkpoint_coupled_state` akceptuje obecnie tylko backend family
   `fdm_cpu_reference` i wybrane integrator kinds. CUDA i FEM nie mogą zostać
   dopisane do listy przez samą zmianę stringa; potrzebują rzeczywistego,
   zweryfikowanego restore path.
4. `coupled_checkpoint` jest wewnętrznym polem snapshotu i nie może stać się
   nieudokumentowanym publicznym modelem UI. Publiczna persistence ma używać
   typed `FmsCheckpoint` i typed backend envelope.
5. Telemetry musi rozróżniać `free` od `all`; stary alias `max_torque_Apm` i
   `max_rhs_norm_per_s` nie może przypadkiem zacząć oznaczać wartości po
   wszystkich DOF.

#### Punkt 4

1. W `frozenSpinsResources.ts` klucz resource jest obecnie składany z
   `resourceKey#revision=...`. Zmiana rewizji może zmienić tożsamość resource
   i zremontować Inspector. Rewizja ma unieważniać snapshot, nie zmieniać
   stabilnej tożsamości targetu React.
2. Ribbon używa obecnie warunku `lane === "fdm"`. Gating musi wynikać z
   capability/resource i dokładnego carrier contractu, nie z nazwy dyskretyzacji.
3. `frozenSpinsNodes` wywołuje się pod object/region i zwraca pusto dla
   negacji albo niejednoznacznego właściciela. W ten sposób poprawny constraint
   może zniknąć z drzewa. Potrzebny jest jawny węzeł globalny/unscoped.
4. Overlay otrzymuje `femTrueDofPositions: null`, ponieważ API nie publikuje
   jeszcze autorytatywnego carrieru exact true-DOF. Nie wolno użyć w jego
   miejsce wierzchołków topologii ani punktów wizualizacyjnych.
5. Aktualne testy statyczne i focused Vitest nie są browser proof. Potrzebna
   jest rzeczywista przeglądarka z canvasem, zdrowym WebGL i niezerowym
   drawing buffer.

Każdy z tych punktów ma zostać albo naprawiony, albo pozostać jawnie
`UNSUPPORTED`/`BLOCKED` z nazwanym powodem. Ciche pominięcie constraintu jest
błędem.

---

# Punkt 3 — atomowy snapshot, checkpoint/restart, persistence i provenance

## 1. Kontrakt semantyczny punktu 3

### 1.1. Terminologia

W implementacji rozróżnij następujące obiekty:

| Obiekt | Znaczenie | Czy może się zmienić bez nowej aktywacji? |
|---|---|---|
| authored selector | selector z Python/ProblemIR/UI | tak, ale zmiana tworzy nowy plan |
| resolved mask | literalna maska w przestrzeni true DOF backendu | nie |
| resolved reference | `m*` dla każdego DOF zamrożonego | nie |
| activation epoch | monotoniczny identyfikator snapshotu | nie; nowy snapshot ma nowy epoch |
| source state revision | rewizja magnetyzacji/pola użytej do capture | nie |
| topology fingerprint | tożsamość grid/mesh/DOF ordering | nie |
| runtime state | bieżące `m`, czas, `dt`, integrator state | tak po zaakceptowanym kroku |
| checkpoint artifact | trwały zapis runtime state + constraint state | nie po zapisaniu |
| preview | obliczenie planu do UI | nie jest aktywacją runtime |

Resolved mask i reference są danymi runtime, a nie ponownie interpretowanym
selector expression. Resume musi odtworzyć literalny snapshot, nawet jeśli
bieżący model ma ten sam selector, lecz inną rewizję stanu albo topologię.

### 1.2. Inwarianty

Poniższe reguły są obowiązkowe:

1. Jedna aktywacja ma jeden `activation_epoch`, jeden
   `source_state_revision`, jeden `topology_fingerprint`, jeden
   `mask_sha256` i jeden `reference_sha256`.
2. Maska ma długość odpowiadającą dokładnie backendowej przestrzeni true DOF.
   Nie używaj indeksów UI, indeksów elementów FEM ani kolejności renderera.
3. Reference ma dokładnie trzy składowe na każdy true DOF i nie zawiera NaN
   ani nieskończoności.
4. `frozen_dof_count` jest liczbą ustawionych bitów maski.
   `free_dof_count` oznacza aktywne, niezamrożone DOF. Te liczby nie są
   wyliczane ponownie z aktualnego `m` podczas resume.
5. Interakcje mogą używać pełnego stanu w obliczeniu pól, ale finalny RHS i
   stan kandydata są projektowane zgodnie z constraintem.
6. Selekcja jest ewaluowana przy aktywacji/preview zgodnie z polityką. Resume
   nigdy nie wykonuje ponownie `selector -> mask`.
7. Nieudana aktywacja nie może zmienić aktywnej maski, referencji, epoch ani
   bieżącego solver state.
8. Nieudane restore nie może zmienić żadnego pola snapshotu, statusu ani
   rewizji. Najpierw walidacja, potem jedna mutacja.
9. Po udanym restore runtime staje się `paused`, rosną rewizje stanu i pola,
   a realtime emituje wyłącznie invalidation/resource event.
10. Żadna ścieżka forced GPU nie może wykonać CPU fallbacku i opisać wyniku jako
    GPU.

### 1.3. ExactResume a LogicalResume

Używaj `RestoreClass` z `crates/fullmag-session/src/types.rs` zgodnie z
następującą definicją:

- `ExactResume` tylko wtedy, gdy checkpoint zawiera wszystkie dane wymagane do
  odtworzenia stanu integratora, RNG (jeśli termika jest aktywna), backend
  state, precision, engine ABI, planu, topologii i orderingu oraz gdy runtime
  potwierdza zgodność tych danych.
- `LogicalResume`, gdy maska, reference i magnetyzacja są zgodne, ale runtime
  rekonstruuje integrator albo może użyć innego dopuszczonego silnika. Wynik ma
  być fizycznie kompatybilny, ale nie wolno obiecywać bitwise continuation.
- `InitialConditionImport`, gdy przywracana jest sama magnetyzacja jako stan
  początkowy nowego runu.
- `ConfigOnly`, gdy przywrócono tylko model/script/UI.

Obecny `FrozenSpinsCheckpointV1` nie zawiera z definicji pełnej historii
integratora i RNG. Dla takiego payloadu domyślnie wybierz
`LogicalResume`, chyba że konkretny lane ma dodatkowy backend envelope, który
udowodniono testem exact continuation. Nie zmieniaj enumu ani opisu
`ExactResume` tylko po to, aby zielony był test endpointu.

## 2. Mapa źródeł i odpowiedzialności

Przed zmianą otwórz wszystkie poniższe pliki:

| Plik/symbol | Odpowiedzialność | Wymagana kontrola |
|---|---|---|
| `crates/fullmag-runner/src/constraints/activation.rs` / `FrozenSpinsActivation` | identity aktywacji | schema, epoch, source revision, topology |
| `crates/fullmag-runner/src/constraints/checkpoint.rs` / `FrozenSpinsCheckpointV1` | mask/reference codec | długości, hashe, counts, finite values, schema |
| `crates/fullmag-runner/src/lib.rs` / `validate_frozen_spins_checkpoint_value`, `resume_reference_fdm_from_frozen_spins_checkpoint` | granica restore runnera | brak selector recapture |
| `crates/fullmag-runner/src/interactive_runtime.rs` | StepUpdate/live state | epoch, counts, free/all telemetry, provenance |
| `crates/fullmag-session/src/types.rs` | .fms contract | profiles, compatibility, backend envelope |
| `crates/fullmag-api/src/session_persistence.rs` | capture/list/get/restore | CAS capture, validate-before-mutate, revisions |
| `crates/fullmag-api/src/router_v2/mod.rs` | route registration | API v2 paths i sesja current |
| `crates/fullmag-api/src/router_v2/handlers/persistence/session.rs` | OpenAPI handler declarations | schemas i status codes |
| `crates/fullmag-api/src/openapi_v2.rs` | generated OpenAPI source | nowe/zmienione request/response types |
| `crates/fullmag-api/src/schemas/status.rs` i `runtime.rs` | public status contract | thin status, canonical fields |
| `crates/fullmag-runner/src/scalar_metrics.rs` | scalar rows | free/all alias policy |
| `crates/fullmag-quantities/src/step_data.rs` | step telemetry | source of truth dla countów/metrics |
| `crates/fullmag-cli/src/live_workspace.rs` i `step_utils.rs` | CLI/live resume | envelope i artefakty |
| `crates/fullmag-api/src/router_v2/tests.rs` | API concurrency/identity tests | stale revisions i no mutation |

Nie dodawaj drugiego typu checkpointu tylko dlatego, że `coupled_checkpoint`
jest obecnie `serde_json::Value`. Zachowaj kompatybilność odczytu, ale nowy
kod powinien konstruować i walidować typed `FmsCheckpoint` oraz
`FrozenSpinsCheckpointV1`.

## 3. Atomowa aktywacja — algorytm implementacyjny

### 3.1. Dane wejściowe transakcji

Transakcja aktywacji musi pracować na jednym immutable input snapshot. Snapshot
powinien zawierać co najmniej:

~~~text
expected_model_revision
expected_source_state_revision
expected_topology_fingerprint
constraint_ids
authored selector fingerprints
current magnetization in backend ordering
backend/device/precision
stage and activation policy
~~~

Jeżeli aktualny runtime nie ma jednego typu dla tego snapshotu, utwórz
wewnętrzny typed agregat w module constraints. Nie rozrzucaj osobnych
`frozen_mask`/`reference`/`epoch` po kilku strukturach.

### 3.2. Kolejność transakcji

Zaimplementuj kolejność dokładnie tak:

1. **Read/lock.** Zdobądź snapshot przez istniejący właściciel stanu. Odczytaj
   model revision, source state revision, topology fingerprint, aktywne
   constraints, magnetyzację i backend identity.
2. **Precondition.** Jeżeli caller przekazał oczekiwane rewizje, porównaj je
   ze snapshotem. Błąd ma być typed i zawierać expected/found.
3. **Resolve once.** Wywołaj canonical selector evaluator jeden raz. Zbuduj
   literalną maskę w true-DOF space i referencję według
   `capture_current_at_activation` albo jawnej polityki.
4. **Validate payload.** Sprawdź długości, finite values, aktywną domenę,
   counts, topology, hash maski i hash referencji. `all_active_dofs_frozen`
   jest legalnym przypadkiem i musi mieć jawny stop policy.
5. **Reserve epoch.** Przydziel monotoniczny epoch. Epoch 0 jest nieważny.
   Epoch przydzielony próbie, która nie zostanie zatwierdzona, nie może
   zostać ponownie użyty w tym runie.
6. **Build immutable activation.** Utwórz `FrozenSpinsActivation` i plan
   checkpointowalny, bez modyfikowania jeszcze aktywnego runtime state.
7. **Commit/CAS.** Weź write lock i porównaj ponownie wszystkie wartości
   read-snapshotu. Jeżeli którakolwiek się zmieniła, odrzuć całą próbę jako
   `frozen_spins_activation_stale_state`; nie podmieniaj części stanu.
8. **Publish.** Dopiero po udanym CAS podmień activation, mask/reference,
   plan fingerprint i runtime counters. Zwiększ state/resource revision.
9. **Invalidate.** Opublikuj invalidation dla odpowiednich resources. Nie
   wysyłaj dużej maski ani magnetyzacji w websocket statusie.
10. **Return.** Zwróć epoch, hashes, counts, source/topology identity,
    requested/resolved backend i restore/activation provenance.

Pseudokod granicy commit:

~~~text
read_snapshot = state.read()
resolved = resolve_selector_once(read_snapshot)
candidate = validate_and_build_activation(resolved, read_snapshot)

state.write(|current| {
    if current.model_revision != read_snapshot.model_revision
       or current.source_state_revision != read_snapshot.source_state_revision
       or current.topology_fingerprint != read_snapshot.topology_fingerprint
       or current.constraint_revision != read_snapshot.constraint_revision {
        return stale_activation
    }
    current.commit(candidate)
    current.state_version += 1
    return committed
})
~~~

Nie wykonuj selector evaluation po write locku na częściowo zmienionym stanie.
Jeżeli evaluator wymaga locka, zbuduj niezmienny snapshot pod read lockiem i
ewaluuj ten snapshot, a potem wykonaj CAS.

### 3.3. Wyścigi, które muszą mieć test

| Wyścig | Oczekiwany wynik |
|---|---|
| preview A kończy się po zmianie source revision | preview `current=false` albo typed stale error; nigdy current |
| aktywacja A i edycja constraint B | wygrywa dokładnie jedna rewizja; druga dostaje conflict |
| dwa równoległe activation commands | jeden epoch zostaje aktywny, drugi nie mutuje stanu |
| create checkpoint capture podczas kroku | checkpoint jest albo z dokładnego snapshotu, albo odrzucony jako stale; nie może linkować obcej rewizji |
| restore podczas patch modelu | jedna operacja dostaje conflict; brak częściowej mutacji |
| delete constraint podczas preview | preview nie staje się aktywny przez nieaktualny constraint |

### 3.4. Error contract

Nie zwracaj ogólnego `invalid argument`. Utrzymuj stabilne kody:

~~~text
frozen_spins_activation_stale_state
frozen_spins_activation_topology_mismatch
frozen_spins_activation_source_revision_mismatch
frozen_spins_activation_mask_length_mismatch
frozen_spins_activation_reference_length_mismatch
frozen_spins_activation_non_finite_reference
frozen_spins_activation_empty_selection
frozen_spins_activation_all_dofs_frozen
frozen_spins_checkpoint_schema_unsupported
frozen_spins_checkpoint_constraint_identity_mismatch
frozen_spins_checkpoint_topology_mismatch
frozen_spins_checkpoint_source_revision_mismatch
frozen_spins_checkpoint_mask_mismatch
frozen_spins_checkpoint_state_length_mismatch
frozen_spins_checkpoint_integrator_state_missing
frozen_spins_checkpoint_backend_unqualified
~~~

Każdy błąd powinien zawierać etap (`preview`, `activation`, `capture`,
`restore`), expected/found identity, jeżeli dotyczy, i informację, czy stan
pozostał niezmieniony.

## 4. Checkpoint codec i trwały payload

### 4.1. Obecny FrozenSpinsCheckpointV1

Nie zmieniaj znaczenia istniejących pól:

| Pole | Reguła |
|---|---|
| `schema` | dokładnie `fullmag.frozen_spins.checkpoint.v1` |
| `constraint_ids` | kolejność zgodna z resolved plan |
| `authored_fingerprints` | hash authored selectorów, nie tylko nazwa |
| `activation` | schema, epoch, membership policy, source revision, topology |
| `mask_len` | liczba true DOF |
| `mask_bits` | packed LSB-first, osiem DOF na bajt |
| `mask_sha256` | hash canonical unpacked maski według istniejącej funkcji |
| `reference` | trzy wartości na DOF, w backend ordering |
| `reference_sha256` | hash długości i bitowej reprezentacji f64 |
| `active_dof_count` | liczba aktywnych DOF planu |
| `frozen_dof_count` | liczba bitów true |
| `free_dof_count` | active minus frozen |
| `backend/device/precision` | resolved execution identity, nie żądanie użytkownika |
| `step/time_s/dt` | stan czasowy checkpointu |
| `magnetization` | pełny stan w tej samej kolejności co maska/reference |

`validate_structure` ma być używane przed odczytem payloadu, a
`validate_for_plan` na granicy wykonania. Obie walidacje są potrzebne:
 pierwsza chroni store/import, druga chroni aktualny runtime.

### 4.2. Wersjonowanie

`#[serde(deny_unknown_fields)]` oznacza, że nie dopisuj pól do V1 bez zmiany
kontraktu. Jeżeli nowe pole wpływa na restore semantics:

1. utwórz nowy schema string, np. `fullmag.frozen_spins.checkpoint.v2`;
2. dodaj osobny Rust type lub jawny versioned enum;
3. zachowaj dekoder V1;
4. dodaj migrację tylko wtedy, gdy można udowodnić brak utraty informacji;
5. aktualizuj .fms compatibility i OpenAPI/source map;
6. testuj round-trip każdego schema.

Nie używaj `serde_json::Value` do omijania unknown-field validation.

### 4.3. FmsCheckpoint i backend envelope

W .fms zapisuj:

1. `FmsCheckpoint` z `common_state_ref`;
2. `backend_state_ref` do `BackendStatePayload`;
3. `integrator_ref`, jeżeli istnieje pełny integrator history;
4. `rng_ref`, jeżeli termika/RNG jest aktywna;
5. field refs zgodnie z profilem;
6. Frozen Spins payload jako typed backend state lub osobny artefakt
   `constraints/frozen_spins_checkpoint.v1.json`, ale zawsze z referencją w
   manifest/compatibility.

`BackendStatePayload` dla kwalifikowanego Frozen Spins powinien mieć:

~~~json
{
  "format": "fullmag.backend_state.v1",
  "backend_family": "fdm_cpu_reference",
  "integrator_kind": "frozen_spins",
  "integrator_state": {
    "frozen_spins_checkpoint_schema": "fullmag.frozen_spins.checkpoint.v1",
    "checkpoint_ref": "runs/<run>/checkpoints/<id>/constraints/frozen_spins_checkpoint.v1.json"
  },
  "rng_state": null,
  "extra": {}
}
~~~

Wartości w przykładzie są kontraktem kształtu, nie gotowym artefaktem do
skopiowania. `run`, ID i hashes pochodzą z rzeczywistego capture.

### 4.4. Kiedy można zwrócić ExactResume

Przed zwróceniem `ExactResume` sprawdź wszystkie elementy:

- `restart_abi`;
- `problem_hash`;
- `plan_hash`;
- `state_schema_version`;
- `engine_id`;
- `runtime_family`;
- `precision`;
- `study_kind`;
- `discretization_signature`;
- `field_layout_signature`;
- Frozen mask/reference schema, hashes, epoch i topology;
- pełny integrator state;
- RNG state i nonce, jeżeli używany;
- backend/device policy zgodna z deklarowanym exact lane.

Jeżeli choć jednego elementu brakuje, zwróć `LogicalResume` albo typed
`frozen_spins_checkpoint_integrator_state_missing`. Nie ukrywaj brakującego
integrator state przez odtworzenie tylko `m`.

### 4.5. Restore bez recapture

Granica resume ma wykonywać:

1. odczyt checkpoint artifact;
2. walidację schema/length/hash/finite;
3. odczyt bieżącego planu i sprawdzenie constraint IDs/fingerprints;
4. sprawdzenie topology/source revision według polityki restore;
5. `restore_engine_state` z literalnej maski/reference;
6. odtworzenie magnetyzacji, czasu, `dt`, integrator/RNG/backend state;
7. ustawienie statusu paused;
8. zwiększenie state i field revisions;
9. publikację invalidation;
10. dopiero później możliwość resume/run command.

Nie wolno wywołać `resolve_selector`, `capture_at_activation` ani pobrać
bieżącego `m` jako nowej reference. Aktualne `m` służy wyłącznie do walidacji
zgodności, jeżeli kontrakt danego lane'u tego wymaga.

## 5. API persistence i bezpieczne linkowanie

### 5.1. Aktualne trasy

Zachowaj i zweryfikuj:

| Metoda | Trasa | Znaczenie |
|---|---|---|
| GET | `/v2/sessions/current/persistence/checkpoints` | lista checkpointów bieżącego runu |
| GET | `/v2/sessions/current/persistence/checkpoints/{checkpoint_id}` | metadata checkpointu |
| POST | `/v2/sessions/current/persistence/checkpoints` | capture aktualnego snapshotu |
| POST | `/v2/sessions/current/persistence/checkpoints/{checkpoint_id}/restore` | validate + restore + paused |

Nie dodawaj publicznej trasy /v1 ani endpointu specyficznego dla komponentu UI.

### 5.2. Naprawa capture/link race

Obecny przepływ `create_checkpoint` ma read lock podczas capture, a później
write lock tylko przy linkowaniu. Zastąp go jednym z dwóch równoważnych,
jawnie przetestowanych mechanizmów:

**Wariant A — capture token i CAS**

1. Pod read lockiem zbuduj `CaptureContext` zawierający
   `run_id`, `state_version`, `field_catalog_revision`,
   `field_samples_revision`, `stage_id`, `activation_epoch`,
   `topology_fingerprint` i current checkpoint identity.
2. Capture zapisuje artefakt z tym tokenem.
3. Pod write lockiem porównaj cały token z aktualnym snapshotem.
4. Linkuj tylko przy pełnej zgodności.
5. Przy rozbieżności zwróć `409 checkpoint_capture_stale_state`; nie zwracaj
   checkpointu jako aktywnego. Osierocony artefakt musi być oznaczony do
   garbage collection albo jawnie pozostawiony jako unlinked.

**Wariant B — capture pod write lockiem**

Można trzymać write lock podczas krótkiego capture metadata, ale nie wolno
blokować nim dużego zapisu pola, jeśli architektura store tego zabrania.
Wtedy nadal potrzebny jest token dla zapisu artefaktów.

Preferowany jest wariant A, jeśli istniejący store nie pozwala bezpiecznie
trzymać write locka przez cały capture.

### 5.3. Request/response

Aktualny `CheckpointCreateRequest` ma `profile` i `reason`, a
`CheckpointRestoreRequest` ma `reason`. Można dodać opcjonalne
`expected_state_version` do obu requestów dla klienta optimistic, ale backend
nie może polegać wyłącznie na tym polu. CAS z `CaptureContext` jest obowiązkowy
nawet przy braku pola w request.

Jeżeli request/response się zmieni:

1. zmień Rust `ToSchema`;
2. zmień deklarację handlera w
   `crates/fullmag-api/src/router_v2/handlers/persistence/session.rs`;
3. odśwież `openapi-v2.json` i `openapi-v2-types.ts` repozytoryjnym generatorem;
4. sprawdź `ControlRoomApi` i typy facade;
5. dodaj test zgodności schema, nie edytuj wygenerowanego pliku ręcznie bez
   uruchomienia generatora.

`CheckpointEntry` musi jasno informować o `backend_family`, `resume_class`,
`artifact_ref`, `field_revision`, `mesh_revision`/`scene_revision`, jeśli są
dostępne. Nie twórz statusu `ExactResume`, gdy payload ma wyłącznie
magnetyzację.

### 5.4. Restore validate-before-mutate

W `restore_checkpoint` zachowaj następującą kolejność:

1. weź write lock albo przygotuj immutable candidate;
2. odczytaj checkpoint i wszystkie referenced artifacts;
3. zweryfikuj run ID i ownership;
4. zweryfikuj `common_state` kształt i finite;
5. odczytaj Frozen checkpoint;
6. porównaj active/candidate constraint schema, IDs, authored fingerprints,
   activation epoch policy, mask hash, reference hash, counts, topology,
   backend/device/precision;
7. wyznacz `RestoreClass`;
8. dopiero po pełnym sukcesie mutuj live state;
9. zwiększ rewizje i ustaw paused;
10. publish invalidation.

Wszystkie błędy z kroków 2–7 muszą pozostawić snapshot bitowo niezmieniony
poza ewentualnym lokalnym cache odczytu.

## 6. CLI, interactive runtime i live provenance

### 6.1. CLI artifact flow

Sprawdź:

- `crates/fullmag-cli/src/orchestrator.rs`,
  `frozen_spins_checkpoint_from_stage_artifacts`;
- `crates/fullmag-cli/src/step_utils.rs`;
- parsery `resume-json` i raw/backend envelope;
- `crates/fullmag-cli/src/live_workspace.rs`.

CLI ma:

1. zapisywać ścieżkę do frozen checkpoint artifact w manifest;
2. przy `resume` rozpoznawać raw V1 i backend envelope;
3. walidować mask/reference przed uruchomieniem solvera;
4. pokazywać resolved backend/device/precision, a nie tylko requested;
5. zachować activation epoch przy pauzie i wznowieniu;
6. zakończyć się błędem, gdy wymuszony backend nie ma restore support;
7. nie tworzyć nowej reference z bieżącego stanu;
8. emitować ten sam contract co interactive runtime.

### 6.2. StepUpdate i status

W `StepUpdate`, `StepData`, scalar metrics i status v2 rozdziel:

| Pole | Znaczenie |
|---|---|
| `max_rhs_norm_per_s` | istniejący alias wartości free; nie zmieniaj mu znaczenia po cichu |
| `max_rhs_all_norm_per_s` | maksimum po wszystkich aktywnych DOF |
| `max_torque_Apm` | istniejący alias wartości free |
| `max_torque_all_Apm` | torque po wszystkich aktywnych DOF |
| `frozen_dof_count` | literalna liczba bitów maski |
| `free_dof_count` | aktywne DOF minus frozen |
| `max_constraint_error` | maksimum różnicy `m_frozen - reference` |
| `activation_epoch` | epoch aktywnej maski |
| `mask_sha256` | identity literalnej maski |
| `reference_sha256` | identity literalnej reference |
| `source_state_revision` | rewizja snapshotu capture |
| `topology_fingerprint` | identity grid/mesh/orderingu |
| `requested_backend/device/precision` | intencja użytkownika |
| `resolved_backend/device/precision` | faktyczne wykonanie |
| `restore_class` | exact/logical/initial/config |
| `stop_reason` | jawna przyczyna zatrzymania, także all-frozen |

Jeżeli istniejący typ nie ma miejsca na wszystkie pola, dodaj versioned
extension zamiast pakować je do niejawnego `extra`. Status JSON pozostaje
cienki: counts, identity, revisions i scalar summaries są dozwolone; pełna
maska i pełna magnetyzacja pozostają artifact/data plane.

### 6.3. All-frozen i brak wolnych DOF

Dla `free_dof_count == 0`:

- nie wykonuj redukcji z dzieleniem przez zero;
- nie zgłaszaj `NaN` jako zbieżności;
- ustaw jawny stop reason, np. `all_active_dofs_frozen`;
- zachowaj energię/pola i pełny stan magnetyzacji;
- telemetry nadal publikuje `all` i `free` zgodnie z kontraktem;
- checkpoint/restore zachowuje epoch i reference.

## 7. Testy punktu 3 — TDD i dowody

### 7.1. Testy aktywacji

Dodaj failing tests, zanim zmienisz implementację:

1. dwa równoległe activation commands — jeden commit, jeden conflict;
2. source revision zmienia się pomiędzy resolve i commit — stale error;
3. topology fingerprint zmienia się pomiędzy resolve i commit — stale error;
4. preview jest z innej rewizji niż activation — niecurrent albo conflict;
5. aktywacja po nieudanej walidacji nie zmienia poprzedniego epoch;
6. selector jest wywołany raz i nie jest wywołany podczas resume;
7. all-frozen kończy się bez NaN.

Przykładowe miejsca:

~~~text
cargo test -p fullmag-runner constraints::activation -- --nocapture
cargo test -p fullmag-runner constraints::checkpoint -- --nocapture
~~~

Dopasuj nazwy testów do faktycznego modułu po `rg`; nie twórz komendy na
nieistniejący target.

### 7.2. Checkpoint parity

Dla FDM CPU reference przygotuj jeden nietrywialny przypadek z co najmniej
jednym frozen i jednym free DOF:

1. uruchom `N` kroków bez przerwy;
2. uruchom `K` kroków i zapisz checkpoint;
3. odtwórz checkpoint bez ponownego selector evaluation;
4. uruchom pozostałe `N-K` kroków;
5. porównaj free state, frozen state, time, dt, energy i telemetry;
6. sprawdź, że frozen state równa się zapisanej reference po każdym kroku.

Osobne przypadki:

- zmieniony grid/mesh fingerprint — hard error przed mutacją;
- zmieniona maska — mask mismatch;
- zmieniony authored fingerprint — constraint identity mismatch;
- zła długość packed bitset — payload integrity error;
- NaN/infinity w reference/magnetyzacji — non-finite error;
- checkpoint magnetization-only podczas aktywnego coupled runtime — rejected;
- backend CUDA/FEM bez restore implementation — explicit unsupported, zero
  fallback.

### 7.3. Persistence i concurrency

Dodaj testy handlera/API:

- capture w trakcie zmiany `state_version`: nie może linkować starego snapshotu;
- dwa captures na tej samej rewizji: zgodnie z polityką oba mogą mieć osobne
  artefakty, ale żaden nie może wskazać innej rewizji;
- stale `expected_state_version`: typed conflict;
- restore candidate z innym topology/mask/reference: no mutation;
- poprawny restore zwiększa `state_version`, `field_catalog_revision` i
  `m` field revision;
- restore ustawia status `paused` i publikuje invalidation;
- `CheckpointEntry.resume_class` jest zgodny z rzeczywistym payloadem;
- `GET list/get` nie ujawnia checkpointu z innego run ID.

Przykładowe komendy po znalezieniu rzeczywistych nazw:

~~~text
cargo test -p fullmag-api session_persistence -- --nocapture
cargo test -p fullmag-api router_v2::tests -- --nocapture
cargo test -p fullmag-session frozen_spins_checkpoint -- --nocapture
cargo test -p fullmag-cli -- frozen_spins_checkpoint --nocapture
~~~

### 7.4. Telemetry/provenance

Sprawdź, że:

- FDM CPU publikuje free/all i count;
- lane bez frozen nie zmienia dotychczasowych wartości;
- legacy aliasy mapują na free;
- mask/reference hashes pojawiają się tylko wtedy, gdy constraint jest aktywny;
- requested i resolved nie są scalone;
- forced GPU error nie ma `resolved_backend=cpu`;
- `max_constraint_error` jest finite i ma jednostkę/znaczenie opisane w
  schema;
- StepUpdate, scalar endpoint i final artifact zgadzają się na jednym kroku.

### 7.5. Managed qualification boundary

Punkt 3 nie jest kompletny dla lane'u native tylko dlatego, że Rust unit test
przechodzi. Dla FDM CUDA i FEM użyj odpowiednich managed recept z planu
punktów 1–2. Jeżeli runtime/GPU/Docker jest niedostępny:

~~~text
status = BLOCKED
evidence = dokładny błąd i niewykonane gate'y
~~~

Nie ustawiaj `production_qualified` na podstawie hostowego testu, ABI ani
source audit.

---

# Punkt 4 — Control Room: ribbon, Explorer, Inspector, selector builder i overlay

## 8. Kontrakt frontendowy

### 8.1. Warstwy, których nie wolno omijać

Przepływ ma wyglądać tak:

~~~text
OpenAPI v2
  -> generated types/transport
  -> ControlRoomApi.model.frozenSpins
  -> resource hooks + invalidation
  -> command registry / selection controller
  -> Explorer / Inspector / viewport adapter
~~~

Nie dopuszczaj:

- endpoint strings w komponentach;
- ręcznego `fetch`;
- stanu serwerowego Frozen Spins w lokalnym Zustand store;
- websocket payloadu jako źródła prawdy;
- osobnego renderera FDM i FEM w komponencie React;
- inferowania capability z nazwy obiektu albo lane stringa;
- używania mesh vertices jako FEM true-DOF coordinates.

Realtime tylko unieważnia named resource. HTTP/facade pobiera nowy snapshot,
a komponent zachowuje poprzedni dobry stan podczas ACK/invalidation.

### 8.2. Mapa źródeł

| Plik | Rola | Zakres zmian |
|---|---|---|
| `apps/control-room/src/kernel/api/ControlRoomApi.ts` | typed transport facade | tylko nowe/zmienione operacje |
| `apps/control-room/src/kernel/api/apiTypes.ts` | public aliases | zgodność z generated schema |
| `apps/control-room/src/kernel/api/generated/openapi-v2.json` i `openapi-v2-types.ts` | generated contract | regenerować, nie ręcznie omijać |
| `apps/control-room/src/kernel/resources/frozenSpinsResources.ts` | resource hooks/decoder | stabilne keys, revision invalidation, binary validation |
| `apps/control-room/src/modules/ribbon/ribbonCommands.ts` | command | capability-gated create |
| `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` | ribbon item | label, scope, tooltip |
| `apps/control-room/src/modules/explorer/ExplorerModule.tsx` | resource consumption | collection resource |
| `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts` | tree ownership | object/region/unscoped |
| `apps/control-room/src/modules/explorer/selectionTypes.ts` i `explorerSelection.ts` | selection identity | stable constraint/node refs |
| `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | dedicated route | `object.frozen-spins` |
| `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx` | editor/commands | field pending, draft, preview, delete |
| `apps/control-room/src/modules/inspector/panels/selection/SelectionExpressionBuilder.tsx` | typed AST UI | finite validation, bounded tree |
| `apps/control-room/src/modules/viewport-3d/layers/FrozenSpinsOverlay.tsx` | render model/lifecycle | FDM/FEM carrier adapter |
| `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx` | scene composition | no material/topology mutation |
| `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` | resources/controls | mask, carrier, stale/current, legend |

Wszystkie klasy CSS dodawane w tym zadaniu muszą zaczynać się od `fm-` i
korzystać z tokenów `--fm-*`.

## 9. API, OpenAPI i resource facade

### 9.1. Obecne Frozen Spins resources

Zachowaj istniejące operacje:

~~~text
model.frozenSpins.list()
model.frozenSpins.get(constraintId)
model.frozenSpins.create(request)
model.frozenSpins.patch(constraintId, request)
model.frozenSpins.delete(constraintId, request)
model.frozenSpins.createPreview(request)
model.frozenSpins.getPreview(previewId)
model.frozenSpins.resolvedMask(maskId)
~~~

Każda mutacja używa `expected_revision`. Preview używa dodatkowo
`expected_source_state_revision` i `expected_topology_fingerprint`.

### 9.2. Stabilne resource keys

W `frozenSpinsResources.ts`:

1. `baseKey` jest stabilny dla kolekcji, constraint ID, preview ID albo mask ID;
2. `useResource({ resourceKey })` otrzymuje base key, a nie
   `baseKey#revision=...`;
3. `resources.invalidate(baseKey, revision)` zwiększa external revision;
4. runtime store refetchuje resource, lecz nie zmienia React root identity;
5. `resolveRevision` przechowuje revision payloadu, nie służy do generowania
   nowej tożsamości targetu;
6. maska binary ma własny stable key i walidację ETag/hash;
7. test sprawdza, że po invalidation root Inspector, focus, scroll i draft
   pozostają te same.

Nie usuwaj mechanizmu invalidation. Usuń wyłącznie zmianę resource identity,
która powoduje niepotrzebny remount.

### 9.3. Preview freshness

Preview response musi być interpretowana tak:

- `current=true` tylko przy zgodności source state, topology, selector
  revision i definition revision;
- `current=false` ma widoczny status stale;
- stale preview może pozostać jako last-good overlay wyłącznie z jawną
  etykietą `stale`; nigdy nie pokazuj go jako current;
- po zmianie modelu albo magnetyzacji nie kasuj bez ostrzeżenia ostatniej
  maski, jeśli UX zachowuje ją do porównania;
- activation runtime korzysta z nowego snapshotu, nie z automatycznie
  zaakceptowanego stale preview.

W Inspectorze pokaż minimum: `preview_id`, `revision`, current/stale,
frozen/free counts, fraction, bounds, mask hash, resolved reference hash,
source revision, topology fingerprint, evaluator/qualification i warnings.

### 9.4. FEM true-DOF carrier

Jeżeli istniejący API nie publikuje exact true-DOF positions, dodaj
resource w rodzinie `data` zgodnie z rejestrem tras. Preferowany kształt to
named carrier resource, np.:

~~~text
GET /v2/sessions/current/data/frozen-spins/true-dof-carriers/{carrier_id}
~~~

Nie dodawaj tej trasy w ciemno: najpierw sprawdź route registry i istniejące
konwencje data plane. Jeżeli istnieje równoważny resource, użyj jego nazwy.

Carrier musi mieć control-plane metadata:

~~~text
carrier_id
carrier_kind = fem_true_dofs
topology_fingerprint
mesh_revision
fe_order
dof_ordering
dof_count
coordinate_frame
precision
positions_resource
revision
etag
~~~

Pozycje są ciężkim payloadem data plane, nie polem status JSON. Binary decoder
ma sprawdzać:

1. magic/version/encoding;
2. `dof_count * 3` względem payload length;
3. finite coordinates;
4. precision i endianness;
5. topology fingerprint i mesh revision;
6. ETag/hash;
7. brak overflow JS safe integer;
8. coordinate frame zgodny z viewport.

P2 lub inny FE order wymaga rzeczywistego DOF orderingu z backendu. Nie wolno
mapować P2 do wierzchołków siatki tylko po to, aby overlay się pojawił.
Brak carrieru oznacza `unsupported`/`not ready`, a nie przybliżony obraz.

## 10. Ribbon command

### 10.1. Selection contract

Polecenie jest dostępne, gdy selection:

- jest `object.root` albo `object.region`;
- ma `ref.type === "scene-object"`;
- ma `objectRole === "magnet"`;
- ma stabilny object ID i opcjonalny region ID;
- aktualna sesja publikuje capability dla wybranego backendu i lane'u;
- API resource jest gotowy.

Selection of an antenna, geometry child, field, mesh vertex, stale/deleted
node albo unowned presentation node ma być disabled z czytelnym reason.

### 10.2. Capability-driven gating

W `ribbonCommands.ts`:

1. usuń hard-coded `lane === "fdm"` jako jedyną regułę;
2. pobierz capability przez istniejący typed resource/session capability
   adapter;
3. rozdziel capability:
   `authoring_supported`, `preview_supported`,
   `runtime_supported`, `overlay_supported`;
4. dla FDM włącz command tylko po potwierdzeniu preview/runtime contractu;
5. dla FEM włącz preview/command tylko, gdy exact true-DOF carrier i
   qualified runtime capability istnieją;
6. jeśli FEM może authorować, ale nie może preview/runtime, pokaż osobny
   reason zamiast udawać pełne wsparcie;
7. żadna capability nie może być inferowana z object name/type alone.

Przykładowe reasons:

~~~text
Select a ferromagnet or one of its regions first.
Frozen-spins authoring is available, but the current lane has no preview capability.
FEM exact true-DOF carrier is not published for this mesh.
The requested GPU lane is unavailable; no CPU fallback is allowed.
The selected resource is stale; refresh before creating a constraint.
~~~

### 10.3. Create command

`createFrozenSpinsFromCommand` ma działać tak:

1. odczytaj selection i capability w momencie wykonania, nie tylko renderu;
2. pobierz collection przez facade;
3. wygeneruj collision-free ID;
4. utwórz typed definition:
   `schema_version`, `id`, `name`, `enabled`, selector
   `in_object` albo `in_region`, activation, reference, membership, empty i
   inactive policies;
5. wyślij `expected_revision=collection.revision`;
6. przy 409 nie powtarzaj ślepo — odczytaj nową collection i zwróć stale
   feedback;
7. po ACK unieważnij collection i definition resources;
8. ustaw selection na `object.frozen-spins` z `constraintId` i `nodeId`;
9. otwórz right Inspector dopiero po potwierdzonym create;
10. nie dodawaj lokalnego node'a, który przeżyje odrzuconą mutację.

## 11. Explorer i własność constraintu

### 11.1. Zasady węzłów

Typy node muszą mieć własną dedykowaną trasę Inspectora:

~~~text
object.root
  ├── regions
  │     └── object.region
  │           └── object.frozen-spins
  └── object.frozen-spins

Frozen Spins
  └── unscoped / ambiguous
        └── object.frozen-spins
~~~

Node `object.frozen-spins` zawiera:

~~~text
id = parentId + ":frozen-spins:" + encoded constraintId
kind = object.frozen-spins
constraintId
objectId? / regionId?
parentId
stable selection ref
status
~~~

### 11.2. Owner resolution

`frozenSpinsSelectorOwner` może przypisać lokalnego ownera tylko, gdy:

- `in_object` ma jeden object;
- `in_region` ma jeden object+region;
- `and/or/xor` mają wyłącznie zgodnych właścicieli;
- każdy child ma jednoznaczną tę samą parę ownerów.

Dla `not`, `ref`, `inside_geometry` bez jednoznacznego targetu oraz
wyrażeń mieszających obiekty:

- nie zwracaj pusto;
- nie przypinaj constraintu błędnie do jednego object/region;
- dodaj go do globalnego `Frozen Spins / Unscoped` node;
- pokaż badge `ambiguous` albo `unscoped`;
- Inspector nadal może go edytować i pokazać pełny AST.

Constraint może pojawić się w drzewie dokładnie raz. Nie duplikuj go pod
każdym ownerem złożonego expression.

### 11.3. Revisions i delete

Explorer ma odświeżać collection przez resource invalidation. Po delete:

1. wysłanie mutation z expected revision;
2. czekanie na ACK;
3. invalidation collection/definition;
4. usunięcie node'a dopiero po nowym snapshotcie;
5. jeśli delete odrzucony, node pozostaje i Inspector pokazuje error.

## 12. Dedykowany Inspector

### 12.1. Route i tożsamość

W `inspectorRouteCatalog.tsx` utrzymaj osobny route:

~~~text
id = object-frozen-spins
selectionKinds = ["object.frozen-spins"]
component = FrozenSpinsInspectorPanel
~~~

Nie kieruj Frozen Spins do generic object inspector. Każdy semantic Explorer
child ma własny detail view zgodnie z regułą AGENTS.md.

### 12.2. Stabilność rootu

W `FrozenSpinsInspectorPanel`:

1. retain last-good resource dla tego samego `constraintId`;
2. nie używaj revision w React `key`;
3. nie remountuj `FrozenSpinsEditor` po ACK/invalidation tego samego targetu;
4. zachowaj draft, focus, scroll i expanded groups;
5. `key={constraintId}` może rozdzielać różne targety, ale nie może być
   używany do maskowania niestabilnego resource key;
6. subscription do server resource ma mieć jednego właściciela w panel tree;
7. root identity testuj przez `data-frozen-spins-inspector-id` i referencję DOM.

### 12.3. Draft i field-scoped pending

Draft ma być lokalnym, jawnie typowanym stanem edytora:

~~~text
serverDefinition
serverRevision
draftDefinition
draftDirtyFields
pending = null | apply | preview | delete
lastGoodDefinition
feedback
~~~

Reguły:

- `apply` wysyła cały typed definition z `expected_revision`;
- `preview` wysyła selector i source/topology revisions, ale nie mutuje
  definition;
- `delete` ma własne pending;
- pending `preview` nie wyłącza pól name/enabled;
- pending `apply` nie wyłącza delete bez decyzji UX;
- nie ustawiaj opacity na cały Inspector;
- nie animuj opacity persistent controls;
- po ACK zastosuj odpowiedź tylko wtedy, gdy draft nie zmienił się od submitu;
- po 409 zachowaj draft i pokaż conflict; nie nadpisuj go server snapshotem;
- po invalidation zachowaj draft, jeśli target ID jest ten sam.

### 12.4. Pola Inspectora

Inspector powinien obsługiwać:

1. ID/schema read-only;
2. name;
3. enabled;
4. selector AST;
5. membership;
6. empty selection policy;
7. inactive selection policy;
8. activation stages;
9. reference policy;
10. preview action;
11. preview summary/current-stale;
12. apply/delete;
13. errors/warnings/provenance.

Labels, units i long localized strings muszą się zawijać. Wszystkie kontrolki
używają wspólnych shadcn/ui-style primitives oraz `fm-*` classes.

## 13. Typed SelectionExpressionBuilder

### 13.1. Dozwolony AST

Builder ma serializować wyłącznie schema `SelectionExprSchema` z OpenAPI.
Obsługuj jawne warianty:

~~~text
all_magnetic
in_object
in_region
ref
and / or / xor
not
inside_geometry
compare
approx
between
~~~

Scalar builder używa tylko dozwolonych scalar kinds. Geometry builder używa
typed geometry predicates. Nie dodawaj string expression, callable ani
JavaScript callback.

### 13.2. Walidacja przed zmianą draftu

Każda kontrolka musi:

1. odrzucić pusty required ID;
2. odrzucić `NaN`, `Infinity`, pusty numeric string i overflow;
3. sprawdzić jednostki: metry dla geometrii, bezwymiarowe tolerance tam,
   gdzie schema tak definiuje;
4. sprawdzić `lower <= upper`;
5. sprawdzić niezerową oś/normalną i dodatnie promienie;
6. ograniczyć głębokość AST i liczbę childów do limitu serwera;
7. odrzucić puste `and/or/xor`, jeśli schema tego zabrania;
8. zwrócić structured validation error w UI;
9. nie serializować częściowo poprawnego AST jako gotowego requestu.

Aktualne `Number(event.target.value)` nie może pozostać jedyną walidacją.
Trzymaj wartość raw podczas edycji i konwertuj dopiero po sprawdzeniu
`Number.isFinite`.

### 13.3. Testy buildera

Dodaj testy:

- każdy operator round-trip;
- nested and/or/xor/not;
- geometry frame/boundary;
- scalar component/norm/dot;
- invalid number i empty ID;
- lower > upper;
- too deep/too many children;
- stale schema/server error;
- deterministic JSON/hash;
- brak unknown fields.

## 14. Overlay FDM/FEM

### 14.1. Jeden render model, różne carrier adapters

`FrozenSpinsOverlay.tsx` może mieć jeden render component i dwa adaptery:

~~~text
FdmCellCarrier -> center positions from authoritative FDM domain
FemTrueDofCarrier -> exact positions from data-plane carrier
~~~

Render model zawiera:

~~~text
carrierKind
current
frozenCount
totalCount
renderedCount
maskSha256
previewId
sourceStateRevision
topologyFingerprint
positions
~~~

Nie twórz dwóch niezależnych komponentów z rozbieżnym lifecycle. Adapter
decyduje, jak indeks maski mapuje się na pozycję; overlay tylko rysuje.

### 14.2. FDM adapter

FDM adapter może używać `FdmGridRenderDomain`, jeśli:

- `mask.bitCount === totalCells`;
- shape/origin/spacing pochodzą z current resource;
- ordinal mapping jest jawnie udokumentowany;
- maska i grid mają zgodne revision/fingerprint;
- stale maska ma badge `stale`.

Nie zakładaj, że każdy FDM mask resource jest current tylko dlatego, że
dekoder FMSK się powiódł.

### 14.3. FEM adapter

FEM adapter przyjmuje tylko exact carrier:

- `positions.length === mask.bitCount * 3`;
- carrier kind to `fem_true_dofs`;
- topology fingerprint i mesh revision pasują;
- FE order i DOF ordering są zgodne z maską;
- pozycje są w tym samym coordinate frame co scene;
- brak punktów oznacza brak overlayu i jawny diagnostic, nie fallback do mesh.

Jeżeli carrier nie jest gotowy, UI pokazuje `FEM true-DOF overlay unavailable`
z reason. Nie wstawiaj `null` na stałe jako cichego sukcesu.

### 14.4. Freshness i visibility

W `Viewport3DModule.tsx`:

1. pobierz active preview ID;
2. pobierz preview;
3. pobierz mask resource;
4. pobierz carrier resource zależnie od `carrier_kind`;
5. zbuduj model dopiero, gdy wszystkie identity się zgadzają;
6. current/stale pochodzi z preview + carrier, nie z samego UI state;
7. overlay visibility jest lokalną preferencją prezentacji i nie mutuje physics;
8. legend pokazuje `renderedCount/frozenCount`, carrier kind, current/stale i
   hash skrócony do display;
9. żadna zmiana visibility nie zmienia maski ani material layer.

Stale last-good overlay jest dopuszczalny tylko, gdy na canvasie/legendzie i w
DOM diagnostic istnieje wyraźne `stale=true`.

### 14.5. Lifecycle i wydajność

Zachowaj istniejące:

- dirty-driven `useBatchedInvalidate`;
- osobne dispose geometry/material;
- `Viewport3DResourceTracker`;
- bounded sampling, np. limit 50 000 punktów, z raportem rendered/total;
- brak always-on render loop podczas idle;
- brak synchronizacji z backendem przy samym toggle visibility.

Testuj, że zmiana maski/preview zwalnia stare resources, a liczba tracked
geometry/material wraca do baseline po unmount. Nie modyfikuj topology ani
materiali głównej sceny.

## 15. Browser E2E — rzeczywisty dowód punktu 4

### 15.1. Harness

Najpierw sprawdź istniejącą konfigurację `apps/control-room`:

- `package.json` scripts;
- istniejące Playwright/browser scripts;
- launcher Control Room;
- `scripts/smoke-inspector.mjs`;
- `scripts/screenshot-viewport-3d.mjs`;
- `scripts/audit-viewport-3d-memory-churn.mjs`.

Jeśli projekt ma E2E directory, utwórz
`apps/control-room/e2e/frozen-spins.spec.ts`. Jeśli nie ma konfiguracji
Playwright, dodaj scenariusz w istniejącym stylu launcherów, np.
`apps/control-room/scripts/smoke-frozen-spins.mjs`, ale nie nazywaj testu
browser proof, dopóki uruchamia się w realnym browser context.

### 15.2. Scenariusz minimalny

Scenariusz ma wykonać:

1. uruchomienie Control Room przez repozytoryjny launcher;
2. otwarcie workspace z magnetycznym objectem i przynajmniej jednym regionem;
3. potwierdzenie canvas visible;
4. potwierdzenie zdrowego WebGL:
   `gl.isContextLost() === false`;
5. potwierdzenie drawing buffer width/height większych od zera;
6. wybór object root i utworzenie Frozen Spins z ribbon;
7. sprawdzenie ACK, nowej rewizji i pojawienia się child node;
8. sprawdzenie automatycznego otwarcia dedykowanego Inspectora;
9. edycja name/policy/selector i apply;
10. preview z current=true i non-zero frozen count;
11. sprawdzenie overlay count większego od zera i legendy current;
12. zmiana magnetyzacji/topology revision;
13. sprawdzenie stale preview/overlay, bez etykiety current;
14. odświeżenie preview i sprawdzenie nowego hash;
15. powtórzenie create dla regionu i sprawdzenie ownera regionowego;
16. sprawdzenie unscoped/ambiguous selector w globalnym node;
17. save checkpoint, reload albo reopen workspace i sprawdzenie zachowania
    danych oraz właściwego restore class;
18. delete constraint i sprawdzenie, że node znika dopiero po ACK;
19. zebranie console/page errors, request countów i resource diagnostics.

### 15.3. Asercje stabilności Inspectora

Podczas apply, preview ACK i realtime invalidation browser test ma sprawdzić:

- ta sama referencja root DOM;
- ten sam `data-frozen-spins-inspector-id`;
- draft nie znika;
- focus pozostaje na edytowanym polu;
- scroll pozostaje w rozsądnym zakresie;
- unrelated controls nie są disabled;
- brak active opacity animations;
- brak pełnopanelowego opacity dimming;
- bounded liczba renderów/requestów;
- brak podwójnych resource subscriptions.

### 15.4. Asercje overlayu i WebGL

Minimum:

~~~text
canvas visible = true
gl.isContextLost() = false
drawingBufferWidth > 0
drawingBufferHeight > 0
data-frozen-spins-overlay-count > 0
data-frozen-spins-preview-current = true dla current frame
data-frozen-spins-preview-current = false dla stale frame
brak uncaught pageerror/console error
~~~

Dla FEM dodaj osobną asercję `carrierKind=fem-true-dofs` i niezerowe pozycje
tylko wtedy, gdy managed/backend fixture publikuje exact carrier. Jeżeli
fixture go nie publikuje, test ma potwierdzić jawny `unsupported/not ready`,
a nie udawać sukcesu na mesh vertices.

## 16. Testy focused frontendu i React Doctor

Uruchom najpierw testy RED/GREEN w odpowiednich plikach:

~~~text
pnpm --dir apps/control-room test -- ribbonStructure buildModelTree frozenSpinsResources FrozenSpinsInspectorPanel SelectionExpressionBuilder FrozenSpinsOverlay
pnpm --dir apps/control-room typecheck
~~~

Jeżeli package script nie przyjmuje takich filtrów, użyj istniejącego runnera
repozytorium z nazwami plików albo `pnpm exec vitest` po sprawdzeniu
`package.json`. Nie raportuj PASS z komendy, która niczego nie uruchomiła.

Obowiązkowe focused tests:

1. resource key pozostaje stabilny przy invalidation;
2. collection/definition revision refetchuje bez remountu;
3. Explorer owner object/region/unscoped;
4. brak duplikatu constraintu;
5. ribbon capability FDM/FEM/unsupported;
6. command expected revision/stale error;
7. Inspector draft/focus/scroll/pending;
8. selector builder finite/schema/limits;
9. FDM overlay mapping;
10. FEM exact carrier validation;
11. stale/current overlay;
12. dispose/tracker bounded resources.

Następnie przeprowadź `react-doctor` zgodnie z
`.agents/skills/react-doctor/SKILL.md`. Naprawiaj tylko diagnostykę
wprowadzoną przez ten diff. React Doctor i typecheck nie zastępują browser
proof.

## 17. Kolejność implementacji punktów 3 i 4

Wykonuj w tej kolejności, aby nie budować UI na niestabilnym kontrakcie:

1. potwierdź baseline, dirty worktree i istniejące testy;
2. dodaj failing activation/CAS/checkpoint parity tests;
3. napraw atomowy activation snapshot i epoch;
4. napraw checkpoint schema/restore class/no-recapture;
5. napraw persistence capture/link race i validate-before-mutate;
6. rozszerz StepUpdate/scalars/status/provenance;
7. uruchom Rust/API/CLI focused tests;
8. potwierdź OpenAPI/resource contract i wygeneruj typy;
9. napraw stable resource keys/invalidation;
10. dodaj capability-driven ribbon command;
11. napraw Explorer owner resolution i unscoped node;
12. ustabilizuj dedicated Inspector/draft/pending;
13. uszczelnij typed SelectionExpressionBuilder;
14. dodaj exact FEM carrier contract/data decoder;
15. podłącz wspólny FDM/FEM overlay adapter;
16. uruchom focused frontend tests/typecheck/React Doctor;
17. uruchom rzeczywisty browser E2E na FDM;
18. uruchom browser/managed FEM carrier scenario, jeżeli capability jest
    kwalifikowane;
19. wykonaj `git diff --check -- ...` dla wszystkich zmienionych plików;
20. zaktualizuj dokumentację/status dopiero na podstawie artefaktów.

## 18. Macierz akceptacji

| Gate | Evidence | PASS tylko gdy |
|---|---|---|
| activation atomicity | Rust race tests | jedna rewizja/epoch wygrywa, brak partial mutation |
| selector snapshot | activation + resume tests | selector nie jest ponownie ewaluowany |
| checkpoint integrity | codec tests | schema, mask/reference hashes, lengths i finite przechodzą |
| topology identity | mismatch test | zmieniona topologia blokuje restore |
| restore class | .fms tests | Exact tylko przy pełnym integrator/RNG/backend state |
| persistence CAS | API concurrency tests | checkpoint nie linkuje obcej rewizji |
| restore no mutation | API failure tests | błąd nie zmienia snapshotu/revisions |
| telemetry | StepUpdate/status/scalar tests | free/all/count/epoch/provenance są zgodne |
| OpenAPI | generated schema diff/tests | backend, facade i generated types są zgodne |
| resource stability | React tests | invalidation nie remountuje targetu |
| ribbon | command tests | capability + selection gating, expected revision |
| Explorer | tree tests | object/region/unscoped, jeden node, stabilny ref |
| Inspector | component/browser tests | draft/focus/scroll/pending stabilne |
| selector builder | AST tests | finite, bounded, schema-valid request |
| FDM overlay | overlay tests/browser | non-zero current points z właściwego mappingu |
| FEM overlay | carrier tests/browser | exact true-DOF coordinates, zero topology substitution |
| WebGL | real browser | context healthy, drawing buffer non-zero |
| lifecycle | tracker/browser diagnostics | dispose, bounded resources, no idle loop |
| no fallback | forced lane runtime | requested/resolved identity zgodna; unsupported fail-closed |

Status `source_present`, `compile_pass`, `unit_pass`, `typecheck_pass` albo
`abi_pass` nie jest `runtime_pass`. Status `runtime_pass` nie jest
`production_qualified`, jeśli brak managed evidence, browser proof albo
provenance.

## 19. Warunek zakończenia

### Punkt 3 można oznaczyć jako ukończony dopiero, gdy:

1. aktywacja jest atomowa i revision-safe;
2. epoch, source revision, topology, maska i reference mają jedną tożsamość;
3. checkpoint round-trip nie recapturuje selektora;
4. `ExactResume` nie jest przyznawane bez pełnego integrator/RNG/backend state;
5. persistence capture nie ma read-capture/write-link race;
6. restore waliduje przed mutacją i emituje rewizje/invalidation;
7. free/all telemetry i provenance są spójne;
8. każdy nieobsługiwany backend/lane zwraca named unsupported/blocker bez CPU
   fallbacku;
9. właściwe runtime/managed gates przechodzą albo status pozostaje BLOCKED.

### Punkt 4 można oznaczyć jako ukończony dopiero, gdy:

1. ribbon tworzy constraint dla objectu i regionu przez central command;
2. capability gating nie opiera się na hard-coded `lane === "fdm"`;
3. każdy constraint jest widoczny dokładnie raz w Explorerze, także
   unscoped/ambiguous;
4. node prowadzi do dedykowanego Inspectora;
5. Inspector zachowuje root, draft, focus, scroll i field-scoped pending;
6. builder tworzy tylko typed, finite, bounded AST;
7. FDM overlay pokazuje maskę z właściwego cell carrieru;
8. FEM overlay używa exact true-DOF carrieru albo jawnie pokazuje
   unsupported/not ready;
9. stale preview nie jest oznaczany jako current;
10. browser E2E potwierdza canvas, zdrowe WebGL, niezerowy drawing buffer,
    overlay, save/reload i brak błędów strony;
11. resource lifecycle nie wycieka i nie uruchamia render loop podczas idle;
12. API/OpenAPI/facade/resources/UI są zgodne.

Jeżeli dowolny gate jest niemożliwy z powodu braku CUDA, managed runtime,
carrieru FEM, browsera albo infrastruktury, zakończ raportem `BLOCKED`,
podaj dokładny błąd, komendę i niewykonane gate'y. Nie zamieniaj `BLOCKED` na
`DONE` na podstawie plausibility.

## 20. Końcowa checklista dla modelu

Przed raportem końcowym odpowiedz w artefaktach na każde pytanie:

- Jaki dokładnie snapshot został aktywowany?
- Czy maska i reference są literalnie zapisane?
- Czy resume uruchamia selector? Odpowiedź musi brzmieć: nie.
- Jaki jest `RestoreClass` i z czego wynika?
- Czy capture może linkować stan z innej rewizji?
- Jak UI dowiaduje się o zmianie? Named resource invalidation.
- Czy resource key zmienia się przy rewizji? Nie.
- Gdzie trafia constraint bez jednoznacznego ownera? Global unscoped node.
- Czy FEM overlay korzysta z mesh vertices? Nie.
- Jak udowodniono zdrowy WebGL? Real browser, `gl.isContextLost()` i
  drawing buffer.
- Jaki jest resolved backend/device/precision? Z runtime provenance, nie z
  requestu.
- Które lane'y nadal są unsupported albo blocked?

Na końcu wykonaj:

~~~text
git diff --check -- crates/fullmag-runner crates/fullmag-session crates/fullmag-api crates/fullmag-cli crates/fullmag-quantities apps/control-room docs/superpowers/plans/2026-08-21-frozen-spins-punkty-3-4-instrukcja-implementacji.md
~~~

Dokument nie zawiera niedomkniętych znaczników ani nieudokumentowanych zadań.
