<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\GeneratedMaterial;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<GeneratedMaterial>
 */
class GeneratedMaterialRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, GeneratedMaterial::class);
    }

    /** @return GeneratedMaterial[] */
    public function findRecentByOwner(User $owner, int $limit = 5): array
    {
        return $this->createQueryBuilder('m')
            ->andWhere('m.owner = :owner')
            ->setParameter('owner', $owner)
            ->orderBy('m.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** @return GeneratedMaterial[] */
    public function findByTypeAndOwner(User $owner, string $type, ?string $classLevel = null): array
    {
        $qb = $this->createQueryBuilder('m')
            ->andWhere('m.owner = :owner')
            ->andWhere('m.type = :type')
            ->setParameter('owner', $owner)
            ->setParameter('type', $type)
            ->orderBy('m.createdAt', 'DESC');

        if ($classLevel) {
            $qb->andWhere('m.classLevel = :cl')->setParameter('cl', $classLevel);
        }

        return $qb->getQuery()->getResult();
    }

    public function countByTypeAndMonth(User $owner, string $type, \DateTimeImmutable $monthStart): int
    {
        return (int) $this->createQueryBuilder('m')
            ->select('COUNT(m.id)')
            ->andWhere('m.owner = :owner')
            ->andWhere('m.type = :type')
            ->andWhere('m.createdAt >= :start')
            ->setParameter('owner', $owner)
            ->setParameter('type', $type)
            ->setParameter('start', $monthStart)
            ->getQuery()
            ->getSingleScalarResult();
    }
}
