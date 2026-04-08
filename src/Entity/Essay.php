<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\EssayRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: EssayRepository::class)]
class Essay
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 255)]
    private ?string $topic = null;

    /** rozprawka, opowiadanie, charakterystyka, recenzja, streszczenie, opis, list, inne */
    #[ORM\Column(length: 50)]
    private ?string $writingForm = null;

    #[ORM\Column(length: 10)]
    private ?string $classLevel = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $instructions = null;

    /** cke, custom */
    #[ORM\Column(length: 20)]
    private string $criteriaType = 'cke';

    #[ORM\Column(nullable: true)]
    private ?int $minWords = null;

    #[ORM\Column(type: Types::DATETIME_IMMUTABLE, nullable: true)]
    private ?\DateTimeImmutable $deadline = null;

    #[ORM\Column(length: 8, unique: true)]
    private ?string $accessCode = null;

    #[ORM\Column]
    private bool $isActive = true;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false)]
    private ?User $owner = null;

    /** @var Collection<int, EssaySubmission> */
    #[ORM\OneToMany(targetEntity: EssaySubmission::class, mappedBy: 'essay', cascade: ['persist', 'remove'], orphanRemoval: true)]
    #[ORM\OrderBy(['submittedAt' => 'DESC'])]
    private Collection $submissions;

    public function __construct()
    {
        $this->createdAt = new \DateTimeImmutable();
        $this->submissions = new ArrayCollection();
        $this->accessCode = strtoupper(substr(bin2hex(random_bytes(4)), 0, 6));
    }

    public function getId(): ?int { return $this->id; }

    public function getTopic(): ?string { return $this->topic; }
    public function setTopic(string $topic): static { $this->topic = $topic; return $this; }

    public function getWritingForm(): ?string { return $this->writingForm; }
    public function setWritingForm(string $writingForm): static { $this->writingForm = $writingForm; return $this; }

    public function getClassLevel(): ?string { return $this->classLevel; }
    public function setClassLevel(string $classLevel): static { $this->classLevel = $classLevel; return $this; }

    public function getInstructions(): ?string { return $this->instructions; }
    public function setInstructions(?string $instructions): static { $this->instructions = $instructions; return $this; }

    public function getCriteriaType(): string { return $this->criteriaType; }
    public function setCriteriaType(string $criteriaType): static { $this->criteriaType = $criteriaType; return $this; }

    public function getMinWords(): ?int { return $this->minWords; }
    public function setMinWords(?int $minWords): static { $this->minWords = $minWords; return $this; }

    public function getDeadline(): ?\DateTimeImmutable { return $this->deadline; }
    public function setDeadline(?\DateTimeImmutable $deadline): static { $this->deadline = $deadline; return $this; }

    public function getAccessCode(): ?string { return $this->accessCode; }

    public function isActive(): bool { return $this->isActive; }
    public function setIsActive(bool $isActive): static { $this->isActive = $isActive; return $this; }

    public function getCreatedAt(): \DateTimeImmutable { return $this->createdAt; }

    public function getOwner(): ?User { return $this->owner; }
    public function setOwner(?User $owner): static { $this->owner = $owner; return $this; }

    /** @return Collection<int, EssaySubmission> */
    public function getSubmissions(): Collection { return $this->submissions; }

    public function isExpired(): bool
    {
        return $this->deadline !== null && $this->deadline < new \DateTimeImmutable();
    }

    public function isAccepting(): bool
    {
        return $this->isActive && !$this->isExpired();
    }

    public function getSubmissionCount(): int { return $this->submissions->count(); }

    public function getReviewedCount(): int
    {
        return $this->submissions->filter(fn(EssaySubmission $s) => $s->getStatus() === 'approved')->count();
    }

    public static function getWritingFormLabels(): array
    {
        return [
            'rozprawka' => 'Rozprawka',
            'opowiadanie' => 'Opowiadanie twórcze',
            'charakterystyka' => 'Charakterystyka',
            'charakterystyka_porownawcza' => 'Charakterystyka porównawcza',
            'recenzja' => 'Recenzja',
            'streszczenie' => 'Streszczenie',
            'opis' => 'Opis',
            'list' => 'List (prywatny/oficjalny)',
            'sprawozdanie' => 'Sprawozdanie',
            'przemowienie' => 'Przemówienie',
            'inne' => 'Inna forma',
        ];
    }

    public function getWritingFormLabel(): string
    {
        return self::getWritingFormLabels()[$this->writingForm] ?? $this->writingForm;
    }
}
