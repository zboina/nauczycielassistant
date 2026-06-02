<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\GazetkaPageTemplate;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<GazetkaPageTemplate>
 */
class GazetkaPageTemplateRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, GazetkaPageTemplate::class);
    }

    /**
     * @return GazetkaPageTemplate[]
     */
    public function findByOwner(User $owner): array
    {
        return $this->findBy(['owner' => $owner], ['createdAt' => 'DESC']);
    }

    public function countByOwner(User $owner): int
    {
        return $this->count(['owner' => $owner]);
    }

    public function save(GazetkaPageTemplate $tpl, bool $flush = true): void
    {
        $this->getEntityManager()->persist($tpl);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function remove(GazetkaPageTemplate $tpl, bool $flush = true): void
    {
        $this->getEntityManager()->remove($tpl);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }
}
