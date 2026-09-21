# Plan symulacji: energia bimeronu z rDMI przy rozmiarze utrzymywanym przez frozen spins

Data: 2026-09-12. Aktualizacja metodologii: 2026-09-15. Zakres: plan eksperymentu numerycznego i jego weryfikacji.

**Zalecenie:** swobodną relaksację bimeronu wykonać raz jako kontrolę materiału i wyznaczenie jednego $R_\mathrm{eq}$; nie powtarzać jej dla każdego zadanego R. Właściwy profil budować z tekstur zainicjalizowanych dla kolejnych R i relaksowanych przy frozen spins. Najpierw wykonać pilotaż z trzema małymi zamrożonymi obszarami i cienką obwiednią, a dopiero po sprawdzeniu utrzymania R i wpływu kotwic uruchomić serię energii. Wynikiem będzie energia lokalnie zrelaksowanej tekstury przy określonym protokole ograniczenia. Samo ustawienie `radius=R` i zamrożenie kilku spinów nie gwarantuje utrzymania rozmiaru ani istnienia bimeronu dla dowolnego R.

**Decyzja wykonawcza (2026-09-15):** główna seria FDM GPU FP64 strict używa `llg_overdamped` dla etapów `constrained_relax` i `constrained_hold`. `projected_gradient_bb` pozostaje kandydatem do osobnego benchmarku, ale obecna single-grid CUDA ścieżka direct-minimizer nie ma jeszcze kwalifikowanego receipt dla FrozenSpins: pętla prób jest sterowana po stronie runnera, a końcowy dowód operatorów nie potwierdza pełnego device-resident wykonania. Nie wolno mieszać takich przebiegów z zaakceptowaną krzywą $E(R)$ ani obchodzić guardu przez ręczne oznaczenie receipt. Powrót do BB wymaga osobnego kontraktu natywnej projekcji referencji FrozenSpins, testu zachowania przy retraction/Armijo oraz nowego managed strict proof.

## 1. Odszukana baza i granice dotychczasowego wyniku

Odnalezione zadanie Codex: **„Dodaj typ DMI dla bimeronu”**, ID `01a05869-126d-7210-aa0b-22cc7747c932`. Kod reprodukcji jest w istniejącym worktree:

`C:/git/fullmag/worktrees/rotated-interfacial-dmi-bimeron`

W momencie pierwszego odczytu jego HEAD wynosił `a0c395b85131aaa16bcd98290542c3cb44f45907`. Zadanie rDMI nadal prowadzi tam prace. Ten plan nie zmienia tego worktree. Główny checkout odczytano na `f2b796c8a075b2e67a2d2f844d25fb5cd647ba93`, branch `fix/viewport-3d-audit-s18-s19-upload-20260910`, z istniejącymi cudzymi zmianami. Ścieżki względne w poniższej mapie bazowej odnoszą się do worktree rDMI, a nie automatycznie do głównego checkoutu.

| Istniejący plik i symbol | Wykorzystanie |
| --- | --- |
| `tests/standard_problems/bimeron/goebel_2019/common.py`: `TRACK_SIZE`, `MS`, `AEX`, `D_ROTATED`, `KU_X`, `CELL`, `BIMERON_RADIUS`, `BIMERON_WALL_WIDTH` | Jedno źródło parametrów materiału, geometrii i bazowego presetu |
| `tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py`: `study`, `film`, `relax`, `hold` | Główna baza nowego scenariusza; zachowanie konfiguracji fizycznej |
| `tests/standard_problems/bimeron/goebel_2019/scenario_fem.py`: `study` | Późniejsza kontrola FEM; nie zamiennik wykonanej reprodukcji FDM |
| `tests/standard_problems/bimeron/goebel_2019/verify.py`: `analyze_fdm_state`, `_solid_angle` | Dyskretny ładunek topologiczny i odległość rdzeni z uwzględnieniem PBC x |
| `packages/fullmag-py/src/fullmag/init/textures.py`: `texture.bimeron` | Ten sam publiczny preset, jego parametry i serializacja |
| `crates/fullmag-plan/src/magnetization_textures.rs`: `bimeron_theta`, `eval_bimeron` | Rzeczywiste znaczenie parametru `radius`, orientacja i profil magnetyzacji |

Historyczny raport jest dostępny jako:

[goebel_2019_final_verification_fresh.json](C:/Users/Mateusz/.codex/visualizations/2026/08/31/01a05869-126d-7210-aa0b-22cc7747c932/goebel_2019_final_verification_fresh.json).

| Stan historyczny | Odległość rdzeni | Energia całego układu | Q |
| --- | ---: | ---: | ---: |
| Początkowy | 20,5 nm | −7,7736 × 10⁻¹⁸ J | −0,999683 |
| Po etapie `relax`, 20 ps | 15,5 nm | −8,116927214 × 10⁻¹⁸ J | −0,999320 |
| Po dodatkowym `hold`, 100 ps | 5,5 nm | −8,146787143 × 10⁻¹⁸ J | −0,999989 |

Raport zapisuje CUDA FDM, FP64, RTX 4080 SUPER, `fallback_count=0` i historyczne 15/15 kontroli. **Przez kolejne 100 ps tekstura nadal znacząco się kurczyła.** Nazwa `relaxed` nie dowodzi więc osiągnięcia minimum. Końcowe `d/2 = 2,75 nm` jest historyczną połową odległości rdzeni, a nie jeszcze potwierdzonym promieniem równowagowym.

Potwierdzają to odczytane dane `scenario_fdm.zarr/stages/`: `stage_00_flat_relax/metadata.json` zapisuje `converged=false` i `reason=max_steps`, a końcowe `scalars.csv` podają `max_torque_T` około 0,4293 T po relaksacji i 1,598 × 10⁻⁴ T po hold. Obie wartości przekraczają ustawione `tolT=1e-6`. Bundle jest pod katalogiem scenariusza wskazanym powyżej.

Odczytany obecny `verify.py` i dokumentacja mają **19 kontroli**: względem starego raportu doszły `source_physics`, `hold_starts_from_relaxed_state`, `hold_provenance_matches_relax` oraz `relax_duration`. Stary wynik ma status `NOT VERIFIED` względem nowych wymagań. Do nowej serii trzeba przypisać ustalony commit, bibliotekę solvera i aktualne dowody. Odczyt starego raportu w tej turze nie był ponownym wykonaniem jego symulacji.

## 2. Układ fizyczny pozostaje ten sam

Podstawą jest model mikromagnetyczny Göbel et al., *Physical Review B* **99**, 060407(R), 2019, oraz tabela I suplementu. Suplement potwierdza okresowość toru w x i symulowaną długość 500 nm. Określamy materiał przez poniższy zestaw parametrów; nie dopisujemy niepotwierdzonego składu chemicznego.

| Parametr | Wartość bazowa | Znaczenie |
| --- | --- | --- |
| Rozmiar magnetyka | 500 × 40 × 0,5 nm³ | Pasek w płaszczyźnie xy |
| $M_s$ | $5{,}8\times10^5\;\mathrm{A\,m^{-1}}$ | Magnetyzacja nasycenia |
| $A$ | $15\times10^{-12}\;\mathrm{J\,m^{-1}}$ | Stała wymiany |
| $D$ | $3\times10^{-3}\;\mathrm{J\,m^{-2}}$ | Rotated interfacial DMI, zachowany znak |
| $K_x$ | $0{,}8\times10^6\;\mathrm{J\,m^{-3}}$ | Jednoosiowa anizotropia, oś łatwa +x |
| $\alpha$ | $0{,}3$ | Tłumienie Gilberta, bez jednostki |
| Temperatura, napędy | 0 K, brak prądu i pola zewnętrznego | Energia statyczna, bez SOT/STT i szumu |
| Siatka bazowa | 0,5 × 0,5 × 0,5 nm³; 1000 × 80 × 1 | Jedna komórka przez grubość, 80 000 komórek |
| Brzegi | PBC x; otwarte y i z | Zachować naturalne warunki exchange+rDMI |
| Demag | Włączony; PBC `truncated_images`, realizacja `auto` w bazowym skrypcie | Zapisać rozwiązaną realizację, liczbę obrazów i parametry kernela |
| Bazowy preset | `radius=10 nm`, `wall_width=3 nm`, `vorticity=-1`, `helicity_rad=0`, `background_sign=1`, `plane="xy"` | Baza odtworzenia historycznego przebiegu |
| Wykonanie | FDM, jawne GPU, `precision="double"`, `mode="strict"` | Główna seria; bez fallbacku CPU |
| Solver bazowy | `rk45`, `llg_overdamped` dla relaksacji, krok 2,5 fs | Start do kontroli zbieżności; 8000 kroków/20 ps nie jest kryterium równowagi |

Frozen region jest ograniczeniem wewnątrz istniejącego magnetyka. Nie tworzy dziury, dodatkowego materiału, nowego brzegu exchange/DMI ani osobnego obiektu fizycznego. $M_s$, $A$, $D$, $K_x$ i demag pozostają aktywne także w zamrożonych komórkach.

## 3. Co dokładnie znaczy R

W plikach wynikowych rozdzielić trzy różne wielkości:

1. **`radius_parameter_m` = $\rho$** — parametr presetu Python; wejście generatora.
2. **`R_target_m` i `R_area_m`** — zadany i zmierzony promień równoważny konturu $m_x=0$. Główna współrzędna profilu energii.
3. **`R_core_m = d_core/2`** — połowa odległości dwóch rdzeni o przeciwnych znakach $m_z$. Dodatkowa miara rozmiaru i kontrola deformacji.

Dla pojedynczej centralnej składowej obszaru $m_x<0$ definiujemy

$$
R_\mathrm{area}=\sqrt{A_-/\pi}.
$$

$A_-$ oznacza pole tej składowej w $\mathrm{m^2}$; oba promienie i odległość rdzeni podajemy w metrach, a na wykresach w nm. Obszar wyznaczamy z interpolowanego konturu na ustalonej siatce, z okresowym zszyciem x. Zachowujemy także prosty pomiar liczby komórek jako kontrolę błędu rasteryzacji. Do analizy należą centrum, półosie konturu i ich iloraz, orientacja pary oraz szerokość ściany. Nie zakładamy kołowego kształtu po relaksacji.

Kontur musi otaczać właściwy bimeron. Dodatkowe domeny, otwarcie konturu ku brzegowi lub zmiana znaku tła powodują zmianę klasyfikacji, a nie automatyczne doliczenie ich pola do R.

### Kalibracja presetu

Z odczytanego `bimeron_theta` wynika, dla $r=\sqrt{x^2+y^2}$ oraz szerokości $w$:

$$
\theta(r)=\arcsin\tanh\frac{r-\rho}{w}
          +\arcsin\tanh\frac{r+\rho}{w},\qquad m_x=-\cos\theta.
$$

Wszystkie cztery wielkości $r,\rho,w,R$ są długościami w $\mathrm m$; $\theta$ jest kątem w radianach. Analityczne rozwiązanie $m_x(R)=0$ daje

$$
R=w\,\operatorname{arsinh}\!\left(\cosh\frac{\rho}{w}\right),
\qquad
\rho=w\,\operatorname{arcosh}\!\left(\sinh\frac{R}{w}\right).
$$

Jest to wyprowadzenie dla istniejącego presetu, a nie dodatkowy model fizyczny. Wymaga $R>w\operatorname{arsinh}(1)$ przy dodatnim $\rho$. Dla $w=3$ nm dolny kres wynosi około 2,644 nm. Przykładowo `radius=2,75 nm` daje kontur około 3,501 nm; `radius=10 nm` daje około 10,008 nm. Te liczby sprawdzono obliczeniem samej funkcji, bez solvera.

Bazowy przebieg kontrolny zachowuje $\rho=10$ nm i $w=3$ nm. **Główna seria utrzymuje stałe $w_\mathrm{seed}=3$ nm**, a $\rho$ dobieramy powyższym odwróceniem do zadanego R. Dla R poniżej 2,644 nm potrzebna jest osobna seria, proponujemy stałe $w_\mathrm{seed}=1{,}5$ nm i zakres nakładający się na główną serię. Choć w jest parametrem inicjalizacji, jego fragment pozostaje zapisany w kotwicach: energia jest warunkowa względem protokołu i referencji, $E_P(R;w_\mathrm{seed},a)$. Nie zmieniamy w automatycznie z R i nie sklejamy obu serii bez wykazania zgodności. Po dyskretyzacji nadal mierzymy rzeczywisty kontur i pozycje rdzeni; wzór analityczny nie zastępuje pomiaru siatkowego.

## 4. Zamrażanie: trzy obszary i obwiednia

Wszystkie maski są statyczne w czasie danego przebiegu, obejmują pełną grubość magnetyka i są przecięte z jego aktywnymi komórkami. Wektor referencyjny każdej komórki pochodzi z całej zainicjalizowanej tekstury przed pierwszym krokiem relaksacji. Nie zastępujemy małego fragmentu tekstury jednolitym wektorem i nie przeliczamy członkostwa po ruchu konturu.

| Protokół | Zamrożony obszar | Co kontroluje i jak interpretować wynik |
| --- | --- | --- |
| P0 | Brak | Jednorazowa kontrola swobodnej relaksacji i pomiar naturalnego rozmiaru; nie jest punktem profilu powtarzanym dla każdego R |
| P2 | Dwa małe dyski przy przeciwnych rdzeniach $m_z$ | Odległość i orientację pary; sprawdza, czy trzecia kotwica jest potrzebna |
| **P3 — pierwszy kandydat** | Te same dwa dyski oraz mały dysk w centrum $m_x\approx-1$ | Dodatkowo utrzymuje centralną odwróconą magnetyzację; nadal pozwala na deformację ściany |
| **P-ring — kontrola** | Cienki pierścień wokół początkowego konturu $m_x=0$ | Mocniej utrzymuje obwiednię, ale narzuca większą część kształtu i profilu ściany |

Dla bazowej konwencji `vorticity=-1`, `helicity_rad=0`, `background_sign=1` rdzenie presetu leżą po przeciwnych stronach osi x: przy $x_c-R$ znak $m_z$ jest dodatni, przy $x_c+R$ ujemny. Trzeci dysk umieszczamy w centrum $(x_c,y_c)$. Ostateczne pozycje wybieramy po sprawdzeniu dyskretnej tekstury i jej transformacji; nie utożsamiamy indeksu komórki z dokładnym ekstremum ciągłym.

Początkowo: promień dysku $a=0{,}5$ nm i pełna szerokość pierścienia $b=0{,}5$ nm. Parametry są fizycznymi długościami i pozostają takie same w porównaniu siatek. Warunek pierścienia ma postać $|\sqrt{(x-x_c)^2+(y-y_c)^2}-R|\leq b/2$. Dysk to analogiczny warunek odległości od jego środka. Dla każdego przebiegu zapisujemy faktyczny zbiór zamrożonych komórek, jego hash, liczbę i pole. Sprawdzamy, czy dyski nie zachodzą na siebie i czy żaden selektor nie jest pusty.

Przy $h=0{,}5$ nm taka kotwica jest jeszcze bardzo słabo rozdzielona. Jej działanie kwalifikujemy na $h=0{,}25$ nm; większa liczba komórek kotwicy ma reprezentować ten sam rozmiar fizyczny. Nie wnioskujemy o małym zaburzeniu z samego małego procentu powierzchni całego toru — kotwice leżą w energetycznie istotnym rdzeniu.

**Decyzja po pilotażu:** wybieramy najmniejszy zestaw kotwic, który utrzymuje pożądany rozmiar i gałąź bimeronową bez dużej zależności od geometrii pinu. Jeżeli P3 utrzymuje tylko $d_\mathrm{core}$, raportujemy $E(R_\mathrm{core};P3)$, a nie wymuszone $E(R_\mathrm{area})$. Można następnie skalibrować rozstaw kotwic do zmierzonego $R_\mathrm{area}$ lub użyć P-ring. Tych protokołów nie łączymy w jeden nieopisany zbiór punktów.

Opcjonalnie P-ring może przygotować stan startowy dla późniejszej relaksacji z samymi P2/P3. Wtedy energię zapisujemy po ponownej zbieżności i pomiarze R przy docelowej masce; usunięcie pierścienia może zmienić rozmiar. Główna gałąź zachowuje pierwotną konwencję helicity/vorticity. Zmiana helicity lub orientacji pary przy pinach definiuje oddzielny protokół, a przesunięcie o pół komórki jest osobnym testem siatki.

## 5. Jaka energia jest mierzona

Przy masce zamrożonej $F$ i zapisanej referencji $\mathbf m^\mathrm{ref}$ ograniczenie brzmi

$$
|\mathbf m_i|=1,\qquad
\mathbf m_i=\mathbf m_i^\mathrm{ref}\;\;(i\in F).
$$

Pozostałe stopnie swobody relaksują się w pełnym polu całej próbki. Otrzymany stan $\mathbf m^*_{R,P,a}$ jest kandydatem na **lokalne minimum przy tym ograniczeniu**, nie gwarantowanym minimum globalnym. $P$ oznacza protokół kotwic, a $a$ ich rozmiar; dla pierścienia używamy $b$.

Energia fizyczna jest sumą wymiany, rDMI, anizotropii i demag, a Zeeman wynosi zero przy zerowym polu. W szczególności zachowujemy dotychczasowy człon

$$
E_\mathrm{rDMI}=\int_{\Omega_m}D\left(
m_z\partial_xm_x-m_x\partial_xm_z+
m_x\partial_ym_y-m_y\partial_ym_x\right)\,\mathrm dV.
$$

$\mathbf m$ jest bezwymiarową magnetyzacją jednostkową, $\Omega_m$ domeną magnetyczną, pochodna przestrzenna ma jednostkę $\mathrm{m^{-1}}$, a całka energii jednostkę $\mathrm J$. Szczegółowy kontrakt energii i pola pozostaje w `docs/physics/0406-rotated-interfacial-dmi.md`; ten plan nie ustanawia drugiego właściciela równań rDMI.

Podstawowy wykres:

$$
\Delta E_P(R_\mathrm{measured};a)
=E[\mathbf m^*_{R,P,a}]-E[\mathbf m_\mathrm{bg}].
$$

Nie definiujemy osobnego swobodnie zrelaksowanego punktu dla każdego R. Przy ustalonych parametrach materiałowych taka relaksacja ma wrócić do tego samego minimum $R_\mathrm{eq}$ albo do stanu jednorodnego i nie tworzy rodziny stanów o zadanym rozmiarze. Wartość bez frozen spins służy tylko do jednorazowej kontroli zbieżności i do interpretacji późniejszego release.

$\mathbf m_\mathrm{bg}$ to swobodnie zrelaksowany stan bez bimeronu, rozpoczęty od +x, z tą samą geometrią, siatką, PBC, demag i parametrami materiałowymi. Pozwalamy mu uzyskać skręcenie przy otwartych brzegach. Dla każdej siatki obliczamy własne $E_\mathrm{bg}$; nie odejmujemy energii z innej dyskretyzacji.

Zapisujemy jednocześnie `E_total`, wymianę, `E_rotated_dmi`, anizotropię, `E_demag`, ewentualne pozostałe aktywne składniki i ich sumę w J. Odczytane bazowe CSV używa ID `E_ex`, `E_ani`, `E_ext`, `E_demag`, `E_rotated_dmi`, `E_dmi` i `E_total`; dla tego scenariusza zwykłe `E_dmi` i `E_ext` są zerowe. Nie sumować rDMI drugi raz przez zbiorczy alias. Przed wykonaniem potwierdzić ID i semantykę agregatów w katalogu wybranego commita.

Frozen spins nie dodaje energii kary. **Nie odcinamy energii kotwic ani wiązań frozen–free** i nie odejmujemy arbitralnej „energii zamrażania”. Demag obejmuje całą magnetyzację. Zależność od kotwic mierzymy przez zmianę ich rozmiaru/protokołu, a nie przez usunięcie wybranych składników energii.

Wynik dotyczy tego konkretnego toru, warunków brzegowych i 0 K. Nie jest energią swobodną przy skończonej temperaturze. Maksimum takiej krzywej nie jest automatycznie barierą anihilacji — rzeczywista ścieżka może omijać tę rodzinę tekstur.

## 6. Kolejność obliczeń i kryteria przyjęcia

### Etap A — przywrócenie wiarygodnej bazy

1. Ustalić wersję rDMI po trwających poprawkach; zapisać commit, ewentualny diff, fingerprint bibliotek, wejściowy skrypt/IR oraz requested/resolved engine, device, precision, demag i PBC. Nie modyfikować aktywnego worktree innego zadania.
2. Powtórzyć istniejący scenariusz FDM bez kotwic i aktualny weryfikator Göbla. Historyczne 15/15 nie zastępuje nowych bramek.
3. Dorelaksować jeden reprezentatywny swobodny bimeron do spełnienia kryteriów poniżej; zapisać $R_\mathrm{eq,area}$, $R_\mathrm{eq,core}$, energię i kształt. Ten przebieg jest kontrolą materiału, nie osobnym baseline'em dla każdego R. Oddzielnie zrelaksować tło +x.
4. Na małym, niejednorodnym przypadku z tymi samymi interakcjami i PBC sprawdzić połączenie **rDMI + FrozenSpins + wybrany integrator i relaksacja**: niezmienność referencji, ruch free DOFs, energię i pole na styku frozen–free, aktywację i późniejsze zwolnienie. Osobne zielone testy rDMI i frozen spins nie wystarczają.

### Etap B — pilotaż maski

Wykonać P2, P3 i P-ring dla `R_target = 3, 5, 10 nm`: 9 przebiegów z aktywną maską. To weryfikuje okolice małego bimeronu, rozmiar pośredni i duży stan bliski starej inicjalizacji. P0 wykonać najwyżej raz w Etapie A; jeśli pilotaż zawiera P0 przy kilku R, traktować je wyłącznie jako diagnostyczne powtórzenia swobodnej ucieczki, a nie punkty profilu. Gdy $R_\mathrm{eq}$ leży daleko od 3 nm, dodać zamrożony punkt blisko niego.

Każdy przebieg: inicjalizacja → pomiar `m_initial` → utworzenie/capture maski → constrained relaxation → zapis stanu i pełnej energii → dalsza relaksacja/test trwania z tą samą referencją. Wybrane stany następnie przechodzą do osobnej gałęzi **release**: wyłączyć ograniczenie, zachować dokładnie końcową magnetyzację i relaksować dalej. Energia profilu jest zapisywana przed release.

### Etap C — seria R

Po przyjęciu protokołu wykonać główną serię zamrożonych tekstur dla `R_target = 2,75; 3; 4; 5; 6; 8; 10 nm` przy `w_seed = 3 nm`. Jednorazowy $R_\mathrm{eq}$ z Etapu A pozostaje punktem kontrolnym, a nie dodatkowym powtarzanym baseline'em. Osobna seria małych rozmiarów: `R_target = 2; 2,5; 2,75; 3; 4; 5 nm`, stałe `w_seed = 1,5 nm`, siatka co najmniej h = 0,25 nm. Wspólne punkty służą do kontroli wpływu referencji. Dodatkowe R = 12 nm traktować jako sprawdzenie wpływu brzegów w tym samym torze; zmiana szerokości toru byłaby odrębnym eksperymentem.

Jest to proponowany zakres, nie gwarancja istnienia wszystkich stanów. Rozmiary z nierozdzielonymi rdzeniami, nachodzącymi pinami lub kontaktem tekstury z brzegiem są odrzucane albo badane na lepszej siatce.

Wokół minimum i miejsc utraty stabilności zagęścić R, początkowo co 0,25–0,5 nm, zależnie od błędu pomiaru. Dla każdego punktu wykonać niezależną inicjalizację oraz kontynuację od sąsiednich rozmiarów w obu kierunkach. Kontynuacja wymaga zdefiniowania **tych samych docelowych wartości kotwic** co dla danego R; nie wolno przypadkowo zachować lub ponownie przechwycić referencji poprzedniego punktu. Jeśli potrzebny import stanu nie jest obsługiwany na wybranej trasie, najpierw go zweryfikować, a do tego czasu stosować niezależne starty.

Nie uśredniać różnych metastabilnych rozwiązań. Zapisywać oddzielne gałęzie, także wyżej energetyczne; najniższa odnaleziona energia nie dowodzi minimum globalnego.

### Etap D — odporność wyniku

| Kontrola | Minimalny zakres | Warunek interpretacji |
| --- | --- | --- |
| Siatka | h = 0,5 i 0,25 nm w xy, grubość pozostaje 0,5 nm; wybrane trudne punkty także 0,125 nm | Osobne $E_\mathrm{bg}$; te same fizyczne piny i porównanie przy zgodnym zmierzonym R |
| Wielkość pinu | Dla 3 reprezentatywnych R: a = 0,25; 0,5; 0,75 nm na rozdzielającej je siatce; dla pierścienia analogiczna kontrola b | Zmiany energii i R muszą być małe względem rozróżnianych cech krzywej; nie zakładać zbieżności do pinu punktowego |
| Faza siatki | Przesunięcia centrum o h/2 w x oraz symetrycznie ±h/2 w y | W y jest to również mała zmiana odległości od brzegu; oddzielić od czystego testu PBC x |
| Profil startowy | Wybrane R z 0,75 i 1,25 wartości $w_\mathrm{seed}$, z ponowną kalibracją $\rho$; tylko gdy spełniony jest warunek istnienia odwrotności | Warianty z inną zamrożoną referencją są testem protokołu, nie tylko zbieżności optymalizatora |
| Długość/krok relaksacji | Podwojenie czasu lub budżetu kroków; wybrane punkty z dt/2 | Brak systematycznego dryfu R i energii; sam limit czasu nie kończy kwalifikacji |
| Napęd ograniczenia | Krótki release dla R poniżej, blisko i powyżej minimum | Powrót, kurczenie, ekspansja lub anihilacja pokazują rolę ograniczenia; nie gwarantować wspólnego końca wszystkich startów |
| Demag/PBC | Ustalona, odtworzona realizacja i kontrola dokładności obrazów | Numeryczna dokładność demag nie może udawać efektu rozmiaru tekstury |

Przy h = 0,25 nm mamy 320 000 komórek, przy h = 0,125 nm 1 280 000. Całej serii nie zaczynać od najgęstszej siatki. Czas wykonania i storage oszacować z pilotażu; nie ma aktualnego pomiaru pozwalającego podać rzetelną liczbę godzin.

### Kryteria dla pojedynczego punktu

Wartości poniżej są proponowanymi progami roboczymi; przed serią trzeba je skalibrować na pilotażu i zapisać w wersjonowanym pliku progów.

- Wszystkie zamrożone wektory pozostają zgodne z zapisaną referencją; mierzyć maksymalny błąd i hash referencji. Docelowo błąd FP64 nie większy niż $10^{-12}$, chyba że kontrakt danej reprezentacji wymaga innej jawnie uzasadnionej tolerancji.
- Zbieżność mierzyć wyłącznie na free DOFs, np. $T_f=\max_{i\notin F}|\mathbf m_i\times\mathbf B_{\mathrm{eff},i}|$ w T. Dla roboczego pilota przyjmujemy wyważony próg `tolT=10^{-5}` T: jest zapisany w metadanych i zawsze pokazujemy zmierzone $T_f$. Próg $10^{-6}$ T pozostaje opcjonalnym testem czułości, a nie automatycznym warunkiem odrzucającym każdy punkt pilota. Norma już wyzerowanego RHS lub średnia rozcieńczona przez piny nie zastępuje tej kontroli.
- Wymagać także ustalenia energii i rozmiaru w końcowym oknie oraz po przedłużeniu relaksacji. Skalę błędu energii odnosić do energii nadmiarowej bimeronu i różnic między sąsiednimi punktami, a nie dużej energii całego toru. Zachować pomocniczy limit 0,1% względem $|E_\mathrm{total}|$ jako kontrolę oczywistej niestabilności, lecz główny roboczy limit okna ustalać względem $|\Delta E|$ z tła, z dolną skalą absolutną; pilotażowo przyjmujemy 5% $|\Delta E|$. Rozrzut P2/P3/pierścień raportować jako bias różnych ograniczeń i nie używać go jako bramki akceptacji jednej krzywej.
- Dla wykresu o zadanym $R_\mathrm{area}$: $|R_\mathrm{area}-R_\mathrm{target}|\leq\max(0{,}5h,0{,}02R_\mathrm{target})$. To tolerancja robocza, nie deklaracja dokładności subkomórkowej. Pokazać niepewność R i nie akceptować punktów, których niepewność uniemożliwia rozróżnienie sąsiadów serii.
- Ładunek topologiczny ma zachować znak i pozostać blisko −1, początkowo $|Q+1|<0{,}05$, z uwzględnieniem otwartych brzegów. Dwa przeciwne rdzenie, jedna zamknięta centralna obwiednia oraz kontrola całego pola są konieczne obok Q. Zachowany Q sam nie dowodzi właściwego bimeronu.
- Wektory pozostają skończone i jednostkowe, energie mają zgodne jednostki, a suma aktywnych składników zgadza się z `E_total` w tolerancji redukcji. Gwałtowne skoki po zmianie maski muszą zostać wyjaśnione przed interpolacją krzywej.
- Status solvera `max_steps` lub `max_physical_time` bez osiągnięcia tolerancji oznacza `not_converged`. Punkt może być użyteczny diagnostycznie, ale nie trafia do zaakceptowanej krzywej minimum.

## 7. Zmiany potrzebne przy późniejszej realizacji

To lista planowanych prac, nie opis już istniejącego nowego runnera.

| Wynik etapu | Proponowane pliki/interfejsy | Dowód zakończenia |
| --- | --- | --- |
| Parametry i maski | Nowy podkatalog `tests/standard_problems/bimeron/goebel_2019/frozen_size/`; współdzielenie stałych z istniejącego `common.py` | Zgodność fizyki z bazą; analityczna i dyskretna kalibracja R; niepuste selektory |
| Scenariusz | `frozen_size/scenario_fdm.py`; ten sam stage-first DSL, istniejący preset i `FrozenSpins` | Python → IR zachowuje rDMI, selektory, membership, reference i stage IDs |
| Kontrola/release | Oddzielne etapy lub niezależny run z zapisanym stanem | Przed release maska aktywna i niezmienna; po release brak ograniczenia i ciągłość m |
| Uruchamianie serii | `frozen_size/run_sweep.py` i właściwy repozytoryjny entrypoint | Każdy punkt ma manifest, stan końcowy, exit code i wznowienie bez nadpisania wyników |
| Metryki i weryfikacja | `frozen_size/analyze.py`, `verify.py`, `thresholds.v1.json`; wykorzystanie istniejącego `analyze_fdm_state` | Testy kalibracji, area/shape/PBC, złej maski, dryfu, zmiany topologii i nieosiągniętej zbieżności |
| Raport | `frozen_size/report.py` i raport Markdown | Krzywe po zmierzonym R, rozbicie energii, niepewności, branch IDs, porównania pinów i siatki |

Sprawdzone punkty zaczepienia API: `FrozenSpins` w `packages/fullmag-py/src/fullmag/model/constraints.py` ma typed `selector`, `reference="capture_current_at_activation"`, `membership`, `stage_ids`, `empty_selection="error"`; `to_ir()` zachowuje kontrakt ograniczenia. Przykład `examples/frozen_spins/fdm_cpu_browser_smoke.py` używa `film.add_region(...)` oraz `region.freeze_spins(...)`. Dokładny selektor dysków/pierścienia i sposób dołączenia go do stage-first buildera trzeba sprawdzić testem authoringu, nie wymyślać nowego API w samym planie.

Docelowe ograniczenie obejmuje tylko constrained relaxation i constrained hold. Capture musi następować po zmaterializowaniu właściwej tekstury dla bieżącego R. Referencja i membership nie zmieniają się pomiędzy tymi etapami ani przy zwykłym resume. Przejście do następnego R wymaga świadomego utworzenia nowej maski/referencji; przejście do release wyłącza ograniczenie bez resetu m.

Nota `docs/physics/0996-frozen-spins-constraint.md` pozostaje właścicielem semantyki frozen spins: zamrożone komórki generują pola i energię, RHS free DOFs uwzględnia ich wpływ, referencję trzeba zachować także w podkrokach/kandydatach, a zbieżność dotyczy free DOFs. Przy wykryciu braków w kompozycji najpierw uzupełnić odpowiedni regression check i kontrakt; nie używać `alpha=0`, `Ms=0` lub sztucznego pola jako zastępstwa.

| Realizacja | Rola w tym planie | Stan połączonego eksperymentu rDMI + piny + pomiar R |
| --- | --- | --- |
| FDM CPU | Referencja energii/pola i wybranych małych przypadków | `NOT VERIFIED` dla nowego eksperymentu |
| FDM GPU FP64 | Główna seria, zgodna z historycznym przebiegiem | Historyczny bimeron istnieje; nowe połączenie i aktualna kwalifikacja `NOT VERIFIED` |
| FEM CPU | Opcjonalna późniejsza kontrola dyskretyzacji | `NOT VERIFIED`; zgodne BC/demag i fizyczna maska, własne metryki na siatce FEM |
| FEM GPU | Opcjonalna późniejsza kontrola GPU FEM | `NOT VERIFIED`; wymagane osobne dowody urządzenia, operatorów i ograniczeń |

FEM nie jest warunkiem uzyskania pierwszego profilu na tej samej trasie FDM, ale profil FDM nie dowodzi parytetu czterech realizacji. Odczytany `scenario_fem.py` używa otwartych granic i `poisson_robin`, więc obecnie nie opisuje dokładnie tych samych warunków brzegowych co periodyczny FDM. Porównanie FEM wymaga zachowania cienkiej warstwy, spójnego membership DOFs i tego samego problemu magnetostatycznego; nie wolno porównać bez komentarza periodycznego FDM z otwartym FEM.

Przed implementacją zastosować aktualny cykl worktree/rejestru; przed buildem odczytać `justfile` i resolver storage. Istnieją recepty kwalifikacyjne frozen spins, ale nie są gotowym wrapperem tej serii. Nowe buildy/runy mają iść przez zweryfikowany preflight do skonfigurowanego storage z `.env`, w osobnym profilu i katalogu runów. FEM, jeśli będzie wykonywany, wymaga managed container-backed `just`. Brak zgodnego entrypointu to zadanie przygotowawcze, nie powód do relabelowania ad hoc uruchomienia jako kwalifikowanego.

## 8. Artefakty i docelowy wynik

Każdy punkt zapisuje: skrypt i IR; source/build identity; requested/resolved execution; konfigurację demag/PBC; R zadane i zmierzone; $\rho,w_\mathrm{seed}$; rodzaj i rozmiar pinów; rzeczywistą maskę i referencję; `m_initial`, stan po constrained relaxation i hold oraz ewentualny release; serie energii i free torque; Q, rdzenie, kontur i kształt; stop reason; niepewności i `branch_id`.

Tabela zbiorcza rozróżnia `accepted`, `not_converged`, `radius_mismatch`, `topology_changed`, `underresolved`, `pin_bias` i `execution_not_verified`. Nieakceptowanych punktów nie ukrywa i nie łączy gładką krzywą przez luki.

Raport zawiera:

1. $\Delta E$ względem **zmierzonego** $R_\mathrm{area}$ oraz pomocniczo $R_\mathrm{core}$; energie składników na tych samych osiach R.
2. Wykres `R_target` kontra `R_measured`, z niepewnościami i odchyleniem kształtu.
3. Porównania P2/P3/P-ring, wielkości pinów i siatek przy zgodnym R; oddzielne gałęzie kontynuacji.
4. Mapy magnetyzacji dla małego R, okolicy minimum i dużego R, z maską frozen spins i konturem $m_x=0$.
5. Wyniki release oraz jawny zakres R, w którym metoda utrzymuje rozdzielony bimeron.

Kryterium ukończenia późniejszego eksperymentu: co najmniej jedna odtwarzalna gałąź zaakceptowanych punktów po obu stronach minimum, z rozpoznaną niepewnością siatkową i wpływem pinów. Jeśli metoda nie utrzymuje R albo nie rozdziela energii od wpływu kotwic, wynikiem jest udokumentowany zakres ograniczenia metody. Można wtedy zaplanować bezpośrednie ograniczenie współrzędnej kolektywnej R, ale byłaby to kolejna funkcjonalność, wykraczająca poza użycie obecnych frozen spins.

## 9. Źródła i status tego planu

- Göbel et al., [Magnetic bimerons as skyrmion analogues in in-plane magnets](https://arxiv.org/abs/1811.07068), DOI [10.1103/PhysRevB.99.060407](https://doi.org/10.1103/PhysRevB.99.060407): bimeron, konwencja obrotu spinów i topologia.
- [Suplement publikacji, lokalny egzemplarz](C:/Users/Mateusz/Downloads/Supplemental_Material_Bimeron_Goebel_jk.pdf), sekcja III, tabela I, strona 4 pliku: parametry materiałowe, grubość/szerokość toru i PBC x. Tekst odczytano w tej turze.
- Kod i artefakt reprodukcji wskazane w sekcji 1: rzeczywista konfiguracja Fullmag oraz historyczne energie i tekstury. To źródło szczegółów wykonania, których sam artykuł nie określa dla Fullmag.
- `docs/physics/0996-frozen-spins-constraint.md`, sekcja problemu fizycznego; `packages/fullmag-py/src/fullmag/model/constraints.py`: `FrozenSpins`, `to_ir`; przykład `examples/frozen_spins/fdm_cpu_browser_smoke.py`: authoring regionu. Mapa aktualnego kontraktu frozen spins, nie dowód nowej kompozycji.

Plan sporządzono na podstawie odczytu bieżących źródeł, historii wskazanego zadania, raportu historycznego i publikacji. Przeprowadzono jedynie kontrolę analitycznej kalibracji presetu. **Nowe przebiegi, zbieżny profil energii, kompozycja rDMI + frozen spins i parytet CPU/GPU/FEM pozostają `NOT VERIFIED`.**
