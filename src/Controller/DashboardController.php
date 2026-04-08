<?php

declare(strict_types=1);

namespace App\Controller;

use App\Repository\AiLogRepository;
use App\Repository\GeneratedMaterialRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

class DashboardController extends AbstractController
{
    #[Route('/', name: 'app_dashboard')]
    public function index(
        GeneratedMaterialRepository $materialRepo,
        AiLogRepository $aiLogRepo,
    ): Response {
        $user = $this->getUser();
        $monthStart = new \DateTimeImmutable('first day of this month midnight');

        $recentMaterials = $materialRepo->findRecentByOwner($user, 5);

        $testsCount = $materialRepo->countByTypeAndMonth($user, 'test', $monthStart);
        $worksheetsCount = $materialRepo->countByTypeAndMonth($user, 'worksheet', $monthStart);
        $parentInfoCount = $materialRepo->countByTypeAndMonth($user, 'parent_info', $monthStart);

        $aiStats = $aiLogRepo->getMonthlyStats($user, $monthStart);

        return $this->render('dashboard/index.html.twig', [
            'recentMaterials' => $recentMaterials,
            'testsCount' => $testsCount,
            'worksheetsCount' => $worksheetsCount,
            'parentInfoCount' => $parentInfoCount,
            'aiStats' => $aiStats,
        ]);
    }
}
