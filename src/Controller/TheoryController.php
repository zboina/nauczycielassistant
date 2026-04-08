<?php

declare(strict_types=1);

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/theory')]
class TheoryController extends AbstractController
{
    private const CURRICULUM = [
        '4-6' => [
            'label' => 'Klasy IV–VI',
            'literary' => [
                'Omawia elementy świata przedstawionego i obrazy poetyckie',
                'Rozpoznaje fikcję; rozróżnia elementy realistyczne i fantastyczne',
                'Rozpoznaje gatunki: baśń, legenda, bajka, hymn, przypowieść, mit, opowiadanie, nowela, powieść',
                'Zna figury stylistyczne: epitety, porównania, przenośnie, uosobienia, ożywienie, wyrazy dźwiękonaśladowcze',
                'Rozpoznaje elementy rytmizujące: wers, rym, strofa, refren',
                'Opowiada o zdarzeniach fabuły, ustala kolejność',
                'Charakteryzuje podmiot liryczny, narratora i bohaterów',
                'Rozróżnia narrację pierwszoosobową i trzecioosobową',
                'Określa tematykę i problematykę utworu',
                'Wyraża własne rozumienie utworu i uzasadnia je',
            ],
            'language' => [
                'Rozpoznaje części mowy i określa ich funkcje',
                'Rozpoznaje formy przypadków, liczby, osoby, czasu, trybu i rodzaju',
                'Nazywa części zdania, rozpoznaje funkcje składniowe',
                'Rozpoznaje typy wypowiedzeń: zdanie pojedyncze, zdania złożone',
                'Posługuje się odmianą oficjalną i nieoficjalną',
                'Rozumie znaczenie dosłowne i przenośne',
                'Rozpoznaje związki frazeologiczne',
                'Rozróżnia synonimy, antonimy',
                'Stosuje poprawną ortografię i interpunkcję',
            ],
            'writing' => [
                'dialog', 'opowiadanie', 'opis', 'list', 'sprawozdanie', 'dedykacja',
                'zaproszenie', 'podziękowanie', 'ogłoszenie', 'życzenia',
                'charakterystyka', 'tekst argumentacyjny',
            ],
            'readings' => [
                ['author' => 'Jan Brzechwa', 'title' => 'Akademia Pana Kleksa', 'class' => '4'],
                ['author' => 'Janusz Christa', 'title' => 'Kajko i Kokosz. Szkoła latania (komiks)', 'class' => '4-5'],
                ['author' => 'C.S. Lewis', 'title' => 'Opowieści z Narnii. Lew, czarownica i stara szafa', 'class' => '5'],
                ['author' => 'Ferenc Molnár', 'title' => 'Chłopcy z Placu Broni', 'class' => '5'],
                ['author' => 'J.R.R. Tolkien', 'title' => 'Hobbit, czyli tam i z powrotem', 'class' => '5-6'],
                ['author' => 'Henryk Sienkiewicz', 'title' => 'W pustyni i w puszczy', 'class' => '4'],
                ['author' => '', 'title' => 'Mity greckie (wybór)', 'class' => '5-6'],
                ['author' => '', 'title' => 'Biblia — fragmenty (stworzenie świata, potop, przypowieści)', 'class' => '5-6'],
                ['author' => '', 'title' => 'Podania i legendy polskie', 'class' => '4'],
                ['author' => '', 'title' => 'Baśnie (Perrault, Grimm, Andersen)', 'class' => '4'],
                ['author' => 'Ignacy Krasicki', 'title' => 'Bajki (wybór)', 'class' => '5-6'],
                ['author' => 'Adam Mickiewicz', 'title' => 'Pan Tadeusz — fragmenty', 'class' => '6'],
                ['author' => '', 'title' => 'Wybrane wiersze (Tuwim, Brzechwa, Konopnicka, Staff)', 'class' => '4-6'],
            ],
        ],
        '7-8' => [
            'label' => 'Klasy VII–VIII',
            'literary' => [
                'Rozpoznaje rodzaje literackie: epika, liryka, dramat',
                'Rozróżnia gatunki: komedia, fraszka, pieśń, tren, ballada, epopeja, tragedia',
                'Wskazuje elementy dramatu: akt, scena, tekst główny, didaskalia, monolog, dialog',
                'Rozpoznaje neologizm, inwokację, symbol, alegorię',
                'Zna pojęcia komizmu i ironii',
                'Określa problematykę egzystencjalną',
                'Wykorzystuje konteksty: biograficzny, historyczny, kulturowy, społeczny',
                'Rozpoznaje gatunki dziennikarskie: reportaż, wywiad, artykuł',
            ],
            'language' => [
                'Rozpoznaje wyraz podstawowy i pochodny',
                'Rozpoznaje imiesłowy, stosuje równoważniki imiesłowowe',
                'Rozróżnia wypowiedzenia wielokrotnie złożone',
                'Rozumie pojęcie stylu: potoczny, urzędowy, artystyczny, naukowy, publicystyczny',
                'Rozpoznaje archaizmy, kolokwializmy',
                'Rozróżnia normę wzorcową i użytkową',
                'Rozumie pojęcie błędu językowego',
            ],
            'writing' => [
                'recenzja', 'rozprawka', 'podanie', 'CV', 'list motywacyjny',
                'przemówienie', 'wywiad', 'streszczenie', 'charakterystyka porównawcza',
            ],
            'readings' => [
                ['author' => 'Charles Dickens', 'title' => 'Opowieść wigilijna', 'class' => '7'],
                ['author' => 'Aleksander Fredro', 'title' => 'Zemsta', 'class' => '7'],
                ['author' => 'Aleksander Kamiński', 'title' => 'Kamienie na szaniec', 'class' => '7-8'],
                ['author' => 'Adam Mickiewicz', 'title' => 'Dziady część II', 'class' => '7'],
                ['author' => 'Antoine de Saint-Exupéry', 'title' => 'Mały Książę', 'class' => '7'],
                ['author' => 'Juliusz Słowacki', 'title' => 'Balladyna', 'class' => '8'],
                ['author' => 'Jan Kochanowski', 'title' => 'Fraszki, Pieśni, Treny VII i VIII', 'class' => '8'],
                ['author' => 'Adam Mickiewicz', 'title' => 'Świtezianka, Reduta Ordona', 'class' => '7-8'],
                ['author' => 'Adam Mickiewicz', 'title' => 'Pan Tadeusz (ks. I, II, IV, X, XI, XII)', 'class' => '8'],
                ['author' => 'Henryk Sienkiewicz', 'title' => 'Latarnik', 'class' => '8'],
                ['author' => 'Henryk Sienkiewicz', 'title' => 'Quo vadis — fragmenty', 'class' => '8'],
                ['author' => 'Stefan Żeromski', 'title' => 'Syzyfowe prace — fragmenty', 'class' => '8'],
                ['author' => 'Sławomir Mrożek', 'title' => 'Artysta', 'class' => '7-8'],
                ['author' => 'Zofia Nałkowska', 'title' => 'Medaliony — fragmenty', 'class' => '8'],
                ['author' => 'Hanna Krall', 'title' => 'Zdążyć przed Panem Bogiem', 'class' => '8'],
                ['author' => '', 'title' => 'Wiersze: Baczyński, Herbert, Leśmian, Miłosz, Różewicz, Szymborska', 'class' => '7-8'],
            ],
        ],
    ];

    private const STYLISTIC_DEVICES = [
        ['name' => 'Epitet', 'definition' => 'Określenie rzeczownika, które nadaje mu cechę', 'example' => '„ciemna noc", „złoty liść"', 'level' => '4-6'],
        ['name' => 'Porównanie', 'definition' => 'Zestawienie dwóch zjawisk za pomocą „jak", „niby", „niczym"', 'example' => '„silny jak lew", „biały niczym śnieg"', 'level' => '4-6'],
        ['name' => 'Metafora (przenośnia)', 'definition' => 'Ukryte porównanie, połączenie wyrazów w nowym, przenośnym znaczeniu', 'example' => '„morze łez", „złote serce"', 'level' => '4-6'],
        ['name' => 'Personifikacja (uosobienie)', 'definition' => 'Nadanie cech ludzkich zwierzętom, roślinom lub przedmiotom', 'example' => '„wiatr szeptał", „las milczał"', 'level' => '4-6'],
        ['name' => 'Ożywienie (animizacja)', 'definition' => 'Nadanie cech istot żywych przedmiotom nieożywionym', 'example' => '„drzewa tańczyły na wietrze"', 'level' => '4-6'],
        ['name' => 'Onomatopeja', 'definition' => 'Wyraz naśladujący dźwięki', 'example' => '„szum", „trzask", „kukułka"', 'level' => '4-6'],
        ['name' => 'Symbol', 'definition' => 'Motyw, który oprócz znaczenia dosłownego ma głębszy, ukryty sens', 'example' => 'serce = miłość, gołąb = pokój', 'level' => '7-8'],
        ['name' => 'Alegoria', 'definition' => 'Rozbudowany symbol — postacie i wydarzenia mają drugie, ukryte znaczenie', 'example' => 'bajki Krasickiego, np. lew = władca', 'level' => '7-8'],
        ['name' => 'Ironia', 'definition' => 'Mówienie czegoś innego niż się myśli — pozorne chwalenie, faktyczne krytykowanie', 'example' => '„Pięknie to wymyśliłeś!" (= głupio)', 'level' => '7-8'],
        ['name' => 'Anafora', 'definition' => 'Powtórzenie tego samego wyrazu na początku kolejnych wersów/zdań', 'example' => '„Tam skowronek… Tam zając… Tam bociany…"', 'level' => '7-8'],
        ['name' => 'Pytanie retoryczne', 'definition' => 'Pytanie, na które nie oczekuje się odpowiedzi — służy wyrażeniu emocji', 'example' => '„Któż by się tego nie bał?"', 'level' => '7-8'],
        ['name' => 'Apostrofa', 'definition' => 'Bezpośredni zwrot do adresata (osoby, bóstwa, natury)', 'example' => '„Litwo! Ojczyzno moja!"', 'level' => '7-8'],
        ['name' => 'Inwokacja', 'definition' => 'Rozbudowana apostrofa na początku utworu epickiego', 'example' => 'Inwokacja z „Pana Tadeusza"', 'level' => '7-8'],
        ['name' => 'Hiperbola', 'definition' => 'Wyolbrzymienie, przesadne przedstawienie zjawiska', 'example' => '„płakał morze łez", „czekam wieczność"', 'level' => '7-8'],
        ['name' => 'Eufemizm', 'definition' => 'Łagodniejsze określenie zamiast dosadnego', 'example' => '„odszedł" (= umarł), „niezbyt urodziwy"', 'level' => '7-8'],
        ['name' => 'Gradacja', 'definition' => 'Stopniowanie natężenia — od najmniejszego do największego lub odwrotnie', 'example' => '„szeptał, mówił, krzyczał, wrzeszczał"', 'level' => '7-8'],
    ];

    private const GENRES = [
        'epic' => [
            'label' => 'Epika',
            'description' => 'Opowiadanie o świecie — narrator relacjonuje wydarzenia',
            'genres' => [
                ['name' => 'Baśń', 'features' => 'Magiczne elementy, dobro kontra zło, morał, szczęśliwe zakończenie', 'level' => '4'],
                ['name' => 'Legenda', 'features' => 'Nawiązanie do historii/miejsc, elementy fantastyczne, wyjaśnia pochodzenie nazw', 'level' => '4'],
                ['name' => 'Mit', 'features' => 'Opowieść o bogach i herosach, wyjaśnia zjawiska przyrody, część systemu wierzeń', 'level' => '5'],
                ['name' => 'Bajka', 'features' => 'Krótki utwór (wierszem lub prozą), morał, postacie-zwierzęta = ludzie', 'level' => '5-6'],
                ['name' => 'Opowiadanie', 'features' => 'Krótki utwór prozą, jedna linia fabularna, nieliczni bohaterowie', 'level' => '4-6'],
                ['name' => 'Nowela', 'features' => 'Zwarta proza, jeden wątek, punkt kulminacyjny, element znaczący (motyw przewodni)', 'level' => '6'],
                ['name' => 'Powieść', 'features' => 'Rozbudowana proza, wiele wątków i bohaterów, szerokie tło społeczne', 'level' => '4-6'],
                ['name' => 'Przypowieść (parabola)', 'features' => 'Opowieść alegoryczna z przesłaniem moralnym, postacie symboliczne', 'level' => '6'],
                ['name' => 'Epopeja', 'features' => 'Wielki utwór epicki, losy narodu, szerokie tło historyczne, inwokacja', 'level' => '7-8'],
                ['name' => 'Reportaż', 'features' => 'Gatunek dziennikarski, opis prawdziwych wydarzeń, elementy literackie', 'level' => '7-8'],
            ],
        ],
        'lyric' => [
            'label' => 'Liryka',
            'description' => 'Wyrażanie uczuć i przeżyć podmiotu lirycznego',
            'genres' => [
                ['name' => 'Wiersz', 'features' => 'Podstawowa forma liryczna, wersyfikacja, rytm, rymy (ale też wiersz wolny)', 'level' => '4-6'],
                ['name' => 'Pieśń', 'features' => 'Utwór melodyjny, regularny rytm, refleksja filozoficzna', 'level' => '7-8'],
                ['name' => 'Fraszka', 'features' => 'Krótki wiersz, żartobliwy lub refleksyjny, puenta', 'level' => '7-8'],
                ['name' => 'Tren', 'features' => 'Utwór żałobny, wyrażający ból po stracie bliskiej osoby', 'level' => '8'],
                ['name' => 'Ballada', 'features' => 'Łączy epikę, lirykę i dramat; fabuła, nastrój tajemnicy, elementy ludowe', 'level' => '7-8'],
                ['name' => 'Hymn', 'features' => 'Uroczysty, podniosły utwór, wyraża najwyższe wartości (ojczyzna, bóg)', 'level' => '5-6'],
            ],
        ],
        'drama' => [
            'label' => 'Dramat',
            'description' => 'Utwór przeznaczony do wystawienia na scenie — dialog postaci',
            'genres' => [
                ['name' => 'Komedia', 'features' => 'Utwór sceniczny wywołujący śmiech; komizm sytuacyjny, słowny, postaci', 'level' => '7'],
                ['name' => 'Tragedia', 'features' => 'Utwór o losie bohatera, który ponosi klęskę mimo szlachetnych zamiarów', 'level' => '8'],
            ],
            'elements' => [
                'Akt — największa jednostka dramatu',
                'Scena — zmiana następuje, gdy ktoś wchodzi/wychodzi',
                'Tekst główny — dialogi i monologi postaci',
                'Didaskalia — wskazówki sceniczne autora (zapisane kursywą)',
                'Monolog — wypowiedź jednej postaci',
                'Dialog — rozmowa między postaciami',
            ],
        ],
    ];

    private const WRITING_FORMS = [
        [
            'name' => 'Opowiadanie',
            'level' => '4-6',
            'structure' => ['Wstęp — czas, miejsce, bohater', 'Rozwinięcie — wydarzenia, punkt kulminacyjny', 'Zakończenie — rozwiązanie, refleksja'],
            'tips' => ['Używaj dialogów', 'Opisuj uczucia bohaterów', 'Stosuj różnorodne przymiotniki', 'Zachowaj chronologię wydarzeń'],
        ],
        [
            'name' => 'Opis postaci (charakterystyka)',
            'level' => '4-6',
            'structure' => ['Przedstawienie postaci (imię, wiek, rola)', 'Wygląd zewnętrzny', 'Cechy charakteru z przykładami/cytatami', 'Ocena własna postaci'],
            'tips' => ['Podawaj dowody na cechy (cytaty, sytuacje)', 'Oddzielaj wygląd od charakteru', 'Używaj synonimów: „dobry, życzliwy, altruistyczny"'],
        ],
        [
            'name' => 'List',
            'level' => '4-6',
            'structure' => ['Miejscowość i data (prawy górny róg)', 'Nagłówek (np. „Drogi Przyjacielu,")', 'Treść listu', 'Formuła pożegnalna', 'Podpis'],
            'tips' => ['List prywatny — język potoczny, osobisty ton', 'List oficjalny — zwroty grzecznościowe, „Szanowny Panie"'],
        ],
        [
            'name' => 'Sprawozdanie',
            'level' => '5-6',
            'structure' => ['Co, kiedy, gdzie się odbyło', 'Przebieg wydarzenia (chronologicznie)', 'Wrażenia i ocena'],
            'tips' => ['Pisz w czasie przeszłym', 'Podawaj konkretne fakty', 'Możesz dodać własną opinię na końcu'],
        ],
        [
            'name' => 'Rozprawka',
            'level' => '7-8',
            'structure' => ['Wstęp — teza lub hipoteza', 'Argument 1 + przykład', 'Argument 2 + przykład', 'Argument 3 + przykład', 'Zakończenie — potwierdzenie tezy, wnioski'],
            'tips' => ['Teza = twierdzenie, którego bronisz', 'Hipoteza = pytanie, na które szukasz odpowiedzi', 'Każdy argument popieraj przykładem z lektury', 'Używaj spójników: „po pierwsze", „ponadto", „podsumowując"'],
        ],
        [
            'name' => 'Recenzja',
            'level' => '7-8',
            'structure' => ['Tytuł recenzji', 'Informacje o dziele (tytuł, autor, gatunek)', 'Krótkie streszczenie (bez spoilerów!)', 'Ocena + argumenty', 'Polecenie lub odradzenie'],
            'tips' => ['Wyrażaj opinię: „uważam", „moim zdaniem"', 'Podawaj konkretne przykłady z dzieła', 'Bądź sprawiedliwy — wskaż plusy i minusy'],
        ],
        [
            'name' => 'Charakterystyka porównawcza',
            'level' => '7-8',
            'structure' => ['Przedstawienie obu postaci', 'Cechy wspólne', 'Różnice', 'Wnioski — co wynika z porównania'],
            'tips' => ['Porównuj te same kategorie (np. odwaga, lojalność)', 'Używaj zwrotów: „w przeciwieństwie do…", „podobnie jak…"', 'Wyciągaj wnioski — nie tylko wyliczaj cechy'],
        ],
        [
            'name' => 'Streszczenie',
            'level' => '7-8',
            'structure' => ['Krótkie przedstawienie tematu tekstu', 'Główne tezy/wydarzenia w kolejności', 'Zakończenie — konkluzja autora'],
            'tips' => ['Pisz własnymi słowami (parafrazuj)', 'Zachowaj proporcje treści', 'Nie dodawaj własnych opinii', 'Pisz w 3. osobie i czasie teraźniejszym'],
        ],
    ];

    private const SPELLING_RULES = [
        [
            'title' => 'Pisownia ó / u',
            'level' => '4',
            'rules' => [
                'ó piszemy, gdy wymienia się na o, a, e — np. „wóz → wozy", „ból → boleć"',
                'ó piszemy w zakończeniach -ów, -ówka, -ówna — np. „Kraków", „filmówka"',
                'u piszemy, gdy nie wymienia się na inne głoski — np. „duch", „but"',
                'u piszemy na początku wyrazów — np. „uczeń", „uroda"',
            ],
        ],
        [
            'title' => 'Pisownia rz / ż',
            'level' => '4',
            'rules' => [
                'rz piszemy po spółgłoskach: b, d, g, j, k, p, t, w, ch — np. „drzewo", „brzeg"',
                'rz piszemy, gdy wymienia się na r — np. „morze → morski"',
                'ż piszemy, gdy wymienia się na g, dz, h, ź, z, s — np. „drużyna → druh"',
                'WYJĄTKI: „kształt", „pszczół", „chrząszcz" — trzeba zapamiętać!',
            ],
        ],
        [
            'title' => 'Pisownia ch / h',
            'level' => '5',
            'rules' => [
                'ch piszemy w większości wyrazów rdzennie polskich — np. „chłopiec", „mucha"',
                'h piszemy w wyrazach obcego pochodzenia — np. „historia", „humor", „hotel"',
                'h piszemy, gdy wymienia się na g lub ż — np. „wahać → waga"',
            ],
        ],
        [
            'title' => 'Pisownia nie z różnymi częściami mowy',
            'level' => '5-7',
            'rules' => [
                'Łącznie z rzeczownikami, przymiotnikami, przysłówkami — np. „nieładny", „niedawno"',
                'Rozdzielnie z czasownikami — np. „nie lubię", „nie wiem"',
                'Rozdzielnie z imiesłowami przymiotnikowymi odmiennymi — np. „nie kochany (przez nikogo)"',
                'WYJĄTKI: „nienawidzić", „niepokoić", „niedowidzieć" — zawsze łącznie!',
            ],
        ],
        [
            'title' => 'Wielka i mała litera',
            'level' => '4-5',
            'rules' => [
                'Wielka: imiona, nazwiska, nazwy geograficzne, święta, tytuły utworów',
                'Wielka: nazwy narodowości i mieszkańców — np. „Polak", „Krakowianin"',
                'Mała: pory roku, dni tygodnia, miesiące (w tekście ciągłym)',
                'Mała: nazwy języków — np. „język polski", „mówi po angielsku"',
            ],
        ],
        [
            'title' => 'Interpunkcja — przecinek',
            'level' => '5-6',
            'rules' => [
                'Przed spójnikami: ale, lecz, jednak, więc, a (przeciwstawne)',
                'Przed „który", „że", „aby", „gdy", „ponieważ", „chociaż"',
                'Przy wyliczeniach — np. „kupił jabłka, gruszki, banany"',
                'NIE stawiamy przed: i, oraz, albo, lub, bądź, ani, czy (łączne)',
            ],
        ],
    ];

    private const PARTS_OF_SPEECH = [
        ['name' => 'Rzeczownik', 'question' => 'kto? co?', 'features' => 'odmienia się przez przypadki i liczby, ma rodzaj', 'examples' => 'dom, pies, Warszawa, radość', 'level' => '4'],
        ['name' => 'Przymiotnik', 'question' => 'jaki? jaka? jakie?', 'features' => 'odmienia się przez przypadki, liczby, rodzaje; stopniuje się', 'examples' => 'duży, piękna, mądre', 'level' => '4'],
        ['name' => 'Czasownik', 'question' => 'co robi? co się dzieje?', 'features' => 'odmienia się przez osoby, czasy, tryby, rodzaje; koniugacja', 'examples' => 'biegać, myśleć, jest', 'level' => '4'],
        ['name' => 'Przysłówek', 'question' => 'jak? gdzie? kiedy?', 'features' => 'nieodmienny, określa czasownik; stopniuje się', 'examples' => 'szybko, tutaj, wczoraj', 'level' => '5'],
        ['name' => 'Liczebnik', 'question' => 'ile? który z kolei?', 'features' => 'główny (pięć) i porządkowy (piąty); odmienia się', 'examples' => 'trzy, piąty, dwadzieścia', 'level' => '5'],
        ['name' => 'Zaimek', 'question' => 'zastępuje inne części mowy', 'features' => 'osobowy, wskazujący, pytający, zwrotny, dzierżawczy', 'examples' => 'ja, ten, kto, się, mój', 'level' => '5-6'],
        ['name' => 'Przyimek', 'question' => 'łączy się z rzeczownikiem', 'features' => 'nieodmienny, tworzy wyrażenia przyimkowe', 'examples' => 'w, na, do, pod, przez', 'level' => '5-6'],
        ['name' => 'Spójnik', 'question' => 'łączy zdania lub wyrazy', 'features' => 'współrzędne (i, ale) i podrzędne (że, aby, gdy)', 'examples' => 'i, ale, lub, że, gdy', 'level' => '5-6'],
        ['name' => 'Partykuła', 'question' => 'nadaje odcień znaczeniowy', 'features' => 'nieodmienna, wzmacnia, zaprzecza, wyraża wątpliwość', 'examples' => 'nie, czy, niech, -by', 'level' => '7'],
        ['name' => 'Wykrzyknik', 'question' => 'wyraża emocje', 'features' => 'nieodmienny, stosowany w wykrzyknieniach', 'examples' => 'ach!, hurra!, ojej!', 'level' => '5'],
    ];

    #[Route('', name: 'app_theory_index')]
    public function index(): Response
    {
        return $this->render('theory/index.html.twig');
    }

    #[Route('/curriculum/{group}', name: 'app_theory_curriculum', defaults: ['group' => '4-6'])]
    public function curriculum(string $group): Response
    {
        if (!isset(self::CURRICULUM[$group])) {
            $group = '4-6';
        }

        return $this->render('theory/curriculum.html.twig', [
            'group' => $group,
            'data' => self::CURRICULUM[$group],
            'otherGroup' => $group === '4-6' ? '7-8' : '4-6',
            'otherLabel' => $group === '4-6' ? 'Klasy VII–VIII' : 'Klasy IV–VI',
        ]);
    }

    #[Route('/genres', name: 'app_theory_genres')]
    public function genres(): Response
    {
        return $this->render('theory/genres.html.twig', [
            'genres' => self::GENRES,
        ]);
    }

    #[Route('/stylistics', name: 'app_theory_stylistics')]
    public function stylistics(): Response
    {
        return $this->render('theory/stylistics.html.twig', [
            'devices' => self::STYLISTIC_DEVICES,
        ]);
    }

    #[Route('/writing-forms', name: 'app_theory_writing_forms')]
    public function writingForms(): Response
    {
        return $this->render('theory/writing_forms.html.twig', [
            'forms' => self::WRITING_FORMS,
        ]);
    }

    #[Route('/grammar', name: 'app_theory_grammar')]
    public function grammar(): Response
    {
        return $this->render('theory/grammar.html.twig', [
            'partsOfSpeech' => self::PARTS_OF_SPEECH,
            'spellingRules' => self::SPELLING_RULES,
        ]);
    }
}
