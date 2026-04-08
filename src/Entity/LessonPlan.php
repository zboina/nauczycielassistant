<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\LessonPlanRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: LessonPlanRepository::class)]
class LessonPlan
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 200)]
    private ?string $title = null;

    #[ORM\Column(length: 10)]
    private ?string $classLevel = null;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: true)]
    private ?Literature $literature = null;

    #[ORM\Column(length: 200, nullable: true)]
    private ?string $lessonTopic = null;

    #[ORM\Column(type: Types::TEXT)]
    private ?string $content = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $promptUsed = null;

    #[ORM\Column]
    private int $durationMinutes = 45;

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

    public function getId(): ?int { return $this->id; }

    public function getTitle(): ?string { return $this->title; }
    public function setTitle(string $title): static { $this->title = $title; return $this; }

    public function getClassLevel(): ?string { return $this->classLevel; }
    public function setClassLevel(string $classLevel): static { $this->classLevel = $classLevel; return $this; }

    public function getLiterature(): ?Literature { return $this->literature; }
    public function setLiterature(?Literature $literature): static { $this->literature = $literature; return $this; }

    public function getLessonTopic(): ?string { return $this->lessonTopic; }
    public function setLessonTopic(?string $lessonTopic): static { $this->lessonTopic = $lessonTopic; return $this; }

    public function getContent(): ?string { return $this->content; }
    public function setContent(string $content): static { $this->content = $content; return $this; }

    public function getPromptUsed(): ?string { return $this->promptUsed; }
    public function setPromptUsed(?string $promptUsed): static { $this->promptUsed = $promptUsed; return $this; }

    public function getDurationMinutes(): int { return $this->durationMinutes; }
    public function setDurationMinutes(int $durationMinutes): static { $this->durationMinutes = $durationMinutes; return $this; }

    public function isFavorite(): bool { return $this->isFavorite; }
    public function setIsFavorite(bool $isFavorite): static { $this->isFavorite = $isFavorite; return $this; }

    public function getCreatedAt(): \DateTimeImmutable { return $this->createdAt; }

    public function getOwner(): ?User { return $this->owner; }
    public function setOwner(?User $owner): static { $this->owner = $owner; return $this; }
}
