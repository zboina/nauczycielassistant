<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\LessonPlan;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<LessonPlan>
 */
class LessonPlanRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, LessonPlan::class);
    }

    /** @return LessonPlan[] */
    public function findByOwner(User $owner, ?string $classLevel = null): array
    {
        $qb = $this->createQueryBuilder('lp')
            ->andWhere('lp.owner = :owner')
            ->setParameter('owner', $owner)
            ->orderBy('lp.createdAt', 'DESC');

        if ($classLevel) {
            $qb->andWhere('lp.classLevel = :cl')->setParameter('cl', $classLevel);
        }

        return $qb->getQuery()->getResult();
    }
}
