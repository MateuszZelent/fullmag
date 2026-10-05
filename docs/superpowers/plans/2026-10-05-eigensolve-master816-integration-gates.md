# Bramki integracji eigensolve po master816 — 05.10.2026

## Tożsamość i zakres

Branch `codex/eigensolve-dispersion-plan-20260912`, merge
`a54ed087a9fa941477e8c7a15f700e3ace032df0` z mastera
`81600790c3aad6d3b8f50cdbd33c9155ee7a0a43`. Remote checkpoint
`38cad3c5163dff4c5b4fe20160440079b5eb5b92`, PR97 OPEN/MERGEABLE.
To checkpoint integracji, nie zakończenie S00–S12.

## Dowody i pozostałe zadania

| Bramka | Dowód | Stan / kolejny krok |
|---|---|---|
| Native Windows FDM CPU package | Recepta windows-workspace-build, terminal completed/exit0; backend 39,47 s i desktop 1 min 02 s; 3 hashe zgodne z manifestem; source identity passed, local changes enforced | PASS dla zbudowanych źródeł. Nie jest dowodem FEM ani aktualizacji później zmienionych fixture’ów. Receipt starego wrappera nie wiąże własnym hashem manifestu; niezależny verifier zapisał jego hash. |
| Źródła integracji | 96 testów Python +24 podtesty; 34 storage checks PASS, 2 pominięte; review konfliktów i krótszej ścieżki Cargo PASS | Dowody źródłowe, bez kwalifikacji solvera. |
| API generation | CI generated-api-determinism PASS dla remote checkpointu | Lokalne generate-client PASS, artefakty zgodne semantycznie z indeksem Git; jawny reuse tego samego native workspace. 11 helper +4 shell +4 publication regresje PASS i review PASS. |
| Production frontend | Lokalne production-source PASS (TypeScript bez testów), source unchanged; API hygiene PASS | Bramka źródłowa PASS; browser/WebGL i runtime/UI nadal oddzielne. |
| CI frontend contracts | Błędy typów w 8 plikach unit tests, m.in. JSON merge_patch study oraz status fixture | OPEN. Oddzielić produkcyjne źródła od fixture’ów; naprawić konkretne błędy bez obniżania kontraktu. Nie kompilować unit tests, dopóki zakaz obowiązuje. |
| CI Rust contracts | 5 błędów cfg(test): import ConsistentP1TrackingMetric, usunięty wariant analitycznego solvera, serde identity type, 2 klonowania referencji periodic pair | Źródła poprawione, parser 4 plików PASS. Zachowano fixture provenance z numeric solver tag oraz analityczną kolumną (syntetyczne frequency=analytic*1,01), usunięto test wycofanej trasy zastępującej solve analityką. To nie wykonany FEM solve ani walidacja naukowa. Review PASS. Kompilacja/wykonanie unit tests NOT VERIFIED. |
| CI scientific docs | Ścisły walidator wskazuje wyłącznie notę/source-map0832 | Korekta dwóch dokumentów w toku, bez zmiany fizyki ani deklarowania 2.5D provider jako dostępnego. |
| CI browser fixture | Timeout boundary przed canvas w audit-viewport-3d-fem-topology-uploads.mjs:111 | OPEN. Trzeba ustalić przyczynę i wykonać rzeczywistą kontrolę przeglądarki; nie zwiększać timeoutu jako zamiennika diagnozy. |
| Runner FEM | Live health worker failed: OSError Errno5 Input/output error, accepting false, active jobs=[], ponad50GB wolnego | Operator zadeklarował samodzielny restart Docker Desktop. Nie zlecono nowych obliczeń; po restarcie wymagane health, job/lease reconciliation i atestacja runnera. |
| Nauka i UI | Bez nowych wyników w tej sekwencji | Exact-runtime GMRES/FGMRES, shared signed sweep i serial/adaptive parity, zbieżność, GUI, COMSOL A1, S09/provider i GPU nadal OPEN. |

## Lokalizacja dowodów

Artefakty bieżącego hosta są poza repozytorium w katalogu
`preview-state-checkpoint` zadania. Native verifier:
`native-stable-build-38cad3c51-proof.json`; logi nieudanych CI:
`ci-master816-38cad3c51/{frontend,rust,browser,docs}.log`.
Stan i pełne źródła identyfikacji wyników pozostają w kanonicznym storage.
Nie należy traktować zielonego API/storage/React Doctor/FDM CI jako sukcesu FEM.

## Trasa powtarzania kontroli

Z rozwiązanego native profilu odczytać `frontend_workspace_root` w
`windows-runtime/build-manifest.json`; nie wybierać katalogu innego worktree.
Przekazać tę wartość jako argument:

```text
just generate-control-room-client "<frontend_workspace_root>"
just check-control-room-production-source "<frontend_workspace_root>"
just check-control-room-api-hygiene "<frontend_workspace_root>"
```

Opcjonalny argument jest legalny wyłącznie dla tych trzech lekkich tras.
Bez niego zachowano dotychczasowy dependency routing. Source stage i receipty
są potomkami przypisanego build_root, a zależności pozostają czytane z
zatwierdzonego native workspace. Kolejne publishery współdzielą lock worktree;
kontrola edycji poza protokołem lock jest jawnie optymistyczna.
