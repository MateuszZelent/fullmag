# Inspector modu — semantyka residuali

W panelu Eigen Mode pojedynczy Residual łączył residual_norm metadanych modu
z wartością wykresu. Kanoniczny residual_norm jest aliasem bezwzględnego L2;
wartość wykresu może być aliasem różnego typu. Brak jawnego relative L2 i scope
utrudniał ocenę jakości rozwiązania względem tolerancji.

Dodano wspólny adapter eigenResidualSummary i osobne wiersze: bezwzględny L2,
względny L2, zakres residualu oraz wartość widma o nieokreślonym typie.
Adapter wymaga skończonych nieujemnych liczb. Nie przelicza residuali między
normalizacjami, nie przyznaje kwalifikacji i nie wyprowadza scope z magnitudy.
Brak lub nieznany scope pozostaje Not available. Dane nadal pochodzą z
istniejących resource hooks; brak nowych endpointów i zmian OpenAPI.

Dowody: siedem testów Node PASS; strict TypeScript nowego adaptera PASS;
syntax check dokładnego staged panelu PASS; API i architecture hygiene PASS
po uruchomieniu z katalogu aplikacji. React Doctor 0.9.12 staged/files exit0:
dwie wcześniejsze uwagi poza zmienionymi liniami (eksport identity helpera,
lista akcji). Początkowy architecture check wykonany ze złego cwd był
nieważny i został zastąpiony właściwą kontrolą.

NOT VERIFIED: pełny typecheck aplikacji i browser/render; w worktree brak
kompletnych zależności aplikacji. Użyto wyłącznie już zainstalowanego TypeScript
oraz React Doctor z głównego checkoutu, bez kopiowania lub instalacji pakietów.

## Korekta diagnozy po kontroli rzeczywistych artefaktów

Wspólny modal_manifest nie publikuje block_residuals, ale rzeczywista ścieżka
FEM eigen_output uzupełnia te pola podczas tworzenia v2 bundle. Plik modu i
spectrum.v3 archiwalnego joba #173 zawierają zgodny pełny certyfikat. API
FrequencyDomainModeArtifactPayload zachowuje dodatkowe pola przez serde flatten.
Poprzednie przypisanie luki całemu writerowi/API było zbyt szerokie.

Rzeczywisty błąd: useFrequencyDomainEigenModeResource zwraca zasób z payload,
a useEigenModeSummary czytał record(eigenMode.data), czyli zewnętrzną kopertę.
Naprawiono odczyt payloadu wraz z kontrolą ready i tożsamości sample_index /
raw_mode_index. Inna selekcja, brak payloadu lub nieprawidłowe indeksy daje null.
Nie dodano drugiego writera ani nowego endpointu.

Dziewięć testów adaptera PASS, obejmujących kopertę i poprzednią selekcję.
Replay rzeczywistego pliku modu #173: relative L2 2.1580189814434916e-10,
scope Full projected weak form and periodic seams; absolute L2 niedostępny,
nie został odtworzony z relative. SHA pliku:
3c7cbb8c558a5300a8a98a3dec05c2c4539d70708588959123ba771a5cb961bd.
To artifact_adapter_replay_NOT_live_API, nie dowód nowej symulacji ani browser.

Następne bramki: live API/browser na bieżącym obrazie, zachowanie certyfikatu
w pozostałych realizacjach i pełne S07/S08. Brak danych na innych ścieżkach
pozostaje jawnie niedostępny, bez wygenerowanej certyfikacji.
