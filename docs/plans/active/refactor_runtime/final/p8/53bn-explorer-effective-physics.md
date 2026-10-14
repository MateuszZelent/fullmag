# P8-53BN — raportowanie aktywnych interakcji w Explorerze

## Status i zakres

Implementacja oraz główny scenariusz UI zweryfikowane; integracja PR
pozostaje otwarta. Ten przyrost nie zmienia fizyki,
Python DSL ani ProblemIR: koryguje opis istniejącego stanu w Explorerze.
Nie jest kwalifikacją FDM CPU/GPU ani FEM CPU/GPU.

## Przyczyna i właściciele źródeł

`apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
— `sceneObjectPhysicsInteractions` bezwarunkowo oznaczało Exchange i
Demag jako aktywne. `scenePhysicsInteractions` ignorowało globalne
wyłączenie przez Study. Badge w `objectExplorerNodes.ts` nie odpowiadał
wówczas rzeczywistemu wejściu wykonawcy. Dotyczyło to sceny z
exchange_enabled=false, demag_enabled=false i bez object physics_stack.

Istniejąca semantyka jest w
`packages/fullmag-py/src/fullmag/runtime/scene_document.py` —
`_ensure_physics_stack` i
`packages/fullmag-py/src/fullmag/runtime/script_builder.py` —
`render_scene_document_as_script`: globalne wyłączenie Study ma pierwszeństwo
przed lokalnym enabled. Renderer pomija niemagnetyczne role.

Poprawka obu snapshotów używa globalnego enabled (domyślnie true)
łącznie z lokalnym enabled (domyślnie true). Dla auxiliary/antenna
pomija cały stos i inferencję z materiału; syntetyczny airbox nie jest
zliczany jako magnet. Nazwa lub typ prezentacyjny nie aktywują fizyki.

## Dowody i ograniczenia

- Source regresje w `buildModelTree.test.ts` obejmują brak stosu,
  domyślne flagi, oba rodzaje wyłączenia, mieszane flagi i niemagnetyczne
  role z jawnymi wpisami oraz materiałem DMI. **NOT RUN**: obowiązuje
  zakaz kompilowania unit testów; nie zastąpiono go pozornym wynikiem.
- Production source typecheck po korekcie auxiliary/antenna PASS:
  `a3935642f7134b8da9e0686c1b84a3d4`; po poprawce modalu także PASS:
  `395bbb85b7c04aae9ff85d0feae58c5e`. Diff check PASS.
- Bounded read-only review korekty: brak nowego P0/P1. Pozostają odrębne
  P2: obecność Dind/Dbulk zamiast wartości niezerowej oraz normalizacja
  nieznanych/powielonych wpisów agregatu. Tego przyrostu nie przedstawiać
  jako zamknięcia całego raportowania wszystkich interakcji.
- Adapter SHA-256:
  `ae610567d060b7e3ba09d735cb8e3e4899ea7d715c95157806dd8211b6d1888b`.
  Test SHA-256:
  `993a1d25eb1a32dc6f1cc437fd47bb3da160252e8fe2c63dde25f7b2af0627cf`.

Nowy zamrożony pakiet ukończony exit 0 w istniejącym profilu dev, log
`native-build-921502f443e846e1bc28841228b30188.log`. Manifest SHA-256
`cb9c2825e1723592f17d76045434ce186bb22df906d72dc8290ad100052fc86c`,
source `55195bc1972d369d3644996e7ae9d978e496195e1c191c651f140d67acaae277`.
Wszystkie cztery pliki poprawek Explorera i modalu są identyczne w
checkoutcie i snapshotcie
`924ff8468236848b449de93c53e53e65e0d325e7544864aac0aea7c5d0db1052`.
Wymagane kolejne dowody: zgodny snapshot i realny Explorer pokazujący
Exchange/Demag disabled przy globalnym false, z odrębnie aktywną
anizotropią obiektu. Integracja PR #160 pozostaje otwarta.

## Rzeczywiste UI — 14.10.2026

Próba `9db8ad7c8b3046f28c6974f3e109f1ff` na pakiecie cb9c2825 pokazała
`Exchange degraded disabled` oraz `Demagnetization degraded disabled`.
Po jawnym dodaniu Ku1=1000 J/m³ osobny węzeł pokazał
`Uniaxial anisotropy active`; oba globalnie wyłączone terminy pozostały
disabled. Odczyt przypiętego API potwierdził obie flagi Study=false.
Stan zachowano również po zmianie API z
`fa4203fb-c04a-439c-8f80-bf87c149a603` na
`92761237-fd17-4afc-b96e-a829d976e69b`.
[Dowód UI](evidence/53bn-effective-physics-20261014.png).

Pod receipt zapisano `grid-failure-and-physics-observation.json` oraz
`pre-capture-authoring-input.json`. Próba przeszła Grid i Compute10
kroków, lecz przed Close/Finish wyczerpała limit czasu:
`browser_workspace_probe_timed_out`, failed/exit1, 28/28 procesów odebranych.
Nie przedstawiać jej jako PASS całej bramki restartu. Powtórzenie pełnego
scenariusza pozostaje wymagane dla nowego pakietu; source regresje
auxiliary/antenna nadal NOT RUN, a odrębne P2 nadal otwarte.

## Końcowy dowód nowego pakietu — 14.10.2026

Pełna próba `81eb7f40d2c8428baae938f5be5bef73` zakończyła się
completed / exit 0: 10 kontroli, 27/27 procesów odebranych.
Pakiet `cb9c2825e1723592f17d76045434ce186bb22df906d72dc8290ad100052fc86c`
zawiera tę poprawkę; staged production typecheck/lint exit 0.
Rzeczywisty Explorer po utworzeniu obiektu pokazał Exchange disabled
i Demagnetization disabled; jawna anizotropia pozostała aktywna.
Model z materiałem, regionem, Uniform +X oraz Ku1=1000 J/m³ zachowano
po restarcie i wykonano 10 kroków FDM CPU-reference, double/strict.
Unit regresje pozostają NOT RUN; przypadki aux/antenna mają dowód źródłowy,
nie osobny runtime proof. Integracja PR #160 pozostaje nieukończona.
