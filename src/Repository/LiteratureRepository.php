<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Literature;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Literature>
 */
class LiteratureRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Literature::class);
    }

    /** @return Literature[] */
    public function findByFilters(?string $classLevel = null, ?string $search = null): array
    {
        $qb = $this->createQueryBuilder('l')
            ->orderBy('l.classLevel', 'ASC')
            ->addOrderBy('l.title', 'ASC');

        if ($classLevel) {
            $qb->andWhere('l.classLevel = :classLevel')
                ->setParameter('classLevel', $classLevel);
        }

        if ($search) {
            $qb->andWhere('l.title LIKE :search OR l.author LIKE :search')
                ->setParameter('search', '%' . $search . '%');
        }

        return $qb->getQuery()->getResult();
    }
}
