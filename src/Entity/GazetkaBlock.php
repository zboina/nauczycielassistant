<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\GazetkaBlockRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * Zapisany, zgrupowany zestaw elementów gazetki (blok wielokrotnego użytku) — per użytkownik,
 * wspólny dla wszystkich jego gazetek. Zastępuje wcześniejszy zapis w localStorage.
 */
#[ORM\Entity(repositoryClass: GazetkaBlockRepository::class)]
class GazetkaBlock
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false)]
    private ?User $owner = null;

    #[ORM\Column(length: 120)]
    private string $name = 'Blok';

    /** Wymiary bloku w punktach (do osadzenia/podglądu). */
    #[ORM\Column]
    private int $width = 0;

    #[ORM\Column]
    private int $height = 0;

    #[ORM\Column]
    private int $elementCount = 0;

    /** Miniatura PNG jako data URI (może być null). */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $preview = null;

    /**
     * Elementy bloku (znormalizowane do origin 0,0) jako tablica.
     *
     * @var array<int, mixed>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $data = [];

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    public function __construct()
    {
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getOwner(): ?User
    {
        return $this->owner;
    }

    public function setOwner(?User $owner): static
    {
        $this->owner = $owner;
        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;
        return $this;
    }

    public function getWidth(): int
    {
        return $this->width;
    }

    public function setWidth(int $width): static
    {
        $this->width = $width;
        return $this;
    }

    public function getHeight(): int
    {
        return $this->height;
    }

    public function setHeight(int $height): static
    {
        $this->height = $height;
        return $this;
    }

    public function getElementCount(): int
    {
        return $this->elementCount;
    }

    public function setElementCount(int $elementCount): static
    {
        $this->elementCount = $elementCount;
        return $this;
    }

    public function getPreview(): ?string
    {
        return $this->preview;
    }

    public function setPreview(?string $preview): static
    {
        $this->preview = $preview;
        return $this;
    }

    /**
     * @return array<int, mixed>
     */
    public function getData(): array
    {
        return $this->data;
    }

    /**
     * @param array<int, mixed> $data
     */
    public function setData(array $data): static
    {
        $this->data = $data;
        return $this;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
