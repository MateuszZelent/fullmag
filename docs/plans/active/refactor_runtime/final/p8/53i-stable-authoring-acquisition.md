# P8-53I — stabilne przejęcie authoring przed restartem

Data: 03.10.2026. Status: prywatny guard zaimplementowany, produkcyjnie
skompilowany i zreviewowany; wykonanie przez koordynator restartu pozostaje otwarte.

## Kontrakt prywatnego guardu

`platform/development_restart.rs` zamyka admission mutacji przed uzyskaniem
`current_live_session_transition`. Czeka na mutacje przyjęte wcześniej,
następnie sprawdza snapshot, kolejkę i ledger. Obiekt przejęcia utrzymuje
obie blokady; odrzucenie albo anulowanie zwalnia je przez RAII.

Wynikiem jest jawny brak sesji albo pełny kanoniczny `SceneDocument` wraz
z identyfikacją API, sesji, runu, modelu i epoch. Dane edytora pozostają
w dokumencie. Projekcja ScriptBuilder nie służy do odtworzenia sceny.

Guard dopuszcza zweryfikowany bezczynny scratch UI oraz terminalny run
z pasującymi tożsamościami i świeżą łącznością. Odrzuca running/paused/unknown,
niespójny status, aktywne preparation, kolejkę, nierozstrzygnięte komendy
i trwające budowanie mesha. Brak heartbeat jest dopuszczalny wyłącznie dla
znanego scratch bez runnera; zwykły run wymaga świeżej obserwacji.

## Kształty lifecycle mesha

Review wykrył, że statusy prezentacyjne nie są pojedynczym enumem wykonania.
Ich bezpośrednia whitelista odrzucała prawidłowo zakończone operacje.

| Producent | Rzeczywisty terminalny kształt | Wymagana kontrola |
|---|---|---|
| `live_workspace.rs`, `mesh_build_summary` | `active_build=null`, faza `ready` przedstawiona jako `active` | Potwierdzony zakończony summary i terminalny zestaw faz; nie wolno ogólnie dopuścić `active`. |
| `orchestrator.rs`, statyczny FEM/FDM workspace | `done`, pominięte etapy `idle`, ostrzeżenia `warning` | Znany zestaw etapów i wynik siatki/kosztu; ostrzeżenie nie jest dowodem pracy w toku. |
| `orchestrator.rs`, terminalny błąd FDM | Etap `runtime="active"`, ale `mesh_cost_report.status="failed"` | Wyjątek wyłącznie dla potwierdzonego terminalnego raportu; zewnętrzny guard nadal sprawdza runtime i tożsamość runu. |
| `manual_remesh.rs`, odmowa/błąd | scalar `mesh_pipeline_status="failed"`, terminalny attempt i error | Zgodne terminalne dane błędu, brak aktywnego buildu. |
| Live mesh w toku | `active_build` lub aktywna faza przed `ready` | Odrzucenie niezależnie od historycznego zakończonego summary. |

## Dowody i pozostały zakres

- Niezależny source review kolejności admission/transition, tożsamości,
  preparation i ledger: bez konkretnego blockera poza powyższymi kształtami mesha.
- Poprawiono wszystkie cztery zgłoszone terminalne kształty mesha. Ponowny
  review ostatniej korekty FDM: bez nowego konkretnego blockera.
- Pierwszy build znalazł niezgodność slice/VecDeque; helper używa teraz
  iteratora, bez kopiowania ledgera.
- Końcowy `just windows-workspace-build dev dev 3197 auto`: exit 0,
  `windows-native-fdm-cpu-dev/build-status.json`, 19:48:13–19:49:46 UTC.
  Build pozostawił aktywne Python/dependencies i procesy workspace użytkownika
  bez restartu. Source snapshot:
  `3f5a3905e6da35af2e68951f8a9e838c49591073b3ebe96798d0227a60323e4e`.
- Końcowy `just verify-windows-development-backend-api`: **31 sprawdzeń,
  exit 0**, receipt `3e3ce414212a4ecf97a7951169b0f4ba`, profil
  `development-backend-api-checks`. Source hash przed/po:
  `196494821821a3a7b3b6f8fc7e6e1459e2667b135c5b119e050064080b2e0d6f`.
  Verified build ID:
  `0c92135443457734141d4a89ae542674ce251e0f835537507d04bf7e15d52661`.
  To dowód braku regresji zasobu dev/admission i protokołu service w pustych
  własnych procesach; verifier nie wywołuje prywatnego guardu workspace.
- Regresje Rust pozostają **NOT COMPILED / NOT RUN** zgodnie z zakazem
  kompilacji testów jednostkowych.
- Scoped rustfmt oraz diff check: PASS.

Guard nie kontroluje accepted store, nie drenuje service i nie zatrzymuje
procesów. Nie ma jeszcze publicznej komendy restartu ani runtime dowodu
wyścigu Start. Właściwy konsument musi dodatkowo sprawdzić accepted work,
uzyskać [terminalny drain](53h-workspace-acquisition-and-confirmed-drain.md),
zapisać handoff i potwierdzić odtworzenie przed nowym pinem API.

Odtworzenie będzie tworzyć świeżą tożsamość sesji przy zachowanym ID modelu.
Przed podłączeniem restore trzeba dopasować rozpoznanie scratch do tego
nowego konstruktora; dotychczasowe `create` używa aliasu session/model.
Nie wolno zmieniać ID modelu tylko w celu przejścia guardu. P8-53 i pełny
plan pozostają w realizacji.
