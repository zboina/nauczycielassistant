<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\AiLog;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<AiLog>
 */
class AiLogRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, AiLog::class);
    }

    public function save(
        string $module,
        string $model,
        int $tokensIn,
        int $tokensOut,
        int $durationMs,
        ?User $owner = null,
        string $status = 'success',
        ?string $error = null,
    ): AiLog {
        $log = new AiLog();
        $log->setModule($module);
        $log->setModel($model);
        $log->setTokensInput($tokensIn);
        $log->setTokensOutput($tokensOut);
        $log->setDurationMs($durationMs);
        $log->setStatus($status);
        $log->setError($error);
        $log->setOwner($owner);

        $this->getEntityManager()->persist($log);
        $this->getEntityManager()->flush();

        return $log;
    }

    public function getMonthlyStats(User $owner, \DateTimeImmutable $monthStart): array
    {
        return $this->createQueryBuilder('l')
            ->select('SUM(l.tokensInput) as totalTokensIn, SUM(l.tokensOutput) as totalTokensOut, COUNT(l.id) as totalRequests')
            ->andWhere('l.owner = :owner')
            ->andWhere('l.createdAt >= :start')
            ->andWhere('l.status = :status')
            ->setParameter('owner', $owner)
            ->setParameter('start', $monthStart)
            ->setParameter('status', 'success')
            ->getQuery()
            ->getSingleResult();
    }
}
