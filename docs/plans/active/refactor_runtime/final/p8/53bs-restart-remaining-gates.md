# P8-53BS — pozostałe bramki restartu i dwa kolejne handoffy

Data: 14.10.2026. Audyt źródeł na lokalnym masterze
`b7015cde73e3e1c2241bfb7c3a934282632a0828`.
Status: **IN PROGRESS**. Dokument rozdziela zakończone dowody od następnego
przyrostu; nie jest dowodem wykonania dwóch restartów ani zamknięcia P8.

## Aktualne granice dowodów

| Wymaganie | Dostępny dowód | Stan i brakujący odbiór |
|---|---|---|
| Odmowa podczas running/paused i wyścig Start/freeze | [53BC](53bc-real-active-run-restart-refusal.md): a58b6596, 6312ce8e, 41e4f43b; rzeczywisty solve kontynuuje, scope i epoch zachowane | Zakończone w opisanej tożsamości źródeł i lane; nie powtarzać tylko dla nowego wpisu statusu. |
| Niepusty model, dirty document, nowy pin, kamera po pojedynczym restarcie | [53BO](53bo-grid-modal-correlation.md): 81eb7f40, cb9c2825; scena/dokument/kamera zachowane, 27 procesów waited | PASS dla jednego A→B na Windows FDM CPU-reference. Historyczny brak dowodu kamery z początku 53BM nie opisuje tego najnowszego wyniku. |
| Publiczna dostępność restartu | platform/development_backend.rs nadal ustawia restart_available=false; ActionService i banner przestrzegają tej bramki | **NIEUDOSTĘPNIONE**. Prywatny probe PASS nie dowodzi działania przycisku restartu w zwykłym produkcyjnym UI. Promocja wymaga wymaganych bramek, nie usunięcia flagi dla testu. |
| Grid/Compute/Close po restore | Ten sam 81eb7f40: Grid published, Compute 10 kroków, normalne Close solvera | PASS w określonym modelu; cleanup replacement API stosuje kill/wait, nie dowodzi naturalnego wyjścia API. |
| Pierwszy Apply materiału po odświeżeniu | [53BH](53bh-inspector-first-edit-after-resource-refresh.md) | Apply i restart/restore w opisanym zakresie panelu materiału; pozostałe panele wymagają własnych dowodów. |
| Pending Save materiału, Cancel dialogu New Problem, Revert | [53BJ](53bj-pending-inspector-save-cancel.md) | Nie oznacza pełnej macierzy Save/Cancel wszystkich formularzy. |
| Save Project w Chrome z czystym Inspectorem | [53BI](53bi-project-save-before-restart.md) | Pobranie archiwum i restart/restore; desktop Save nadal NOT VERIFIED. |
| Dwa kolejne restarty w jednej sesji przeglądarki | [53BK](53bk-repeated-handoff-owner-chain.md): interpreted 162 checks, dwie terminalne kapsuły z assetem | **NOT VERIFIED runtime/browser**. Dwa oddzielne A→B nie kwalifikują A→B→C. |
| Preferencje widoku poza layoutem i kamerą | [53BL](53bl-inspector-owner-inventory.md), bieżący DevelopmentKernelOwners | Capture v2 obejmuje layout i kamerę. Nie obejmuje wszystkich ustawień przekrojów, aktywacji rozszerzeń i lokalnych kontrolek Topological Charge. |
| Fault/recovery i warm-service | Wcześniejsze źródłowe/interpretowane i scoped native gates | Wymagana macierz produkcyjnego przebiegu; pojedynczy pozytywny browser receipt jej nie zastępuje. |
| Integracja i wydanie | PR #160 oraz [53BP](53bp-pr160-integration-gates.md) | Niezakończone. Push uruchamiający kompilację unit testów oczekuje na decyzję użytkownika; brak scalenia nie jest PASS. |

## Dlaczego obecna bramka nie sprawdza dwóch restartów

`crates/fullmag-cli/src/control_room/development_workspace_probe.rs:279`
wykonuje `pump.step_observed` tylko gdy `restored.is_none()`; przechowuje
jedno `Option<RestoredState>`. Pierwszy zgodny Finish kończy pętlę.
Nie wolno uznać braku drugiego wyniku w tej próbie za awarię produktu.

`scripts/windows/verify_workspace_browser.py::ProofBridge` przechowuje
pojedyncze `before`, `restored`, `restore_observation` i `browser`. Before jest
immutable; `finish` weryfikuje bieżący snapshot i wysyła terminalną komendę.
Nadpisanie tych pól zgubiłoby dowód pierwszego przejścia.

`start_command_reader` w natywnym probe odczytuje tylko jedną ograniczoną
linię i dopuszcza wyłącznie event `finish`. Rozszerzenie wymaga również
typowanej komendy potwierdzenia cyklu, bounded readera obsługującego oba
przejścia oraz jednoznacznego EOF/error; samo usunięcie `restored.is_none()`
nie wystarcza i mogłoby ponownie odczytać stary `last_execution`.

Produkcyjny `NativeRestartPump::step_observed` rozpoznaje attempted_api względem
aktualnego scope guardu. Samo pole `last_execution` ani singleton diagnostycznego
probe nie dowodzą zakazu kolejnego restartu w produkcyjnym launcherze.
Najpierw należy rozszerzyć dowód, a dopiero z zaobserwowanej awarii wyprowadzać
poprawkę runtime.

## Kontrakt następnego przyrostu: A→B→C

1. Jeden browser i jeden natywny owner przez dwa jawnie numerowane cykle.
   Domyślny dotychczasowy pojedynczy przebieg pozostaje kompatybilny.
   Rozróżnić stałego launchera od kolejnych owner bindings i API A/B/C;
   każda inkarnacja ma własne api_instance_id oraz scope. API generation nie
   oznacza automatycznie innej zawartości EXE.
2. Trzy zweryfikowane tożsamości pakietów, osobne przypięte source/manifest
   hashes; C ma być rzeczywistym odrębnym kandydatem. Nie podmieniać etykiety
   ani manifestu B, nie budować z ruchomego checkoutu podczas próby.
3. Każdy cykl ma immutable before/restored/after, API/session scope, request ID,
   generation, scene/document/camera hashes i terminalną kapsułę. Zapis obu
   cykli pozostaje w jednym receipcie, zamiast nadpisania pierwszego baseline.
4. Drugi cykl zaczyna się wyłącznie po potwierdzonym hydrate B; źródło B musi
   zgadzać się z rzeczywistym ownerem. Stary pin A nie może sterować B/C.
   Nowy request i kamera są odczytywane z B, nie ze starych zasobów A.
5. Sprawdzić zachowanie niepustego modelu, materiału, regionu, dirty dokumentu,
   layoutu i kamery po obu przejściach. Asset z pierwszej kapsuły zachowuje
   bytes i referencję po drugim kopiowaniu; osobny 53BK pozostaje dowodem
   prymitywu danych, nie wykonania procesu.
   **Zachowanie assetu podczas runtime A→B→C pozostaje NOT VERIFIED.**
6. Nie uruchamiać solve między cyklami tylko po to, aby zakończyć pierwszy
   cykl: aktywna symulacja musi blokować drugi restart. Po drugim restore
   wymagane są zwykłe Grid/Compute/Close oraz zdrowy canvas.
7. Jeden terminalny Finish po drugim cyklu. Potwierdzić terminalny wait A i B,
   custody C, helperów i dzieci. Cleanup dotyczy wyłącznie własnych procesów;
   unknown pozostaje unknown. Nie poszerzać timeoutów jako sposobu uzyskania PASS.
8. Interpretowane regresje protokołu: obcy cycle/nonce/pin, powtórzone before,
   pominięty hydrate, niezgodny B→C binding, przedwczesny Finish oraz częściowy
   cleanup odrzucane. Kompilacja unit targets nadal zabroniona; build źródeł
   produkcyjnych i managed browser/native receipts są odrębnymi bramkami.

## Tożsamość odczytanych źródeł

Podczas tego audytu ponownie odczytano sealed receipt
`development-backend-api-checks/checks/81eb7f40d2c8428baae938f5be5bef73/receipt.json`:
state=completed, exit_code=0, checks=10, processes=27, unwaited=0.
`workspace_browser_camera.preserved=true`; wszystkie sześć pól before/after
jest identyczne. Jest to odczyt istniejącego wyniku, nie nowy runtime run.

| Plik | SHA-256 |
|---|---|
| development_workspace_probe.rs | 146e63c3c24770378503fb7686e9f422b12eb190b92d675197055ded656af7dd |
| verify_workspace_browser.py | 18c0ef8c27996dd1be563fae449102170a3f296ec52efdf2549943212b2cb187 |
| DevelopmentKernelOwners.ts | ad4ee4abc1ad7facfc8b921497c15f574fcf710f51a0b6f94c142959149a9ca8 |
| TopologicalChargeExtensionPanel.tsx | 21df026c200b53224c6c31d21c0b0ddf38f5aa7133dbca752d4db2d5e49ffbdc |

Nie uruchomiono nowych procesów runtime, buildu ani CI. Workspace 3197
pozostał nietknięty. Ten audyt nie podnosi procentów całego planu.
Bounded independent review wskazało brak jawnego publicznego gate false,
zbyt szerokie połączenie trzech dowodów formularzy i potrzebę rozdzielenia
launchera/API generations. Dokument uzupełniono; flaga produktu nie została
zmieniona. Kontrola 70 lokalnych linków: PASS, zero brakujących celów.
