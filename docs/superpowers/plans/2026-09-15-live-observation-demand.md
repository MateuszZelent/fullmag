# Obserwacja pól podczas aktywnej symulacji

## Zakres

Implementacja na `codex/bimeron-rdmi-frozen-spins`, baza
`d7b6f14b2b99766308ff9a0f8edad6a8e4391f55`, checkout
`C:/git/fullmag/worktrees/bimeron-rdmi-frozen-spins`.
Właściciel bieżącej pracy: `codex-thread-01a0a096-00db-7451-a885-49fd8fee7298`.
Zachować istniejące zmiany frontendu i aktywną symulację. Bez zmiany równań,
jednostek, Python DSL, ProblemIR, precyzji ani wyboru urządzenia.

## Cel i kontrakt

Widoczne odbiorniki zgłaszają sumę potrzebnych quantity. Aktywny solver obsługuje
ją na bezpiecznej granicy zaakceptowanego stanu, korzystając z rezydentnego cache
operatorów i pól. Odbiór danych nie czeka na zakończenie stage ani na obsługę
ogólnej komendy `compute_fields`. Kolorowanie X/Y/Z/HSL nie zleca fizyki.

ADR 0025 pozostaje właścicielem kontraktu trwałego runtime i źródeł obserwacji.
Snapshot musi zachować capture step/time/revision, również step=0. Nie wolno
publikować próbkowanego pola jako pełnej siatki ani mieszać masked solver demag
z pełnodomenowym polem do wizualizacji.

## Etapy implementacji

1. Rozszerzyć wewnętrzny display-sync o domyślnie pustą, kanoniczną listę
   `observation_quantities`; wyznaczać ją z widocznych odbiorników i wersjonować
   razem z żądaniem. Bez nowego publicznego endpointu ani codec pól.
   Wewnętrzny odczyt `GET /v1/internal/live/current/display-selection` przenosi
   pełny `DisplaySelectionState` do CLI, zastępując usunięty status v1.
2. Podłączyć ograniczony handoff snapshotów w aktywnych pętlach FDM GPU run/relax:
   jeden batch w locie, limit pamięci i częstotliwości, najnowsze żądanie wygrywa,
   jawne błędy obserwacji bez abortowania solvera, zakończenie workerów przed
   zwolnieniem backendu.
3. Zachować provenance przy publikacji przez istniejące `cached_preview_fields`
   i field data plane. Nie przepisywać czasu odbioru jako czasu źródła.
4. Zweryfikować integrację kontraktu i callsites, zgodność formatowania i diff;
   dodać regresje dla sumy demand, zmiany żądania, ograniczeń i step=0.
5. Po odblokowaniu runnera: build aplikacji bez kompilacji testów jednostkowych;
   osobny uzgodniony restart do nowego backendu; API i browser smoke
   m → H_demag → H_eff → m oraz X/Y/Z/HSL podczas run i relax.

## Granice dowodów

Zakaz kompilacji testów jednostkowych pozostaje obowiązujący. Dodanie testu nie
oznacza jego wykonania. Każdy lane wymaga osobnego potwierdzenia; implementacja
handoff FDM GPU nie dowodzi FDM CPU/FEM CPU/FEM GPU ani nowych capabilities.

## Checkpoint przed implementacją

- Git identity i początkowy dirty status sprawdzone; zmiany frontendu zachowane.
- Aktualizacja rejestru przez `scripts/fullmag_storage.py register` odrzucona:
  `Storage is busy: bimeron-rdmi-frozen-spins-921fd6f00badd344`.
  Nie nadpisano rejestru ani lease; istniejący wpis należy do poprzedniej pracy.
- `scripts/local_runner_cli.py --worktree <checkout> container-status`:
  `Container profile allow-list mismatch`. Build i nowy managed runtime:
  **NOT VERIFIED**. Nie uruchomiono hostowego fallbacku.
- Integracja/cleanup: blocked przez aktywną sesję i niezakończone zmiany;
  PR nie utworzono. Następny krok to zakończenie implementacji i kontrola źródeł,
  następnie odblokowanie zatwierdzonej trasy buildu bez naruszania sesji.

## Aktualizacja zgody i zasobów

Użytkownik zatrzymał poprzednią sesję ręcznie i jawnie zezwolił na nową sesję.
Port 3100 przestał odpowiadać. Rejestr worktree został następnie poprawnie
zaktualizowany przez resolver (2026-09-15 08:28 UTC); wcześniejsza blokada lease
nie jest już aktualna. Użytkownik zezwolił również na jednorazowy natywny build
Windows przez `scripts/windows/run_fullmag.ps1`, bez kompilowania testów.
Launcher buduje pakiety CLI/API, a natywny build jawnie target `fullmag_fdm`,
nie targety testowe. Nie zmieniono konfiguracji ani allow-list runnera.

Profil: `bimeron-rdmi-frozen-spins`. Wejście wskazane przez użytkownika:
`C:/git/fullmag/storage/runs/bimeron-rdmi-frozen-spins-921fd6f00badd344/bimeron-rdmi-frozen-spins-baseline-p0-20ps-h0p5-v2/R3nm-w3nm-h0p5nm-p0-a0p5nm/states/constrained_held_m.zarr.zip`,
format Zarr, dataset `m`, próbka -1. Plik istnieje. Uruchomienie ma użyć nowego
katalogu wyników pod rozwiązaną ścieżką run profilu, bez nadpisania wcześniejszej
symulacji. Build/runtime/browser pozostają **NOT VERIFIED** do wykonania.

## Checkpoint wykonania — 2026-09-15

Build aplikacji Windows FDM/CUDA zakończony poprawnie (release, 2m34s), bez
kompilacji testów jednostkowych. CLI/API: build `2026-09-15T09:12:34Z`,
snapshot `8ce16df013adf6669ef884ad308d1874bf5cacef8b523a57a0f4c862274a1a40`,
HEAD `d7b6f14b2b99766308ff9a0f8edad6a8e4391f55`, dirty. Późniejsza poprawka
frontendu została załadowana przez dev server; nie należy przypisywać jej
temu wcześniejszemu fingerprintowi buildu backendu.

Potwierdzone przyczyny:
- CLI odpytywał usunięty `/v1/live/current/status` (404); konwersja przez
  preview dodatkowo gubiła `observation_quantities`. Nowy wewnętrzny odczyt
  przesyła bezpośrednio kanoniczny stan, bez transportu tablic pól.
- Resolver widoku FDM jawnie przekazywał `visualizationState: null`, ignorując
  zapisane ustawienia Inspectora. Obecnie korzysta ze wspólnego zasobu serwera,
  pozostawiając lokalnemu snapshotowi preferencje i oczekujące edycje.

Nowa sesja: `session-1789463710980-77072`, PID CLI 77072, port 3100,
GPU RTX 4080 SUPER. Obserwowane `H_demag` oraz `H_eff` mają `state=complete`,
scope full, lane `fdm_cuda`, precision double, jednostkę A/m i niezerowe zakresy.
H_eff potwierdzono dla source_step 1676; symulacja wykonuje kolejne kroki.

W przeglądarce Edge potwierdzono różne obrazy dla H_demag/Z, m/X, H_eff/Y
oraz powrotu do m/HSL. Canvas 738x712, drawing buffer 738x712,
`isContextLost=false`. Zrzuty `demag-z.png`, `m-x.png`, `heff-y.png`,
`m-hsl.png` znajdują się w katalogu run
`live-observation-validation-20260915-v2` pod kanonicznym runs root worktree.
Pierwszy run `live-observation-validation-20260915` zachowano.

Kontrole: architecture-hygiene PASS; React Doctor (12 zmienionych plików)
nie zgłosił problemów, zdalna punktacja niedostępna; git diff --check PASS.
Dodane testy regresji pozostają niewykonane zgodnie z zakazem kompilacji testów.
Nie jest to dowód parytetu CPU/FEM, walidacji fizyki ani kwalifikacji wydania.

Integracja: **blocked/pending review**. Brak PR i merge; zmiany lokalne,
istniejące cudze zmiany frontendu zachowane. Worktree i run pozostają aktywne
do inspekcji użytkownika; nie usuwać ich ani storage. Następny krok integracji:
review pełnego diffu i wymagane bramki po zniesieniu zakazu testów, następnie
scoped commit/PR. Nie przedstawiać lokalnego smoke jako zakończonego cyklu PR.

Próba zapisu końcowego stanu przez resolver `finish --state blocked` została
odrzucona przez `Storage is busy` dla tego samego worktree. Nie obchodzono
locka aktywnej sesji; rejestr nadal wskazuje bieżącego właściciela i `active`.
Powyższy checkpoint jest zapisem blokady do uzupełnienia po zamknięciu sesji.

## Kolejna regresja: torque

Po wyborze torque API potwierdziło observation_quantities=[m,torque], ale meta
zwróciło `state=error`, `unsupported CUDA preview snapshot 'torque'`.
Poprzedni browser smoke nie obejmował torque i nie dowodzi jego działania.
Dodano pochodny snapshot dwóch przechwyconych pól m/H_eff, obliczany przez
worker istniejącym compute_torque_field (bez zmiany definicji, w T), przed
próbkowaniem. Limit pamięci uwzględnia wejścia i bufory pośrednie.
Dodano test z analitycznym wektorem [0,0.4,-0.8] T; zgodnie z zakazem test
nie został skompilowany. Parse rustfmt i scoped diff-check PASS.
Nowy build i browser torque: NOT VERIFIED; oczekiwanie na zgodę użytkownika
na kolejny build Windows i restart aktywnej sesji z zachowaniem wyników.

### Weryfikacja torque po zgodzie użytkownika

Build Windows release PASS (1m18s), bez kompilowania testów. Build time
`2026-09-15T10:01:42Z`, source snapshot
`90d0208ff6de4d1827743004c857da6110e8437795010772430d8604017e6a0e`.
Nowa sesja `session-1789466582908-73360`, PID 73360, port 3100, FDM CUDA.
Wyniki zachowane osobno w `live-observation-validation-20260915-torque`.
API torque: complete, 3 komponenty, T, full, double; source_step rośnie
od 12 do 245, field_revision od 1 do 44. Brak błędu unsupported snapshot.
Edge: widoczne torque/Z i torque/X, canvas/drawing buffer 738x712,
WebGL context nieutracony. Zrzuty torque-z.png oraz torque-x.png w run dir.
Pierwszy odczyt przed publikacją pokazał notification unavailable; po publikacji
i ponownym otwarciu strony liczba takich komunikatów wyniosła 0. Obsługa
powiadomienia przejściowego oczekiwania nie była zmieniana w tej poprawce.
Sesja pozostaje uruchomiona, pozostałe wyniki nieusunięte. Integracja/review
i niewykonane testy nadal pozostają otwarte zgodnie z wcześniejszym checkpointem.
