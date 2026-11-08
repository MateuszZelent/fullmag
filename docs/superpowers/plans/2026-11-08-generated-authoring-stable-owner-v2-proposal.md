# Stabilna tożsamość właściciela w checkpointcie generated-authoring v2

Status: gotowy projekt i izolowany patch do decyzji; kod produkcyjny v2 niezmieniony.
Odniesienie: zatwierdzony plan 2026-11-08-rt0-center-first-failure-diagnostic-proposal.md.
Nie zmienia fizyki ani tolerancji źródła. Nie jest nowym mechanizmem recovery.

## Problem potwierdzony wykonaniem

Diagnostyka J jest zaimplementowana na branchu zadania. Jej ukierunkowane
testy CI przeszły na c686a4ce2fb4f2d0f220df836910c967edac2d21,
run https://github.com/MateuszZelent/fullmag/actions/runs/42514370671.
Końcowy status całego workflow należy odebrać osobno przed buildem.

Pełny odczytowy preflight, przed managed aktualizacją, odmówił:
Saved authoring restart: native ready owner differs.
Buildów 3203 w tej sekwencji wykonano 0; nowych Submit i Solve również 0.

Dwa odczyty OWNER.json oddalone o 1,2 s potwierdziły zmianę wyłącznie
heartbeat_at. Pełny hash zmienił się z 0c0be8df1e3ac04fd13290f7ddecb6bf7e89066abbf8de0b903bc9335f4d60ac
na 7e573c52828b6a107c25593a8308441a35ce96641be74ac2f2aaf05959818934.
Hash wszystkich pozostałych pól w obu próbkach wynosi
7693cb9ccba3ac2ba2745edadc6aea92649615cfd73b8782284f543a4b6e9ca2.

Źródło odmowy: scripts/docker_volume_dev.py::_saved_authoring_validate_probe
porównuje hash całego service_owner z request.service_owner_sha256.
Ochrona jest słusznie ścisła, lecz jej checkpoint v1 przypina także
zmienny czas ostatniego heartbeat. Nie wolno zamrażać heartbeat,
wyłączać nadzorcy ani usuwać kontroli właściciela w celu przejścia bramki.

## Konkretny projekt

Addytywny schema fullmag.saved-generated-authoring-restart.v2 stosuje pole
service_owner_identity_sha256 zamiast service_owner_sha256.
Hash obejmuje cały obiekt service_owner z wyjątkiem JEDNEGO głównego pola
heartbeat_at. Nie pomija pól o innych nazwach ani zagnieżdżonych pól.
Heartbeat musi pozostać obecną, niepustą obserwacją tekstową native owner.

Nadal są przypięte: owner_token, PID i process_start_token, host, target,
protocol, state, acquired_at, control_address, build_commit/build_snapshot,
oba pool IDs/generations, children oraz każde inne pole obiektu.
Zmiana dowolnego z tych pól, także dodanie nieznanego pola, zmienia hash.
Gotowość native procesu, jego receipt, brak startup activation oraz
istniejące porównanie właściciela przy kontrolowanym drain pozostają bez zmian.

V1 zachowuje porównanie pełnego rekordu i dotychczasowe odmowy.
V2 jest dopuszczone wyłącznie w istniejącym wejściu saved generated authoring
z allow_generated=True. Starsze checkpointy i ścieżki recovery nie zyskują
nowego uprawnienia. Mieszanie starego i nowego pola hash jest odrzucane.
Bez zmian .env, profilu zasobów, mountów, storage, schedulerów lub limitów.

Patch obejmuje wyłącznie:
- scripts/docker_saved_authoring_generated.py: addytywny schema, wybór pola
  digest i hash całego native owner bez heartbeat_at tylko dla v2.
- scripts/docker_volume_dev.py::_saved_authoring_validate_request:
  dokładny zestaw pól v1 albo v2 i jawna lista obsługiwanych schema.
- scripts/docker_volume_dev.py::_saved_authoring_validate_probe:
  dopuszczenie generated v2 i odpowiedniego, jawnie wersjonowanego digest.

Przy implementacji należy dodać trwałe regresje z izolowanego kandydata.
Patch produkcyjny SHA256:
8e9fe5df53960b8e54726988b83548aab093da138d63d40f7644f0d00d23999e.

## Gotowe sprawdzenia i brakujące dowody

Izolowana kopia kandydata przeszła 16 testów offline, 0 błędów, 0 skipów:
sześć istniejących generated v1, ich sześć odziedziczonych przypadków v2,
trzy nowe przypadki v2 oraz osobny test zachowania pełnego hash v1.
Sprawdzono zmianę tylko heartbeat, odmowę każdego innego pola właściciela,
nieznane pola, brak/typ heartbeat, mieszane schema/digests, source/archive,
scope, aktywne kolejki, rezerwacje, oraz dotychczasową odmowę recovery.
To testy kandydata, nie wykonanego native preflightu v2.

Pierwsze uruchomienie testów ładowało produkcyjny v1 przez ścieżkę fixture
i odmówiło nieobecnego SCHEMA_V2; następnie loader jawnie załadował kopie
dwóch modułów kandydata. Testy ujawniły też pominiętą klasyfikację v2
w walidacji source-kind. Poprawiono WYŁĄCZNIE kopię kandydata i odebrano 16/16.
Oba wcześniejsze logi zachowano. Produkcyjne pliki nie zostały podmienione.

Dalsze bramki po decyzji:
1. Zweryfikować bazowe hashe patcha i zastosować tylko przypięty zakres.
2. Włączyć trwałe testy v2; wykonać 16 nowych/istniejących testów i
   istniejące regresje saved-authoring/history/drain. Bez native Cargo.
3. Utworzyć NOWY checkpoint v2 z aktualnej sceny, FMS i rzeczywistego owner;
   zachować stary checkpoint oraz dowód odmowy v1.
4. Odebrać pełny native preview: scena/source przed i po, native ready owner,
   profile, wszystkie terminalne katalogi runów i released rezerwacje.
   Nie uruchamiać aktualizacji, jeśli preview lub którekolwiek CI odmawia.
5. Dopiero po zaliczeniu: kontynuować wcześniej zatwierdzony limit JEDNEGO
   managed update 3203 i JEDNEGO nowego V/J/H. Nie jest to dodatkowy build
   ani druga próba solvera; do tej pory nie uruchomiono żadnej z nich.
6. Zachować wszystkie archiwa i przywrócić scenę. Użyć już zamrożonego
   requestu d2c8add5027af0fa253643578fe82415c9ed1b1ee33d6f8866217b2c3050d656,
   run-d04ef5217d24a697985f08e449c0648bbc5629402b7be74f6292ce08abfe7046.
   Różni się on od przygotowanego requestu wyłącznie run_id/idempotency_key.
   Bez Gmsh, meshowania, zmiany tolerancji, H-only, LLG lub retry.
7. Nowa odmowa kończy tę kontynuację; bez rozszerzania recovery lub samodzielnego
   uruchamiania kolejnej próby. Odebrać receipt i rezerwacje, nawet dla Failed.

## Dowody i granica decyzji

Prywatny control volume grupy 3203:
verification/rt0-center-diagnostic-execution-20261108/heartbeat-pin-readonly-evidence.json
oraz stable-owner-v2-proposal/.
Kandydat, przypięty patch, pins.json, 16 testów i pełne logi są tam zachowane.

Preflight zawiera POST persistence/projects/open. Sprawdzony handler
crates/fullmag-api/src/router_v2/handlers/persistence/projects.rs::open
nie przyjmuje State<AppState>, tworzy lokalny ProjectApplication i parsuje
ProjectSource::Bytes. Nie jest komendą przełączenia sesji. Początkowe
odrzucenie kontroli uprawnień rozstrzygnięto odczytem handlera, repository
i istniejącego testu memory_only; następnie identyczny preflight został
dopuszczony i odmówił na opisanej wyżej bramce native owner.

Nowa decyzja jest potrzebna wyłącznie dla rozszerzenia wersjonowanego
checkpointu i jednej kontynuacji po tej odmowie, zgodnie z AGENTS.md §8.
Zgoda na diagnostykę J sama nie zmienia chronionego kontraktu restartu.
