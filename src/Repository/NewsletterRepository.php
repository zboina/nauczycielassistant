<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Newsletter;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Newsletter>
 */
class NewsletterRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Newsletter::class);
    }

    /**
     * @return Newsletter[]
     */
    public function findByOwner(User $owner): array
    {
        return $this->findBy(['owner' => $owner], ['updatedAt' => 'DESC', 'createdAt' => 'DESC']);
    }

    /**
     * @return Newsletter[]
     */
    public function findRecentByOwner(User $owner, int $limit = 5): array
    {
        return $this->findBy(['owner' => $owner], ['updatedAt' => 'DESC', 'createdAt' => 'DESC'], $limit);
    }

    public function save(Newsletter $newsletter, bool $flush = true): void
    {
        $this->getEntityManager()->persist($newsletter);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function remove(Newsletter $newsletter, bool $flush = true): void
    {
        $this->getEntityManager()->remove($newsletter);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }
}
