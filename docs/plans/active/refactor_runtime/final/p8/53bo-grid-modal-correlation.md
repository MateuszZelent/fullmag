# P8-53BO — korelacja potwierdzenia i wyniku Grid

## Status

Potwierdzony błąd UI ma poprawkę i rzeczywiste dowody obu terminalnych
stanów modalu. Production typecheck i bounded source review PASS.
Integracja i pełna bramka nowego pakietu pozostają otwarte.

## Dowód przed poprawką

Próba `2998926363e84fd5b32569767c9a44b0` zaliczyła pełny restart,
Grid/Compute/Close, ale modal Grid nadal pokazywał submitting.
GET listy oraz GET szczegółu nowej komendy
`fm-1325a9f8-a33e-449a-884e-0ff826ad790b` zwróciły completed:
started_at_unix_ms=1791940744849, terminal_at_unix_ms=1791940745291.
To wyklucza hipotezę braku terminalnego stanu w szczególe tego przypadku.

`geometryLifecycleCommandContributions.ts` — `grid.build-fdm` otrzymywało
confirmation.requestId, ale nie przekazywało go do
`runFdmGridRefreshOperation`. Wykonawca tworzył osobne fdm-grid-refresh ID.
`meshBuildDialogState.ts` — `meshBuildDialogReducer` odrzuca eventy,
które nie odpowiadają ID potwierdzenia. To utrata korelacji,
a nie potrzeba drugiego POST ani słabszego reconciliation.

## Poprawka i weryfikacja

Wewnętrzny opcjonalny argument przenosi confirmation.requestId do
operacji FDM. To samo ID trafia do client_intent_id oraz
mesh:build-submitted i mesh:build-observed. Bezpośrednie wywołania
bez argumentu zachowują dotychczasowy fallback. Deduplikacja,
polling, blokada aktywnej operacji i publiczny kontrakt nie zmieniają się.

Istniejąca regresja jawnej komendy FDM otrzymała bus i asercje ID
potwierdzenia, POST oraz obu eventów. Auto-confirm używa istniejącego
`registryWithLifecycleCommands`; istniejąca regresja reducer sprawdza
pasujące completed → post-build. Unit regresje pozostają **NOT RUN**
z powodu zakazu ich kompilacji. Bounded source review: brak P0/P1/P2;
utracony ACK z jawnym ID jest dodatkową niepokrytą runtime granicą.

Production source typecheck PASS:
`395bbb85b7c04aae9ff85d0feae58c5e`; diff check PASS.
Source SHA-256:
`10231c3a7ff309774fecac5dc4dfb54ae91a9d6b10b59b55de3730dbe5839701`.
Test SHA-256:
`81bf1a4bde44f13d07848c4f4cef841f90ac48f74a60fdb7836bde56c214ec15`.

Nowy build ukończony exit 0: log `native-build-921502f443e846e1bc28841228b30188.log`,
snapshot `924ff8468236848b449de93c53e53e65e0d325e7544864aac0aea7c5d0db1052`.
Manifest SHA-256:
`cb9c2825e1723592f17d76045434ce186bb22df906d72dc8290ad100052fc86c`.
Backend source pozostał `a79bc49d271115f57bbdee8c72f40dbcc452623888a954b54a78aa236cb7d46e`;
zmieniono frontend, nie semantykę solvera. Uruchomiono nową prywatną
próbę przywrócenia workspace; terminalny wynik pozostaje w toku.
Wymagany odbiór UI: normalne potwierdzenie Grid → jedna komenda →
terminalny detail → modal opuszcza submitting. Przy failure powinien
pokazać znaną odmowę, bez ponownego wysłania komendy.

## Browser proof obu wyników — 14.10.2026

W prywatnej próbie `9db8ad7c8b3046f28c6974f3e109f1ff` normalny Grid bez
cell size przyjął komendę `fm-71fa21c6-03f2-4b32-8f0f-b0bdf0fc7c0d`,
client_intent_id=`mesh-confirm-1791942667817-1`. Szczegół wskazał failed,
terminal_at=1791942683805. Modal przeszedł z accepted do
`FDM Grid Build Failed`, pokazał tę samą komendę i Build Error.
Nie wysłano duplikatu. [Znana odmowa](evidence/53bo-grid-known-failure-20261014.png).

Po ustawieniu default_cell=[5e-9,5e-9,5e-9] m bezpośredni Apply Grid
zakończył `fm-f596d535-d3f4-487d-bb1e-c1594fd25db0` jako completed,
z zachowanym fallbackiem `fdm-grid-refresh-1791942873221-1`.
Po capture i restarcie nowy API
`92761237-fd17-4afc-b96e-a829d976e69b` wykonał nowy Grid
`fm-31c02616-584d-4f92-89d6-93a5083d8fdd`,
client_intent_id=`mesh-confirm-1791943586018-2`, completed,
terminal_at=1791943599356. Modal pokazał
`FDM Grid Build Complete`, stan published i potwierdzenie aktualizacji
viewportu. [Wynik poprawny](evidence/53bo-grid-complete-20261014.png).

Compute `fm-c6447d18-d66e-4448-94c8-716cde18a8f0` zakończył etap
stage-000, completed_step=10. Cały receipt ma jednak failed/exit1:
`browser_workspace_probe_timed_out` przed Close/Finish,
28/28 procesów odebranych. Nie zmieniono limitu ani weryfikatora dla PASS.
Te obserwacje dowodzą korelacji oraz zachowania modalu, nie zaliczenia
pełnej bramki nowego pakietu. Wymagana jest krótsza kompletna próba.

## Pełna bramka nowego pakietu — 14.10.2026

Kolejna próba `81eb7f40d2c8428baae938f5be5bef73` zakończyła się
**completed / exit 0**, 10 kontroli, 27/27 procesów odebranych.
Pakiet `cb9c2825e1723592f17d76045434ce186bb22df906d72dc8290ad100052fc86c`
zawiera poprawkę korelacji. Nowy API:
`20dc8dd8-495b-4a01-adcd-a432b7bacd4c`.

Jedno potwierdzenie Grid uruchomiło
`fm-887a8183-db52-471a-8bfa-4c469da0c6f1`; completed,
completed_at=1791945654779. Modal pokazał **FDM Grid Build Complete / published**
oraz „New grid revision published. Viewport update complete.”
[Dowód UI](evidence/53bo-full-frontend-proof-20261014.png).
Compute `fm-d3b4adb8-65e1-4148-89d8-37e9574c7688` zakończył
stage-000 i 10 kroków. Close
`fm-0d4dbb2c-5536-48d4-84e4-a3e308760876` completed,
session tombstone=1791945690167. Dzieci Grid i Compute exit 0,
kill_requested=false. Scena, dirty document i kamera zachowane.

Staged production typecheck/lint exit 0. Bramka odnotowuje końcowy exit 1
replacement API, exit 0 starego API i odebranie obu; nie dowodzi, że każdy
proces zakończył się exit 0. Normalne Close dotyczy solvera i ma osobny
completed oraz naturalny exit dziecka. Zakres: Windows/FDM CPU-reference,
double/strict, box 100×100×10 nm, cell 5 nm, Uniform +X i Ku1=1000 J/m³.
Pozostałe lane’y i wydanie pozostają NOT VERIFIED; PR #160 nie jest scalony.
## Ustalenie granicy cleanupu API — 14.10.2026

Końcowy exit 1 replacement API w receipt
`81eb7f40d2c8428baae938f5be5bef73` nie jest dowodem awarii Compute.
Log replacement API kończy się synchronizacją sceny i nie pokazuje
końcowego wyjątku. Ścieżka `development_workspace_probe.rs::shutdown_exact_api`
sprawdza dokładne api_instance_id oraz child_pid, a następnie wywołuje
`DevelopmentApiSupervisor::shutdown`. Dla nadal działającego procesu ten
kod stosuje child.kill() i child.wait(); odmawia cleanupu unknown handoff.
To zgodne z zarejestrowanym exit 1 po zakończeniu kontrolnej próby na Windows,
ale odczyt logu i źródeł nie dowodzi naturalnego zamknięcia API.

Zgodność dwóch odczytanych źródeł z zamrożonym capsule 924ff846... PASS:
- development_api_supervisor.rs SHA-256
  `f777765d03918ed0cfe5e19abe397f7bd0525e08113bc22a9300ce25dfa17213`;
- control_room/development_workspace_probe.rs SHA-256
  `146e63c3c24770378503fb7686e9f422b12eb190b92d675197055ded656af7dd`.

Normalne solver Close i odebranie dzieci z exit 0 mają oddzielny dowód
w tym samym receipcie. Nie zmieniono progu PASS, API ani żadnego procesu;
to odczyt sealed wyniku i odpowiadających mu źródeł. Runtime qualifier
nadal nie powinien sugerować, że wszystkie procesy zakończyły się exit 0.
