<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\MockExam;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<MockExam>
 */
class MockExamRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, MockExam::class);
    }

    /** @return MockExam[] */
    public function findByOwner(User $owner): array
    {
        return $this->createQueryBuilder('e')
            ->andWhere('e.owner = :owner')
            ->setParameter('owner', $owner)
            ->orderBy('e.createdAt', 'DESC')
            ->getQuery()
            ->getResult();
    }
}
