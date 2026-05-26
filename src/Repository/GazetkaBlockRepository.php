<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\GazetkaBlock;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<GazetkaBlock>
 */
class GazetkaBlockRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, GazetkaBlock::class);
    }

    /**
     * @return GazetkaBlock[]
     */
    public function findByOwner(User $owner): array
    {
        return $this->findBy(['owner' => $owner], ['createdAt' => 'DESC']);
    }

    public function countByOwner(User $owner): int
    {
        return $this->count(['owner' => $owner]);
    }

    public function save(GazetkaBlock $block, bool $flush = true): void
    {
        $this->getEntityManager()->persist($block);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function remove(GazetkaBlock $block, bool $flush = true): void
    {
        $this->getEntityManager()->remove($block);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }
}
