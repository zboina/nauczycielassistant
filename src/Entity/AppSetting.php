<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\AppSettingRepository;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: AppSettingRepository::class)]
class AppSetting
{
    #[ORM\Id]
    #[ORM\Column(length: 100)]
    private string $key;

    #[ORM\Column(length: 500)]
    private string $value;

    public function __construct(string $key = '', string $value = '')
    {
        $this->key = $key;
        $this->value = $value;
    }

    public function getKey(): string { return $this->key; }
    public function getValue(): string { return $this->value; }
    public function setValue(string $value): static { $this->value = $value; return $this; }
}
