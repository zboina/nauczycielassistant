<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Essay;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Essay>
 */
class EssayRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Essay::class);
    }

    /** @return Essay[] */
    public function findByOwner(User $owner, ?string $classLevel = null): array
    {
        $qb = $this->createQueryBuilder('e')
            ->andWhere('e.owner = :owner')
            ->setParameter('owner', $owner)
            ->orderBy('e.createdAt', 'DESC');

        if ($classLevel) {
            $qb->andWhere('e.classLevel = :cl')->setParameter('cl', $classLevel);
        }

        return $qb->getQuery()->getResult();
    }

    public function findByAccessCode(string $code): ?Essay
    {
        return $this->findOneBy(['accessCode' => strtoupper($code)]);
    }
}
