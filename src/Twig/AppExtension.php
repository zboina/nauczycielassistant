<?php

declare(strict_types=1);

namespace App\Twig;

use App\Repository\UserRepository;
use Doctrine\ORM\EntityManagerInterface;
use Twig\Extension\AbstractExtension;
use Twig\Extension\GlobalsInterface;
use Twig\TwigFunction;

class AppExtension extends AbstractExtension implements GlobalsInterface
{
    public function __construct(
        private readonly UserRepository $userRepo,
        private readonly EntityManagerInterface $em,
    ) {}

    public function getGlobals(): array
    {
        return [
            '_users' => $this->userRepo->findBy(['isActive' => true], ['fullName' => 'ASC']),
        ];
    }

    public function getFunctions(): array
    {
        return [
            new TwigFunction('shared_user_ids', [$this, 'getSharedUserIds']),
        ];
    }

    /**
     * Returns array of user IDs who have a clone of given title (contains "[udostępniony od")
     * for a given entity class and original title.
     */
    public function getSharedUserIds(string $entityClass, string $originalTitle): array
    {
        $searchTitle = $originalTitle . ' [udostępniony od %';

        $conn = $this->em->getConnection();
        $table = match ($entityClass) {
            'material' => 'generated_material',
            'lesson_plan' => 'lesson_plan',
            'mock_exam' => 'mock_exam',
            default => null,
        };

        if (!$table) return [];

        $ownerCol = 'owner_id';
        $rows = $conn->fetchAllAssociative(
            "SELECT DISTINCT {$ownerCol} FROM {$table} WHERE title LIKE ?",
            [$searchTitle]
        );

        return array_column($rows, $ownerCol);
    }
}
