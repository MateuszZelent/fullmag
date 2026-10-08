# Antena: oddzielenie wizualizacji źródła od wizualizacji magnetycznego targetu

## Zakres poprawki

Zgłoszony błąd był potwierdzony w aktywnym workspace: węzeł Visualization
anteny otwierał Inspector „Magnetic object”, z quantity `m`, kontrolkami
wektorów i geometrii magnetycznego obiektu. Źródłem błędu było przypisanie
antenie tego samego rodzaju węzła `object.visualization` co falowodowi.

Nowy węzeł `object.antenna.visualization` ma własny Inspector. Nie dziedziczy
magnetycznych potomków Debug ani mode visualization. Nie usuwa natomiast
jawnie skonfigurowanego grafu fizyki obiektu i nie aktywuje żadnej fizyki na
podstawie nazwy lub typu prezentacyjnego. Stara selekcja `object.visualization`
jest sprawdzana względem właściciela w zasobie sceny, więc zapamiętany wybór
nie przywraca błędnego panelu. Inspector ma jednego właściciela subskrypcji
sceny; panel ogólny otrzymuje tę samą odczytaną scenę.

## Dane widoczne w nowym panelu

| Wybór | Zasób binarny istniejącego rozwiązania | Jednostka | Pozycje |
|---|---|---|---|
| Potencjał V/I | `electric_potential_per_ampere` | V/A | `conductor_positions` |
| Gęstość prądu J/I | `current_density_per_ampere` | A/m²/A | `conductor_positions` |
| Bezpośrednie pole Oersteda H/I | `magnetic_field_per_ampere` | A/m/A | `sample_positions` |

Panel wybiera stage należący do niezmiennego ID anteny, a następnie bazę
portu i quantity. Odczytuje opublikowane dane przez istniejącą fasadę i resource
hooks. Nie uruchamia LLG, relaksacji, preview-control ani obliczeń przy zmianie
quantity. Zakres odczytu jest ograniczony do ośmiu próbek: 64 bajty dla skalaru
V/I i 192 bajty dla wektorów/pozycji. Weryfikowane są format float64 LE,
layout, liczba wartości, jednostki, skończoność liczb oraz ETag payloadu.

Przed odczytem liczb sprawdzane są katalog publikacji, asset/digest/stage,
źródło, transport i aktualny właściciel sesji. Błędna tożsamość nie daje dostępu
do payloadów. Nieaktualny hook nie przedstawia zachowanych liczb jako gotowych.
Brak wymaganej definicji lub rozwiązania jest jawnie opisany.

Opublikowany asset jest oznaczony **published snapshot**, nie jako wynik
zgodny z aktualnymi wejściami. Panel pokazuje piny geometrii, materiału i
siatki. Samo porównanie tożsamości publikacji nie certyfikuje aktualności
wejść; tego ograniczenia nie ukryto. Wynik po zmianie geometrii wymaga nowego
solve albo reuse zwalidowanego przez runtime.

`H_ant` po skalowaniu prądem/waveformą pozostaje wielkością na odbiorczym
obiekcie/regionie/airboxie, a nie magnetyzacją przewodnika. Source FFT pozostaje
w osobnym węźle Spectrum; nie jest utożsamiane z odpowiedzią magnetyzacji.
Nie dodano wymyślonego identyfikatora `B_ant` ani pozornego `b_zeeman_antena_1`.

## Dowody

- Kontrole architecture hygiene oraz API hygiene: exit 0.
- Produkcyjny TypeScript, bez kompilacji testów jednostkowych: PASS,
  receipt `5b3999db03b84b029484e6d2321784b4`, fingerprint
  `48ab1912ec021605ffe9475ceab9bb85d160123624144a965c85397708cbe25a`,
  bez zmian źródeł podczas kontroli.
- Regresja Chrome produkcyjnego Explorer/route/panel/resource hooks:
  końcowy receipt `a819dfe144914731b6b7159fed9ab6dc`, PASS. Sprawdzono brak stage,
  przełączanie V/I–J/I–H/I, ograniczone zakresy i scope, brak żądań idle,
  legacy selection, obcy source i błędny layout. Źródła nie zmieniły się podczas
  kontroli; obejmuje korektę czytelności komunikatu i pełne typy harnessu.
  Po przebiegu zmieniono wyłącznie callback fixture na inline `useMemo`,
  zgodnie z regułą ESLint; produkcyjne źródła pozostały identyczne.
- Pełny ESLint: PASS, exit 0, receipt `a73d515fc0d24cd4bcf96fdd0085c281`.
- Niezmieniona regresja Object/Airbox: PASS, receipt
  `1e1919c79a4045aaaf0ed18d72870c0a`. Sprawdzono stabilność korzenia panelu,
  scroll/focus/draft, brak niepowiązanych disabled/opacity zmian podczas
  pending/refetch/ACK oraz ograniczone żądania/renderowanie.
- Niezależne review całego zakresu poprawki: brak Blocker/Required.
- W aktywnej sesji `session-18dc56634a2145f00000e874`, port 3197, ręcznie
  przeklikano antena → Visualization oraz falowód → Visualization. Antena
  otwiera własny panel; falowód zachowuje „Magnetic object” i `m`.
  Antena jawnie zgłasza brak mesh-exact ConservativeCurrentView. Nie
  uruchamiano solve ani mutacji modelu.
- Aktualizacja uruchomionego frontendu: przez istniejący DevSourceMirror
  opublikowano wyłącznie dziewięć plików źródłowych poprawki do zweryfikowanego
  stage `ae9f4e3519c04fdcbf558e3a2eb3f018`; potwierdzono zgodność ich bajtów
  i SHA-256. Nie usunięto plików, nie zmieniono zależności ani nie
  restartowano backendu. Odświeżono wyłącznie stronę przeglądarki.

Dowody zarządzane znajdują się w `storage/builds/` checkoutu projektu,
w profilach `windows-control-room-source-check` i
`windows-control-room-browser-fixture`. Syntetyczne dane fixture nie były
wysłane do rzeczywistego backendu i nie stanowią kwalifikacji naukowej.

## Granica ukończenia i dalsza praca

Poprawka dotyczy właściciela panelu oraz uczciwego odczytu quantities anteny.
Podgląd ośmiu próbek **nie jest pełną mapą 3D ani mapą 2D**. Pełne malowanie
V/J na siatce przewodnika, H na właściwym carrierze i source-scoped H na
targetach pozostaje osobną bramką implementacji i runtime. Nie należy
malować bazy na dowolnej siatce primitive ani używać magnetycznego panelu jako
fallbacku. Ta poprawka nie certyfikuje solve → trwała publikacja → cold-load
→ reuse → LLG → FFT i nie zamyka pełnego planu modułu.

Zmiany pozostają częścią istniejącego PR #147 i istniejącego worktree.
Nie scalać całego PR ani usuwać aktywnego worktree na podstawie tej lokalnej
regresji UI: pozostałe bramki modułu oraz wymagane kontrole integracji nadal
obowiązują.
