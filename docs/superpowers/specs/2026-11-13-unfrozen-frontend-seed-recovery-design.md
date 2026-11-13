# Recovery niezamrożonego workspace’u frontendu

Status: techniczny kontrakt naprawy w ramach zatwierdzonego recovery własnej
grupy; odbiór runtime i pełne P22 pozostają otwarte.

## Problem i wybór

Attempt `08a6cbffbe874153a6e7547eb5898650` jest failed-confirmed z powodu
frontendu Exited1. Prywatny next-env.d.ts ma 0 B, brak inputs-freeze.json
oraz frozen copy; źródłowy plik jest czysty, ma 247 B i SHA-256
`7b550dda9686c16f36a17bf9051d5dbf31e98555b30d114ac49fc49a1e712651`.
Backend `1d3311194d38` jest healthy, API/runtime Ready, app commit
`48845db952a902d3dafaf6885dc259becb8eba1a`.

Rozważono nadpisanie prywatnego pliku, istniejący frozen refresh i nową
prywatną generację. Nadpisanie utrudnia zachowanie diagnostyki, frozen refresh
wymaga nieobecnego dowodu. Wybrano nową generację jako decyzję implementacyjną:
ścisły hash guard pozostaje, stary workspace zachowany, backend bez restartu.
Nie przypisuje się pustemu plikowi nieudowodnionego pochodzenia z Next.

## Kontrakt

- Jawny tryb `--failed-seed-new-generation` w istniejącym managed refresh.
  Domyślne ścieżki i frozen-resume nie zmieniają warunków.
- Exact attempt/config/terminal/current/verified CAS, własny frontend Exited1,
  PID0, brak restart/OOM/pauzy, dokładny mismatch w logu, zerowy stary plik
  oraz brak freeze. Pełna kontrola pod lease i przed zmianą Compose.
- Nowa nieistniejąca generacja private/frontend/generations/<operation>,
  bez symlinków i z poprawnym właścicielem. Poprzednie pliki i receipt
  zachowane. Dodanie katalogu generacji zmienia listę katalogów kontrolnych;
  nie deklaruje się bajtowej identyczności całego ich drzewa.
- Dokładna zgodność bieżących seed files/dependencies/toolpins/live directories
  ze starym autentycznym manifestem; jedynie source_commit może się różnić.
  Osobno zapisane controller/helper commit, input commit i backend app commit.
  To nie jest ogólna deklaracja zgodności całych HEAD-ów ani kwalifikacja S46.
- Compose zmienia tylko generację /state/development dla frontendu.
  Backend declaration, ID, StartedAt, PID, fingerprint, owner/certificate
  i runtime observation zachowane. Backend healthy oraz idle wymagane.
  Tylko up --no-deps --force-recreate frontend, bez backend build/restart.
- Nieznani konsumenci, rozbieżne hashe/CAS, zajęta generacja i niejednoznaczny
  stan kończą próbę bez automatycznego fallbacku. Brak działań na obcych
  checkoutach Windows. Nie ponawiać Solve/Compute.

## Wdrożenie i odbiór

1. Meaningful mocked Python RED/GREEN: exact pass, złe CAS/log/hash, brak
   manifestu source, rozbieżny seed, aktywny frontend, zmieniony backend,
   symlink/istniejąca generacja, nieznany konsument. Zachowanie defaultów.
2. Wąski validator/proof, bezpieczne tworzenie generacji i caller istniejącego
   refreshu; reuse lease/CAS i backend preservation, bez kopiowania całego flow.
3. Review diffu i istniejące adekwatne testy. `just --dry-run` sprawdza jedynie
   rozwinięcie recepty, bez wykonywania rzeczywistych guardów.
4. Managed apply zaczyna się od rzeczywistych kontroli tylko do odczytu przed
   utworzeniem generacji, ponawia je pod lease i przed granicą Compose.
   Nie dodaje się osobnego workflow zatwierdzania; apply własnej grupy jest
   wcześniej autoryzowane. Potwierdzenie nowego frontend ID, zdrowego UI oraz identycznego
   backendu. Wszystkie seed bytes i freeze zweryfikowane, stara kopia zachowana.
5. Dopiero potem rzeczywisty odbiór UI/Cell. P22/S46 oraz matrix/integracja
   pozostają oddzielnymi bramkami; sam start usług ich nie zamyka.


## Post-recreation completion

A recreated healthy frontend whose bind witness refused may be completed only
through the existing pinned prepare/apply observer transaction. A failed-seed
base has its own authority: exact failed terminal/config/input CAS, unchanged
retained backend package and incarnation, private generation and source identity
proof. It cannot borrow an unrelated successful iteration/resume. Ordinary
completion keeps its native source equality requirement.

Future failed-seed refreshes persist an immutable idle backend incarnation/API
baseline under the operation lease before seed or lifecycle work. A pre-existing
operation without that journal may use a separately published genuine prior
operator observation, explicitly tagged `operator-pinned-prior-observation`.
Missing, malformed or drifted observations refuse; a malformed existing journal
cannot fall back to an operator record. Both forms enter the transaction CAS.
No current observation is silently promoted to a prior baseline.

The result pins backend app, frontend input and helper commits separately and
marks native qualification against the newer selected checkout NOT VERIFIED.
Completion changes only operation metadata, archives the original unknown
receipt/Compose and lets the original helper retire its lease. It never repeats
Compose recreation, backend startup or Compute.


## Retained native recovery handoff

Frontend refresh must preserve validated native initialization provenance. In
particular, the complete top-level `container_recovery` and the sorted
`container_recovery_environment` name list must accompany the unchanged backend
Compose environment. The abbreviated `inputs.container_recovery` request record
cannot substitute for this capability. Validate before operation/staging or a
service stop, repeat under the lease, then serialize only supported context
fields through the existing receipt path.

A legacy successful frontend-refresh receipt missing both top-level fields may
resolve them in memory from its authenticated immutable predecessor. Both
frontend-refresh attempt/config references must agree with previous-development
references; current/parent terminal and Compose pins, project/control/source,
state/backend volumes, backend ID/StartedAt and backend declaration must match.
A failed predecessor is admissible only for the exact frontend readiness refusal.
The failed-seed prior-terminal digest remains binding. Generic previous-* fields
alone do not identify a frontend refresh. Partial/present-invalid capability,
foreign or changed parent, missing evidence or a cycle refuses; no historical
receipt/current/verified bytes may be repaired in place. The full existing
runtime authorization/completion/owner/drain checks still run after resolution.

Canonical running-group update must validate the metadata handoff before its
first controlled stop; later stopped-state and destructive-boundary checks remain
mandatory. An already successful controlled stop is continued from its exact
record and must not be replayed. Acceptance includes the real stopped 33052/08a
read-only validation and focused carry/order/negative tests before startup.


The lineage resolver binds both receipt namespace markers and registry SHA to
the active BuildControl namespace; unnamespaced controls reject either marker.
A malformed-present capability must refuse before specialized cold/drained early
returns. A no-newline child Compose is a supported completion encoding only
when its typed request and existing `completed()` evidence authenticate it;
other control records retain their strict canonical encoding contract.


## Generacja frontendu przy ponownym starcie grupy

Zakończone odtworzenie usług musi przekazywać do nowego development dokładnie
uwierzytelniony poprzedni receipt i Compose. `_pin_private_group_storage` ma
przenosić generację przez istniejący validator, przed `_frontend` i po ponownym
sprawdzeniu pod lease. Nowy render nie oznacza powrotu do legacy workspace.
Brak całej pary dopuszcza legacy tylko dla autentycznego poprzednika bez generacji;
częściowa para, niezgodny mount/namespace/registry/root/config lub zmiana CAS
kończy próbę przed seed helperem. Zamknięta lista dopuszczonych bajtów zostaje.

Próba d7 nie zapisała odwołania do zakończonego recreate6d125. Jej kontynuacja
jest nowym, jawnie przypiętym startem ze zachowanego stanu, a nie dopisaniem
brakującej historii. Wymaga osobnych pinów failed-precompose terminal/current d7,
verified i immutable base33052 oraz terminal/current/verified recreate6d125.
Recreate musi wskazywać dokładny base/config/usunięte IDs/state/volumes. Failed
child ma ten sam project/control/source/state/cache/device/operator intent oraz
pełną capability; jedyną dopuszczoną przyczyną jest dokładna odmowa metadata
przed Compose/seed/service mutation. Wymagana jest obserwacja nieobecności
własnych usług i starych IDs, porządek czasowy, namespace/registry binding oraz
ponowna walidacja pod lease. Pełne owner/certificate/native authorization checks
pozostają obowiązkowe. Nie ma ogólnego fallbacku do najnowszego verified ani
zmiany któregokolwiek historycznego receipt/current/verified.


## Realizacja historycznej kontynuacji

Wybrano istniejące `recreate-volume --resume-recreation` z jawną parą
`--failed-frontend-start` i `--failed-frontend-start-sha256`. To migracja starego
failed-precompose bez generacji/handoff; bieżące generation-aware failures
są poza jej zakresem i są jawnie odrzucane. Nie dodaje się wildcard inputów.

Validator metadata-only boundary poprzedza pełny istniejący removed/native proof;
porównanie pełnej capability następuje po nim. Pod lease całe sprawdzenie
wyprzedza jakąkolwiek zmianę in-memory issued receipt. Oddzielny pin aktualnego
failed terminala pozwala czytać historyczną lineage tylko z dokładnym dowodem
usunięcia poprzednich IDs i hashami old terminal/Compose. Domyślna lineage nadal
wymaga current==old terminal. Nie ma fallbacku do latest verified.

Niezmienny dowód completion publication służy czytaniu historycznego Compose.
Funkcja replay completed() zachowuje dodatkowe sprawdzenie current/verified.
Właściwa generacja jest przenoszona także przez specialized completed/resume.
Testy i rzeczywisty readonly preflight nie zastępują końcowego managed startu
oraz odbioru natywnej aplikacji i UI.


## Świeżość instalacji zależności

Historyczny ready receipt oraz obecność Next nie wystarczają po zmianie
manifestów. Install key jest deterministycznym SHA z dependency_seed_sha256
i toolpins_sha256, bez source_commit. Ready history wolno ponownie użyć tylko
przy zgodnym kluczu i istniejącym poprawnym drzewie zależności. Brak starego
klucza lub rozbieżność wywołuje zwykłe pnpm install --frozen-lockfile. Nie
zmienia to receipt ownership/lease, wersji bibliotek ani zachowania HMR przy
zmianie samego źródła. Nie nadpisuje się ręcznie stanu działającego kontenera.
