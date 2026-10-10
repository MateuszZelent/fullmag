# Bramka UI R2 - wynik i zakres diagnostyki

Stan: czesciowy, pelne UI i browser NOT VERIFIED. Ten dokument nie zastapuje
planu P10 ani review wskazanych plikow.

Na exact `ea59d2cb201d4e24c7755ec48a6335b7143854a7`, GHA
[38076097699](https://github.com/MateuszZelent/fullmag/actions/runs/38076097699):

| Bramka | Dowod |
|---|---|
| Metadata pnpm regression / physical install | PASS |
| Architecture hygiene | PASS |
| Pelny frontend typecheck | PASS |
| Modal/chart/phasor/Inspector Vitest | 100 PASS, 1 FAIL (signed zero) |
| React Doctor | FAIL, 9 errors i 608 warnings, score 57/100 |
| Browser / widoczny workspace i WebGL | NOT VERIFIED |

Signed-zero correction jest na remote w `fe99244d060489a3f67c4afc7de09445bdba5220`.
Dodatkowe cztery przypadki ±0/obu phasorow zachowuja znaki niezerowego growth.
GHA #38076746462: 105 Vitest i typecheck PASS; terminalny doctor FAIL
(9 errors/617 issues/57 score), dlatego cale workflow nadal FAIL.
Raport i manifest source identity pobrano; hashe zapisano w ci-evidence JSON.

Doctor wskazal ponizsze error locations. Jest to raport narzedzia; nie dowod,
ze wszystkie sa nowymi bledami tej zmiany lub prawdziwymi defektami runtime.
Nie zmieniamy ich bez oceny kontraktu i konsumentow.

| Rule | Location | Nastepna kontrola |
|---|---|---|
| effect-needs-cleanup | src/kernel/layout/NewProblemDialog.tsx:44 | Ocena lifetime i cleanup effect |
| effect-needs-cleanup | src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx:978 | Ocena pending mutation/timer ownership |
| effect-needs-cleanup | src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx:212 | Ocena pending mutation/timer ownership |
| effect-needs-cleanup | src/modules/start/model/useComputeProbe.ts:25 | Ocena abort i lifetime probe |
| no-ref-current-in-render | src/modules/inspector/panels/ObjectMaterialPanel.tsx:179 | Ocena render/commit i concurrent rendering |
| no-prop-callback-in-render | src/modules/inspector/panels/RegionalFieldDrivePanel.dom.test.tsx:66 | Test fixture, rozdzielenie od runtime komponentu |
| no-hydration-branch-on-browser-global | src/modules/start/inspector/AboutInspector.tsx:125 | Server/client contract |
| no-hydration-branch-on-browser-global | src/modules/start/sections/AboutSection.tsx:499 | Server/client contract |
| no-hydration-branch-on-browser-global | src/modules/start/sections/IndexedLocations.tsx:44 | Server/client contract |

Dodatkowe warnings w modal Inspector (m.in. clone i callback effect) wymagaja
klasyfikacji, ale nie sa raportowane jako dziewiec errors. Surowy doctor report
zostaje zachowany przez workflow w zarzadzanym artefakcie, bez continue-on-error.
