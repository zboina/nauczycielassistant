<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\EssaySubmission;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<EssaySubmission>
 */
class EssaySubmissionRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, EssaySubmission::class);
    }
}
