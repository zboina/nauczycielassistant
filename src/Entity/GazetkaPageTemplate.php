<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\GazetkaPageTemplateRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * Szablon CAŁEJ STRONY zapisany przez użytkownika do wielokrotnego użycia w dowolnym projekcie.
 * Inny niż [[GazetkaBlock]] (blok = wybrana grupa elementów): tu trzymamy KOMPLET strony
 * (tło + elementy + wymiary strony), żeby szybko składać kolejne numery z gotowych „layoutów".
 */
#[ORM\Entity(repositoryClass: GazetkaPageTemplateRepository::class)]
class GazetkaPageTemplate
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false)]
    private ?User $owner = null;

    #[ORM\Column(length: 120)]
    private string $name = 'Szablon strony';

    /** Kategoria / grupa (np. „Okładki", „Artykuły", „Fotorelacje" …). null = bez kategorii („Inne"). */
    #[ORM\Column(length: 60, nullable: true)]
    private ?string $category = null;

    /** Wymiary strony w pt (do podglądu proporcji + wskazówki dla docelowej gazetki). */
    #[ORM\Column]
    private int $pageWidth = 0;

    #[ORM\Column]
    private int $pageHeight = 0;

    /** Tło strony (kolor HEX lub null). */
    #[ORM\Column(length: 16, nullable: true)]
    private ?string $background = null;

    /** Liczba elementów (cache do listy). */
    #[ORM\Column]
    private int $elementCount = 0;

    /** Miniatura PNG/JPEG jako data URI (może być null). */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $preview = null;

    /**
     * Elementy strony (już znormalizowane do origin 0,0 strony).
     *
     * @var array<int, mixed>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $elements = [];

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

    public function getCategory(): ?string
    {
        return $this->category;
    }

    public function setCategory(?string $category): static
    {
        $this->category = $category;
        return $this;
    }

    public function getPageWidth(): int
    {
        return $this->pageWidth;
    }

    public function setPageWidth(int $w): static
    {
        $this->pageWidth = $w;
        return $this;
    }

    public function getPageHeight(): int
    {
        return $this->pageHeight;
    }

    public function setPageHeight(int $h): static
    {
        $this->pageHeight = $h;
        return $this;
    }

    public function getBackground(): ?string
    {
        return $this->background;
    }

    public function setBackground(?string $bg): static
    {
        $this->background = $bg;
        return $this;
    }

    public function getElementCount(): int
    {
        return $this->elementCount;
    }

    public function setElementCount(int $n): static
    {
        $this->elementCount = $n;
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

    /** @return array<int, mixed> */
    public function getElements(): array
    {
        return $this->elements;
    }

    /** @param array<int, mixed> $elements */
    public function setElements(array $elements): static
    {
        $this->elements = $elements;
        return $this;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
