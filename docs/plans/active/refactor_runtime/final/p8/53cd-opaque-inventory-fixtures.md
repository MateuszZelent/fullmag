# P8-53CD — fixtures nieprzezroczystego inventory

Data: 14.10.2026. Baza `ec416fe3bd9f04bcb68558e9cbfe489fa10a8916`.

CI job `115764408127` odrzuciło próbki inventory i policy jako niezgodne
z `Record<string, never>`. Backend celowo opisuje `serde_json::Value` jako
opaque object; frontend przyjmuje payload jako unknown i waliduje go
w `parseComputeNodeSnapshot` oraz `parseNodePolicy`. Generated types nie są
publiczną definicją pól wnętrza snapshotu. Nie zmieniono schema ani parserów.

Fixture `computeNodeInventory.test.tsx` przekazuje raw snapshot i policy przez
jawnie opisany testowy cast unknown, zgodnie z istniejącym precedensem
`runtimeExplorerResources.test.ts`. Bezpośrednie testy parsera nadal używają
surowego literalnego snapshotu. Asercje freshness, poprzedniego bootu,
read-only polityki i rendering pozostają bez zmian.

Review źródeł i konsumentów, TypeScript syntax parser oraz diff check: PASS.
Lokalnych unit sources nie kompilowano ani nie wykonywano. Wykonanie CI na
tej poprawce pozostaje NOT VERIFIED do odczytu wyników z odpowiedniego SHA.

Powiązana naprawa fixtures Inspectora z commita
`ec416fe3bd9f04bcb68558e9cbfe489fa10a8916` usunęła poprzednie diagnozy
ProjectBatchesSection/StudyInspectorPanelModel z logu nowej bramki.
`canonicalization-guards` na tym SHA: SUCCESS (job `115764405485`), po
regeneracji README z bieżących manifestów. Nie dowodzi to jeszcze green CI
całego PR, pełnego buildu ani odbioru browser/runtime.
