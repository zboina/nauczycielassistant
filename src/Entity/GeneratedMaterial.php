<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\GeneratedMaterialRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: GeneratedMaterialRepository::class)]
class GeneratedMaterial
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 30)]
    private ?string $type = null;

    #[ORM\Column(length: 200, nullable: true)]
    private ?string $title = null;

    #[ORM\Column(length: 10, nullable: true)]
    private ?string $classLevel = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $subjectContext = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $promptUsed = null;

    #[ORM\Column(type: Types::TEXT)]
    private ?string $content = null;

    #[ORM\Column(length: 500, nullable: true)]
    private ?string $filePath = null;

    #[ORM\Column]
    private bool $isFavorite = false;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false)]
    private ?User $owner = null;

    public function __construct()
    {
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getType(): ?string
    {
        return $this->type;
    }

    public function setType(string $type): static
    {
        $this->type = $type;
        return $this;
    }

    public function getTitle(): ?string
    {
        return $this->title;
    }

    public function setTitle(?string $title): static
    {
        $this->title = $title;
        return $this;
    }

    public function getClassLevel(): ?string
    {
        return $this->classLevel;
    }

    public function setClassLevel(?string $classLevel): static
    {
        $this->classLevel = $classLevel;
        return $this;
    }

    public function getSubjectContext(): ?string
    {
        return $this->subjectContext;
    }

    public function setSubjectContext(?string $subjectContext): static
    {
        $this->subjectContext = $subjectContext;
        return $this;
    }

    public function getPromptUsed(): ?string
    {
        return $this->promptUsed;
    }

    public function setPromptUsed(?string $promptUsed): static
    {
        $this->promptUsed = $promptUsed;
        return $this;
    }

    public function getContent(): ?string
    {
        return $this->content;
    }

    public function setContent(string $content): static
    {
        $this->content = $content;
        return $this;
    }

    public function getFilePath(): ?string
    {
        return $this->filePath;
    }

    public function setFilePath(?string $filePath): static
    {
        $this->filePath = $filePath;
        return $this;
    }

    public function isFavorite(): bool
    {
        return $this->isFavorite;
    }

    public function setIsFavorite(bool $isFavorite): static
    {
        $this->isFavorite = $isFavorite;
        return $this;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
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
}
