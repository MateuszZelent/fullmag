# Naprawa przygotowania symulacji, telemetria i modal diagnostyczny

**Status:** Zaakceptowana do planowania
**Data:** 2026-08-25

## 1. Cel

Nielegalna konfiguracja wykonania nie może uruchamiać wielominutowego Gmsh.
Legalna konfiguracja musi unikać zbędnych pełnych przebiegów po siatce i
pozostawać obserwowalna również wtedy, gdy operacja CPU/Gmsh trwa wiele minut.
Po niepowodzeniu inicjalizacji solvera
Control Room musi pokazać bezpieczną, precyzyjną przyczynę oraz umożliwić
skopiowanie kompletnego raportu diagnostycznego.

## 2. Obserwowane problemy

1. `_GmshProgressLogger` raportuje aktywność podczas `generate(3)`, ale nie
   obejmuje długich operacji naprawy, optymalizacji i ekstrakcji danych siatki.
   Po komunikacie `Gmsh: extracting mesh data` może nastąpić wielominutowa
   cisza.
2. `run_solver_initialization_safety_check` zapisuje tylko stabilne, ogólne
   podsumowanie błędu. Zwracany `anyhow::Error` nie jest przenoszony do
   `failure.detail`, a etap nie dostaje identyfikatora korelacji diagnostycznej.
3. Kontrakt API ma już pola `detail` i `diagnostics_correlation_id`, ale model
   frontendowy nie przenosi `detail` do widoku. Istniejący przycisk kopiuje
   JSON, lecz nie ma osobnego, automatycznie otwieranego panelu błędu.

## 3. Zakres i ograniczenia

### W zakresie
- fail-fast authored mixed-P1 przed materializacją domeny;
- stabilna lista naruszonych predykatów mixed-P1;
- usunięcie zbędnych pełnych przebiegów po siatce;
- wyłączenie niezamierzonej propagacji rozmiaru do airboxa;

- heartbeat i rzeczywiste podfazy dla meshingu/postprocessingu;
- bezpieczne zapisanie szczegółu błędu planowania i korelacji diagnostycznej;
- modal błędu w kernelowym overlayu przygotowania symulacji;
- kopiowanie ograniczonego, kompletnego raportu przygotowania;
- testy Python, Rust i React oraz weryfikacja kontraktu API.

### Poza zakresem
- rozszerzenie mixed-P1 o niezakwalifikowane interakcje;
- zmiana fizyki skryptu przez usunięcie anizotropii.

- nowy endpoint diagnostyczny;
- zmiana dziewięcioetapowego modelu przygotowania;
- sztuczny procent lub estymowany czas zakończenia dla ekstrakcji;
- ujawnianie surowych stack trace’ów, ścieżek prywatnych albo sekretów;
- automatyczne ponawianie nieudanego planowania.

## 4. Nienaruszalne kontrakty

1. Etapy pozostają: `runtime_startup`, `script_materialization`, `validation`,
   `planning`, `domain_preparation`, `meshing`, `mesh_postprocessing`,
   `solver_initialization`, `ready`.
2. Jeżeli backend nie ma wiarygodnego mianownika, `progress_percent` pozostaje
   `null`. Postęp jest wtedy prezentowany jako aktywna podfaza, heartbeat i
   czas.
3. HTTP `GET /v2/sessions/current/simulation/preparation` pozostaje źródłem
   prawdy. WebSocket przekazuje wyłącznie invalidację/revision.
4. Szczegóły przeznaczone do Control Room przechodzą przez istniejący bounded
   sanitizer. Raport kopiowany przez użytkownika nie może zawierać ścieżek
   prywatnych ani znaczników sekretów.
5. Ciężkie dane siatki i pól nie trafiają do raportu przygotowania.

## 5. Projekt telemetryki backendu

### 5.1. Python/Gmsh

Wspólny helper heartbeatów będzie emitował strukturalne zdarzenia
`mesh_build_phase` bez dostępu do mutowanego modelu Gmsh. Dzięki temu heartbeat
może działać podczas blokującej operacji NumPy/Gmsh bez ryzyka dodatkowych
odczytów modelu z wątku telemetrycznego.

Dla długich operacji będą użyte nazwane podfazy:

- `repairing mixed-domain tetrahedra`;
- `optimizing mixed-pyramid apices`;
- `extracting mesh nodes`;
- `extracting volume and boundary elements`;
- `deriving boundary facet roles`;
- `assembling mesh data`.

Heartbeat zachowuje `phase: "postprocessing"`, używa
`progress_kind: "indeterminate"`, ma `progress_percent: null` i zawiera
bezpieczny `progress_label` oraz komunikat z czasem trwania. Częstotliwość
wynosi około 15 sekund na początku długiej operacji i około 30 sekund po
wydłużeniu pracy, zgodnie z istniejącą polityką heartbeatów Gmsh.

Operacje `generate(3)`, naprawa/optimizacja oraz ekstrakcja dostaną komunikaty
wejścia w podfazę i końcowy komunikat. Końcowy komunikat nadal zamyka etap
`mesh_postprocessing` przez istniejący `mesh_build_summary`.

### 5.2. Rust bridge i preparation resource

`python_mesh_preparation_update` zachowa mapowanie `phase` do kanonicznego
etapu. Dla strukturalnego `mesh_build_phase` bez procentu:

- `progress_label` będzie aktualnym podetapem;
- `detail` i wpis logu będą pochodzić z bezpiecznie ograniczonego komunikatu,
  a nie wyłącznie ze stałego tekstu `Postprocessing the shared-domain mesh`;
- `revision` zasobu będzie zmieniana tylko przy zmianie semantycznego
  snapshotu;
- log pozostanie ograniczony do 200 wpisów.

Nie będzie automatycznej konwersji heartbeatów na procent.

### 5.3. Błąd solver initialization

Ścieżka `run_solver_initialization_safety_check` będzie używać bezpiecznego
szczegółu z `safe_preparation_error_detail(error)` oraz generatora korelacji
diagnostycznej. Stabilne pola pozostaną rozdzielone:

- `error_code`: maszynowy kod regresji/telemetrii;
- `summary`: stabilny, zrozumiały opis granicy błędu;
- `detail`: ostatni bezpieczny i ograniczony komunikat planera/walidatora;
- `diagnostics_correlation_id`: identyfikator do korelacji pełnego logu procesu.

Jeśli sanitizacja odrzuci szczegół, `detail` pozostanie puste, a modal pokaże
jasny komunikat zastępczy i identyfikator diagnostyczny. Surowy błąd nadal
wraca do wywołującego i nie jest publikowany do browsera.

## 6. Projekt modalu frontendowego

### 6.1. Właściciel i źródło danych

Modal będzie komponentem kernelowego layoutu obok
`SimulationStartupOverlay`, na przykład
`SimulationPreparationFailureDialog.tsx`. Nie będzie osobnym modułem solvera
ani komponentem wykonującym transport. Otrzyma snapshot z istniejącego
`useSimulationPreparation`.

Model `SimulationPreparationFailureView` zostanie rozszerzony o `detail`.
`serializeSimulationPreparationDiagnostics` również zapisze `detail`.

### 6.2. Zachowanie

- Przy pierwszym terminalnym błędzie danej kombinacji
  `preparation_id + revision + error_code` modal otworzy się automatycznie.
- Zamknięcie przez użytkownika nie otworzy go ponownie przy zwykłych
  rerenderach.
- Przycisk `View error details` pozwoli otworzyć go ponownie z overlayu.
- Modal nie blokuje dostępu do `Open full diagnostics` ani do Control Room,
  gdy runtime pozostaje aktywny po błędzie.
- Przy braku `failure.detail` pokaże komunikat, że runtime nie udostępnił
  dodatkowego bezpiecznego szczegółu.

### 6.3. Zawartość

Nagłówek i status błędu zawierają:

- etap i jego czas;
- `error_code`;
- `summary`;
- `detail`, jeżeli istnieje;
- `diagnostics_correlation_id`;
- `preparation_id`.

Panel metadanych pokazuje requested/resolved execution oraz status całego
przygotowania. Przewijany panel raportu zawiera bounded JSON snapshot z etapami,
czasami, podfazami i ostatnimi wpisami logu. Akcje:

- `Copy diagnostic report` — kopiuje cały bezpieczny raport;
- `Open full diagnostics` — otwiera istniejący dock diagnostyczny;
- `Close` — zamyka modal.

Kopiowanie ma stan `idle`, `copied` i `failed`, z komunikatem dostępnym dla
technologii asystujących. Dialog korzysta ze wspólnych prymitywów shadcn/ui
oraz tokenów `--fm-*`; nie wprowadza osobnego systemu modali.

## 7. Warianty rozważone

### Wariant A — istniejący resource + kernelowy modal (wybrany)

Najmniejsza zmiana architektoniczna: wykorzystuje istniejące pola API,
`useSimulationPreparation`, overlay i serializer. Nie dodaje round-tripów ani
drugiego właściciela stanu.

### Wariant B — osobny endpoint diagnostyczny

Dałby więcej danych, ale wymagałby nowego zasobu, OpenAPI, hooka, invalidacji i
obsługi niedostępności endpointu właśnie w ścieżce błędu. Nie jest potrzebny,
ponieważ aktualny snapshot zawiera wszystkie dane wymagane przez raport.

### Wariant C — tylko footer/toast

Byłby prostszy wizualnie, ale słabo widoczny po wielogodzinnym przygotowaniu i
nie zapewnia użytkownikowi jednego, stabilnego panelu do skopiowania.

## 8. Testy i bramki akceptacyjne

### Python

- test helpera heartbeatów i interwału;
- test zdarzeń dla każdej podfazy ekstrakcji;
- test, że zdarzenia pozostają indeterminate i nie mają procentu;
- test końcowego zdarzenia `mesh_build_summary`.

### Rust

- test mapowania strukturalnego heartbeatu do `MeshPostprocessing`;
- test, że komunikat podfazy trafia do `detail`, `progress_label` i bounded logu;
- test planowania/walidacji, który wymaga bezpiecznego `failure.detail` oraz
  `diagnostics_correlation_id`;
- test odrzucenia ścieżek/sekretów przez sanitizer;
- istniejące testy zegara i kontraktu preparation pozostają zielone.

### Frontend

- test modelu przenoszący `failure.detail`;
- test serializacji raportu zawierający detail i korelację;
- test modalu: auto-open tylko raz dla rewizji, ręczne ponowne otwarcie,
  renderowanie szczegółu i fallbacku;
- test kopiowania raportu oraz stanu błędu schowka;
- test zachowania istniejącego startup gate po zamknięciu modalu;
- `pnpm --dir apps/control-room typecheck` i targeted testy React;
- browser smoke dla widocznego modalu i poprawnego skopiowania raportu, jeśli
  środowisko browserowe jest dostępne.

### Kontrakt API

Ponieważ nie zmieniamy kształtu `PreparationFailureResource`, należy wykonać
kontrolę wygenerowanego kontraktu i potwierdzić brak niezamierzonych różnic.
Transport frontendowy pozostaje wyłącznie wygenerowanym v2 transportem przez
`ControlRoomApi` i resource hook.

## 9. Kryteria akceptacji

1. Podczas każdej operacji trwającej dłużej niż jeden interwał użytkownik widzi
   aktualną bezpieczną podfazę i rosnący czas.
2. Przy braku mianownika procent pozostaje pusty/indeterminate.
3. Po błędzie planowania API zwraca niepusty bezpieczny `detail`, gdy komunikat
   jest sanitizowalny, oraz korelację diagnostyczną.
4. Control Room pokazuje ten detail bezpośrednio i w automatycznie otwieranym
   modalu.
5. Jeden przycisk kopiuje kompletny bounded raport zawierający kod, summary,
   detail, korelację, etapy i log tail.
6. Raport nie ujawnia ścieżek prywatnych, sekretów ani ciężkich danych siatki.
7. Istniejący HTTP resource/revision flow i dziewięcioetapowy model pozostają
   niezmienione semantycznie.
## 10. Uzupełnienie naprawy przyczynowej

Strict mixed-P1 pozostaje w obecnym, zakwalifikowanym zakresie exchange + demag.
Gdy authored discretization jednoznacznie żąda `swept_prism` z przejściem
`pyramid_to_tetrahedra`, planner sprawdza predykaty niezależne od certyfikatu
przed Gmsh. Błąd zawiera stabilną, uporządkowaną listę, między innymi
`missing_exchange` i `unsupported_uniaxial_anisotropy`. Końcowa walidacja
materialized mesh nadal sprawdza certyfikat, topologię, jakość i backend.

Raport mixed mesh nie wywołuje pełnego `MeshData.to_ir()` tylko dla
nieistniejących `mesh_statistics`. Finalna serializacja do ProblemIR oraz
walidacja Rust pozostają obowiązkową granicą integralności.

Po wygenerowaniu source surface 3D background fields pozostają właścicielem
rozmiaru objętości, a `Mesh.MeshSizeExtendFromBoundary` pozostaje wyłączone.
Bramka obejmuje test opcji i mały realny mixed mesh z certyfikatem jakości.

Naprawa tetrahedrów, optymalizacja pyramid apex i ekstrakcja są podfazami
`meshing`. Klasyfikacja, raport i finalna serializacja/walidacja domeny są
podfazami `mesh_postprocessing`. Modal zachowuje startup gate i nie wpuszcza
użytkownika do niegotowego workspace.
