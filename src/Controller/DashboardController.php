<?php

declare(strict_types=1);

namespace App\Controller;

use App\Repository\AiLogRepository;
use App\Repository\EssayRepository;
use App\Repository\GeneratedMaterialRepository;
use App\Repository\MockExamRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

class DashboardController extends AbstractController
{
    private const NAME_DAYS = [
        '01-01' => 'Mieczysława, Mieszka', '01-02' => 'Izydora, Bazylego', '01-03' => 'Genowefy, Danuty',
        '01-04' => 'Tytusa, Anieli', '01-05' => 'Hanny, Szymona', '01-06' => 'Kacpra, Melchiora',
        '01-14' => 'Feliksa, Hilarego', '01-21' => 'Agnieszki, Jarosława', '01-26' => 'Tymoteusza, Pauliny',
        '02-14' => 'Walentego, Cyryla', '02-24' => 'Macieja, Bogusza',
        '03-01' => 'Antoniny, Dawida', '03-08' => 'Beaty, Jana', '03-19' => 'Józefa, Bogdana',
        '03-21' => 'Benedykta, Lubomira', '03-25' => 'Marioli, Wieńczysława',
        '04-01' => 'Grażyny, Ireny', '04-04' => 'Izydora, Benedykta', '04-08' => 'Cezaryny, Dionizego',
        '04-16' => 'Bernadetty, Julii', '04-23' => 'Wojciecha, Jerzego',
        '05-01' => 'Józefa, Filipa', '05-03' => 'Marii, Antoniny', '05-12' => 'Pankracego, Dominika',
        '05-15' => 'Zofii, Izydora', '05-26' => 'Filipa, Pauliny',
        '06-01' => 'Jakuba, Justyna', '06-14' => 'Bazylego, Elizy', '06-23' => 'Wandy, Zenona',
        '06-24' => 'Jana, Danuty', '06-29' => 'Piotra, Pawła',
        '07-03' => 'Jacka, Tomasza', '07-15' => 'Henryka, Włodzimierza', '07-22' => 'Marii, Magdaleny',
        '07-25' => 'Jakuba, Krzysztofa', '07-26' => 'Anny, Mirosławy',
        '08-06' => 'Jakuba, Sławy', '08-15' => 'Marii, Napoleona', '08-24' => 'Bartłomieja, Jerzego',
        '09-01' => 'Bronisławy, Idziego', '09-08' => 'Marii, Adriana', '09-14' => 'Roksany, Bernarda',
        '09-29' => 'Michała, Rafała', '09-30' => 'Zofii, Wery',
        '10-01' => 'Danuty, Remigiusza', '10-04' => 'Franciszka, Edwina', '10-14' => 'Kaliksta, Liwii',
        '10-15' => 'Teresy, Jadwigi', '10-18' => 'Łukasza, Juliana',
        '11-01' => 'Wszystkich Świętych', '11-02' => 'Zaduszki', '11-11' => 'Marcina, Bartłomieja',
        '11-25' => 'Katarzyny, Erazma', '11-30' => 'Andrzeja, Maury',
        '12-04' => 'Barbary, Krystiana', '12-06' => 'Mikołaja, Jaremy', '12-13' => 'Łucji, Otylii',
        '12-24' => 'Adama, Ewy', '12-25' => 'Anastazji, Eugenii', '12-31' => 'Sylwestra, Melanii',
    ];

    private const HISTORICAL_EVENTS = [
        '01-01' => ['1945 — Powstaje Tymczasowy Rząd RP w Lublinie', '1999 — Wprowadzenie euro w UE'],
        '01-27' => ['1945 — Wyzwolenie obozu Auschwitz-Birkenau'],
        '02-14' => ['1989 — Rozpoczynają się obrady Okrągłego Stołu (6.02-5.04)'],
        '02-19' => ['1473 — Urodziny Mikołaja Kopernika'],
        '03-01' => ['Narodowy Dzień Pamięci Żołnierzy Wyklętych'],
        '03-08' => ['Międzynarodowy Dzień Kobiet'],
        '03-21' => ['Pierwszy dzień wiosny, Międzynarodowy Dzień Poezji'],
        '04-01' => ['Prima Aprilis — Międzynarodowy Dzień Żartów'],
        '04-02' => ['Międzynarodowy Dzień Książki dla Dzieci'],
        '04-08' => ['1525 — Hołd pruski', '1966 — Milenium Chrztu Polski'],
        '04-14' => ['Dzień Nauczyciela Bibliotekarza'],
        '04-23' => ['Światowy Dzień Książki i Praw Autorskich (UNESCO)'],
        '05-01' => ['Święto Pracy'],
        '05-02' => ['Dzień Flagi Rzeczypospolitej Polskiej'],
        '05-03' => ['1791 — Uchwalenie Konstytucji 3 Maja'],
        '05-26' => ['Dzień Matki'],
        '06-01' => ['Międzynarodowy Dzień Dziecka'],
        '06-04' => ['1989 — Pierwsze częściowo wolne wybory w PRL'],
        '06-23' => ['Dzień Ojca'],
        '08-01' => ['1944 — Wybuch Powstania Warszawskiego'],
        '08-15' => ['1920 — Bitwa Warszawska (Cud nad Wisłą)'],
        '09-01' => ['1939 — Rozpoczęcie II wojny światowej, Dzień Wiedzy'],
        '09-17' => ['1939 — Agresja ZSRR na Polskę'],
        '09-30' => ['Dzień Chłopaka'],
        '10-11' => ['Dzień Dziewcząt'],
        '10-14' => ['Dzień Edukacji Narodowej (Dzień Nauczyciela!)'],
        '10-16' => ['1978 — Karol Wojtyła wybrany na papieża Jana Pawła II'],
        '10-21' => ['Ogólnopolski Dzień Głośnego Czytania'],
        '11-01' => ['Wszystkich Świętych'],
        '11-11' => ['1918 — Odzyskanie niepodległości przez Polskę'],
        '11-29' => ['1830 — Wybuch Powstania Listopadowego'],
        '12-13' => ['1981 — Wprowadzenie stanu wojennego'],
        '12-25' => ['Pierwszy dzień Bożego Narodzenia'],
        '12-27' => ['1918 — Wybuch Powstania Wielkopolskiego'],
    ];

    #[Route('/', name: 'app_dashboard')]
    public function index(
        GeneratedMaterialRepository $materialRepo,
        AiLogRepository $aiLogRepo,
        EssayRepository $essayRepo,
        MockExamRepository $examRepo,
    ): Response {
        $user = $this->getUser();
        $now = new \DateTimeImmutable();
        $monthStart = new \DateTimeImmutable('first day of this month midnight');
        $todayKey = $now->format('m-d');

        // Stats
        $testsCount = $materialRepo->countByTypeAndMonth($user, 'test', $monthStart);
        $worksheetsCount = $materialRepo->countByTypeAndMonth($user, 'worksheet', $monthStart);
        $parentInfoCount = $materialRepo->countByTypeAndMonth($user, 'parent_info', $monthStart);
        $aiStats = $aiLogRepo->getMonthlyStats($user, $monthStart);

        // Recent materials
        $recentMaterials = $materialRepo->findRecentByOwner($user, 5);

        // Active essays (accepting submissions)
        $activeEssays = array_filter(
            $essayRepo->findByOwner($user),
            fn($e) => $e->isAccepting(),
        );

        // Pending reviews (essays with unreviewed submissions)
        $pendingReviews = 0;
        foreach ($essayRepo->findByOwner($user) as $essay) {
            foreach ($essay->getSubmissions() as $sub) {
                if ($sub->getStatus() !== 'approved') {
                    $pendingReviews++;
                }
            }
        }

        // Mock exams count
        $examsCount = count($examRepo->findByOwner($user));

        // Today info
        $dayNames = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
        $monthNames = ['', 'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

        $todayFormatted = $dayNames[(int) $now->format('w')] . ', '
            . (int) $now->format('d') . ' '
            . $monthNames[(int) $now->format('n')] . ' '
            . $now->format('Y');

        $nameDays = self::NAME_DAYS[$todayKey] ?? null;
        $historicalEvents = self::HISTORICAL_EVENTS[$todayKey] ?? [];

        // Upcoming essay deadlines
        $upcomingDeadlines = [];
        foreach ($essayRepo->findByOwner($user) as $essay) {
            if ($essay->getDeadline() && $essay->getDeadline() > $now && $essay->isActive()) {
                $upcomingDeadlines[] = $essay;
            }
        }
        usort($upcomingDeadlines, fn($a, $b) => $a->getDeadline() <=> $b->getDeadline());
        $upcomingDeadlines = array_slice($upcomingDeadlines, 0, 5);

        return $this->render('dashboard/index.html.twig', [
            'recentMaterials' => $recentMaterials,
            'testsCount' => $testsCount,
            'worksheetsCount' => $worksheetsCount,
            'parentInfoCount' => $parentInfoCount,
            'aiStats' => $aiStats,
            'todayFormatted' => $todayFormatted,
            'nameDays' => $nameDays,
            'historicalEvents' => $historicalEvents,
            'activeEssays' => $activeEssays,
            'pendingReviews' => $pendingReviews,
            'examsCount' => $examsCount,
            'upcomingDeadlines' => $upcomingDeadlines,
        ]);
    }
}
