# P8-53CF — Debug anteny i kontrakty fixtures frontendu

Data: 14.10.2026. Baza `6357af85e4225ef0ac5d0dfafc24333e512b2869`.
Przyrost odpowiada diagnozom pełnej serii Control Room w jobie `115766888557`.

## Poprawki produkcyjne

- Kanoniczny `apiPaths.ts` obejmuje brakujący generated path pojedynczego
  compute node `/v2/platform/compute/nodes/{node_id}`. Bez zmiany endpointu,
  schemy, osobnego klienta ani nowych pobrań w komponentach.
- Gałąź anteny w `objectExplorerNodes.ts` pomijała Debug pod Visualization.
  Przywrócono wspólny `visualizationDebugNode` z tym samym kind, object ID
  i parent ID co pozostałe obiekty. Istniejąca regresja wymaga Debug jako
  ostatniego dziecka dla anteny i zwykłego obiektu; jej asercji nie zmieniono.

## Naprawy środowiska testowego

- AntennaObjectPanel DOM: partial mock zachowuje prawdziwy `KernelContext`,
  używany przez InspectorEditSession; `useKernel` nadal ma te same services.
  Asercje revision, pending draft, rebase i konfliktów zachowano.
- WorkspaceShellClient i WorkspaceNewProblemEntry: mock platform ma
  computeNodes z pustym inventory `not_probed`; StartScreen nie wywołuje
  już nieistniejącej metody mocka. Nie dodano fallbacku produkcyjnego.
- MeshBuildDialog: fixture przekazuje jawny string lane po projekcji
  authoring intent, zgodnie z bieżącym konsumentem. Nieznane auto, malformed
  object i null nadal fail closed. Nie rozluźniono gating FEM resources.
- ComputeEnvironmentWidget: asercja widocznego tekstu inventory pomija tagi
  HTML, zamiast wymagać nieprzerwanego tekstu w HTML ze spanem.
- Test DOM: distinct TestHTMLFormElement, factory form i window/global
  constructors z istniejącym restore descriptors. Regresja potwierdza,
  że section nie jest form. Rzeczywisty Radix Select nie jest mockowany.

## Dowody i wymagane odbiory

- Review diffu i istotnych konsumentów, TypeScript syntax parser 11 zmienionych plików,
  `git diff --check`: PASS. Lokalnych unit targets nie kompilowano.
- Managed production source native TS7: receipt
  `cb7fbcad87f44648be6bfdd469147aa2`, PASS / exit 0; digest before=after
  `114c41b3841e37463da026d0b5e3ee59470e7dc89326083e86385e05e2385fcb`.
- Końcowy pełny lint: receipt `47b0e7a1d0924f6fbd8d460022f3d56e`,
  PASS / exit 0; source digest before=after `bdb44194587aee5073ece54c71f3679179bbd0f08b42b0027a0f80ffcb9e90fa`.
- CI wykonania zmienionych regresji: NOT VERIFIED do wyników nowego SHA.
- Browserowy odbiór Debug i pełnego workspace: NOT VERIFIED.
- Dwie source assertions viewportu dopasowano po diagnozie: commit
  `15af8b95e40a85d34403b8cc6f9b9c589bc7adc6` świadomie usunął FEM
  renderingState z native FDM settings; istniejąca behavioral regresja
  chroni lokalne targets przed FEM registry. Source gate teraz zabrania
  tego nadpisania. Test materiału wymaga actual mounted surface.material,
  identity guard i MeshBasicMaterial przed needsUpdate, zamiast dawnego
  sposobu dostępu przez ref. To dowody źródłowe; WebGL/runtime NOT VERIFIED.
- CI na bazie 6357af85 kompiluje już poprawione testy API, lecz seria session
  API ma 85 PASS / 2 FAIL (job `115771144769`). Diagnoza dwóch lifecycle
  regresji trwa; nie utożsamiać tego z historycznymi 315/315 fullmag-session.

P8, pełny native pakiet, dwa restarty A→B→C i cały plan pozostają
**IN PROGRESS**. Procentów nie podniesiono.

Dalsze bramki na bazie 6357af85: generated-api-determinism wykazało drift
`openapi-v2-types.ts` po regeneracji (job `115771172525`); wymagane standardowe
managed generate-client, review różnic i ponowny typecheck. Python contracts
ma 4 FAIL / 35 PASS w testach box layered airbox (job `115771172550`):
requested 6 layers versus 7–9 exact z intervals. To odrębna diagnoza meshera
z naukowym kontraktem; nie zmieniać oczekiwań liczby warstw dla green CI.
