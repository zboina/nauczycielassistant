<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\AppSetting;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<AppSetting>
 */
class AppSettingRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, AppSetting::class);
    }

    public function get(string $key, string $default = ''): string
    {
        $setting = $this->find($key);
        return $setting ? $setting->getValue() : $default;
    }

    public function set(string $key, string $value): void
    {
        $em = $this->getEntityManager();
        $setting = $this->find($key);
        if (!$setting) {
            $setting = new AppSetting($key, $value);
            $em->persist($setting);
        } else {
            $setting->setValue($value);
        }
        $em->flush();
    }

    public function getAll(): array
    {
        $result = [];
        foreach ($this->findAll() as $s) {
            $result[$s->getKey()] = $s->getValue();
        }
        return $result;
    }
}
