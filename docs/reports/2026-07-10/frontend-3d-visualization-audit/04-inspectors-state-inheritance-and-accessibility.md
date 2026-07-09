# 04. Inspektory, stan, dziedziczenie i dostępność

## F3D-013 — nieuzgadniany local overlay wygrywa do clear albo reload

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** HTTP v2 visualization resource jest właścicielem stanu. Lokalny
controller może zapewnić krótką optymistykę, ale musi zostać uzgodniony po ACK.

### Dowód i mechanizm

- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:416-463`
  nakłada local override po backend override, więc lokalna wartość zawsze wygrywa.
- `ObjectVisualizationPanel.tsx:1323-1341` kolejkuje remote patch, a następnie
  zapisuje cały patch do lokalnego controllera "until ... refetch".
- Nie ma ścieżki, która po ACK/refetch usuwa remote-supported pola z local override.
- `ObjectVisualizationPanel.tsx:1158` ustawia `pending = false` na stałe.
- `VisualizationRegistrySyncController.ts:145-193,214-249` po błędzie przywraca
  patch i planuje ponowienie; panel nie pokazuje error, rollback ani statusu.
- Command registry clear w `visualizationCommandContributions.ts:404-423` usuwa
  backend override, lecz przy dostępnej API ścieżka nie czyści local controller.

### Reprodukowalny scenariusz

1. Inspector ustawia `wireframe=false`.
2. PATCH zostaje potwierdzony; local `false` nie jest usunięte.
3. Ribbon albo drugi klient ustawia backend `wireframe=true`.
4. Refetch dostarcza `true`, ale resolver nadal nakłada lokalne `false`.

Przy odrzuconym PATCH UI zachowuje pozornie zastosowaną wartość, a sync może
ponawiać ją bez widocznej informacji dla użytkownika.

### Plan naprawy

1. Ograniczyć `ObjectVisualizationController` do pól rzeczywiście local-only.
2. Backend-supported optymistykę utrzymywać tylko w
   `VisualizationRegistrySyncController`, z identity patchu i powiązaniem z
   istniejącą ACK/resource revision zwracaną albo pobieraną po PATCH. Jeżeli
   istniejący kontrakt nie wystarcza, dopiero wtedy zaplanować zmianę OpenAPI.
3. Po ACK/refetch usuwać optimistic overlay; po konflikcie uzgadniać według
   resource revision, nie według czasu lokalnego renderu.
4. Udostępnić w `useVisualizationStateResource` status
   `idle/pending/inflight/error`, ostatni error i retry count.
5. Dodać bounded exponential backoff, limit lub terminalny error dla trwałych
   błędów walidacji; nie ponawiać bez końca błędu 4xx.
6. Clear/reset musi atomowo usunąć remote override i odpowiadający optimistic/local
   fragment.

### Test regresyjny i kryterium akceptacji

- `Inspector edit -> ACK -> remote/ribbon edit -> resolver` kończy z wartością
  ostatniej rewizji HTTP.
- Odrzucony PATCH daje rollback albo jawny unsynced state i widoczny błąd.
- 4xx nie tworzy nieograniczonego retry; transient network error ma bounded backoff.
- Dwa klienty zbiegają do tego samego `targets.*.settings`.

## F3D-014 — ukryty target nadal ma aktywne kontrolki passów

**Priorytet:** P1 — wysoki
**Dowód:** T + S
**Kontrakt:** przy `visible=false` passy pozostają skonfigurowane, ale są
efektywnie inactive i disabled w Ribbonie, Inspectorze oraz commands.

### Dowód i mechanizm

- `ObjectVisualizationPanel.tsx:1278-1284` wylicza effective sections, ale
  `passControlsDisabled = pending`; nie uwzględnia `!settings.visible`.
- Render Mode (`:449-474`), surface/wireframe/points/vectors i geometry scope nadal
  można kliknąć przy ukrytym targetcie.
- Helpery passów automatycznie ustawiają master `visible:true`; test
  `ObjectVisualizationPanelModel.test.ts:554+` utrwala to zachowanie.
- Ribbon stosuje poprawny gate `!settings.visible`, więc obie powierzchnie są
  niespójne.
- Command registry `visualizationCommandContributions.ts:29-36,166-195` sprawdza
  tylko obecność targetu/controllera; command palette albo shortcut może zmienić
  pass ukrytego targetu.

### Wpływ

Skonfigurowany pass wygląda w Inspectorze na aktywny albo jego kliknięcie
nieoczekiwanie odsłania cały target. Użytkownik nie odróżnia configured od
effective state.

### Plan naprawy

1. Ustawić `passControlsDisabled = pending || !settings.visible` dla wszystkich
   kontrolek poza master Visible i bezpiecznym Reset.
2. Renderować active/checked na podstawie effective settings, a configured value
   pokazać pomocniczo jako "will restore when visible".
3. Usunąć automatyczne `visible:true` z pass-only patch helpers; jeżeli produkt
   potrzebuje "Show with pass", utworzyć osobne jawne polecenie.
4. Dodać command-level guard dla pass/style commands przy hidden target.
5. Ujednolicić disabled reason między Ribbon, Inspector i command palette.

### Test regresyjny i kryterium akceptacji

- Hidden target: Visible jest dostępne, pozostałe pass/style controls disabled i
  wizualnie inactive.
- Konfigurowane wartości nie są kasowane.
- Po Visible=true wracają bez dodatkowego PATCH passów.
- Command palette/shortcut nie omija gate.

## F3D-015 — „Inherited” i child reset nie usuwają rzeczywistego override

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** wybranie Inherited usuwa daną właściwość override; reset child
regions działa również po reloadzie, gdy override istnieje tylko na backendzie.

### Dowód i mechanizm

- `visualizationCommandContributions.ts:329-348` dla `inherit` wysyła
  `shaderColorMode: undefined` i `surfaceColorSource: undefined`.
- Normalizacja patchu usuwa undefined, a merge zachowuje dotychczasowe pole w
  istniejącym override. Nie istnieje jawna operacja delete-field.
- `ObjectVisualizationPanel.tsx:1244-1246` liczy child overrides wyłącznie w
  `snapshot.overrides`, ignorując `visualizationState.data.overrides`.
- Przycisk clear jest disabled przy count=0 (`:1121-1130`), więc backend-only
  overrides po reloadzie nie mogą zostać usunięte z tego panelu.

### Wpływ

Command „Inherited” kończy się sukcesem, ale jest no-op i poprzedni color mode
pozostaje. Obiekt może też raportować `0/N child overrides` mimo rzeczywistych
region overrides na backendzie.

### Plan naprawy

1. Dodać semantyczną operację `removeTargetOverrideField`, która pracuje na
   pełnym bieżącym wpisie.
2. Po usunięciu pola usuwać puste `style/display/quantity`, a następnie cały
   pusty override.
3. Liczyć child overrides z backendowego current state plus tylko faktycznie
   local-only/optimistic pól, deduplikując target id.
4. Child reset ma wysłać jeden atomowy PATCH z odfiltrowaną listą overrides.

### Test regresyjny i kryterium akceptacji

- `component_x -> Inherited` usuwa pole z serialized override i przywraca owner
  style po refetch/reload.
- Backend-only child overrides są policzone i przycisk jest aktywny.
- Clear usuwa wszystkie i tylko regiony bieżącego owner object.

## F3D-016 — kontrolki local-only są wymieszane z persistent controls

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** użytkownik musi wiedzieć, które ustawienia są stanem sesji i
round-tripują między klientami, a które są lokalną preferencją viewportu.

### Dowód i mechanizm

- W ścieżce targetów innych niż airbox `ObjectVisualizationPanel.tsx:277-286`
  usuwa z remote patch `vectorCenteringEnabled`, `vectorSurfaceOffsetEnabled`,
  `vectorSurfaceOffsetScale` i `primitiveVisible`. Airbox omija ten helper i ma
  osobny local/remote split opisany w `F3D-010`.
- Inspector eksponuje te pola obok persistent vector/style settings, np.
  `Centered arrows`, `Lift above surface`, `Extra surface gap` w `:956-979`.
- Po pełnym reloadzie i na drugim kliencie wartości nie są zachowane, ale UI nie
  oznacza ich jako lokalnych/dev-only.

### Wpływ

Użytkownik oczekuje persistence i spójności targetu, której te kontrolki nie
zapewniają. To dodatkowo zwiększa zakres drugiego local store z `F3D-013`.

### Plan naprawy

1. Dla każdej właściwości podjąć jawną decyzję:
   - publiczny target setting w OpenAPI/backendzie; albo
   - lokalna viewport preference z osobnym ownerem i etykietą "This viewport";
   - dev-only control ukryty poza produkcyjnym Inspectorem.
2. Nie przechowywać local-only target fields w tym samym kształcie co canonical
   session target overrides.
3. Dodać widoczne scope/persistence metadata w Inspectorze.
4. Dodać test reload/two-client zgodny z wybraną polityką.

### Test regresyjny i kryterium akceptacji

- Każda kontrolka ma zdefiniowanego ownera i test persistence.
- Persistent fields round-tripują przez HTTP; local fields nie udają backend ACK.

## F3D-017 — toggle i segmented controls nie eksponują stanu dla AT

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** kontrolki shadcn-style muszą mieć keyboard i accessibility semantics,
a aktywny stan nie może być przekazywany wyłącznie kolorem/variantem.

### Dowód i mechanizm

- `ToggleButton` w `ObjectVisualizationPanel.tsx:1889-1912` używa
  `data-active` i wariantu wizualnego, ale nie `aria-pressed`.
- Render Mode (`:449-474`), Vector coloring (`:910-923`) i Arrow extent
  (`:981-1005`) to grupy zwykłych buttonów bez `role=radiogroup`/
  `role=radio`/`aria-checked` albo semantyki ToggleGroup.
- `ColorField` w `:1751-1785` obejmuje dwa inputy jednym `<label>`; picker ma
  `aria-label`, ale text input nie ma osobnej dostępnej nazwy.

### Wpływ

Czytnik ekranu nie komunikuje, który tryb jest aktywny. Grupy nie mają pełnej
semantyki jednokrotnego wyboru, a tekstowa wartość koloru może otrzymać
niejednoznaczną etykietę.

### Plan naprawy

1. Zastąpić bespoke button groups wspólnym shadcn-style Toggle/ToggleGroup albo
   RadioGroup zgodnie z semantyką.
2. Dla boolean toggles użyć `aria-pressed`.
3. Dla single-select grup dodać label grupy, roving focus i arrow-key navigation.
4. Nadać color picker i text input osobne `id`/`htmlFor` lub `aria-label`.
5. Nie opierać selected/disabled state wyłącznie na kolorze.

### Test regresyjny i kryterium akceptacji

- Test markup sprawdza role, accessible name i checked/pressed state.
- Browser accessibility smoke obsługuje Tab, Space/Enter i strzałki.
- Hidden/disabled semantics z `F3D-014` są prawidłowo ogłaszane.
