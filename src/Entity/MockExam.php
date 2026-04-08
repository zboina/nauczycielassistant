<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\MockExamRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: MockExamRepository::class)]
class MockExam
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(length: 255)]
    private ?string $title = null;

    #[ORM\Column(length: 10)]
    private ?string $classLevel = null;

    /** full, reading_literary, reading_informational, essay_only */
    #[ORM\Column(length: 30)]
    private string $examType = 'full';

    /** JSON: full exam content (texts, questions, answer key) */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $examContent = null;

    /** JSON: answer key for auto-grading closed questions */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $answerKey = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $promptUsed = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false)]
    private ?User $owner = null;

    /** @var Collection<int, MockExamResult> */
    #[ORM\OneToMany(targetEntity: MockExamResult::class, mappedBy: 'exam', cascade: ['persist', 'remove'], orphanRemoval: true)]
    #[ORM\OrderBy(['studentName' => 'ASC'])]
    private Collection $results;

    public function __construct()
    {
        $this->createdAt = new \DateTimeImmutable();
        $this->results = new ArrayCollection();
    }

    public function getId(): ?int { return $this->id; }

    public function getTitle(): ?string { return $this->title; }
    public function setTitle(string $title): static { $this->title = $title; return $this; }

    public function getClassLevel(): ?string { return $this->classLevel; }
    public function setClassLevel(string $classLevel): static { $this->classLevel = $classLevel; return $this; }

    public function getExamType(): string { return $this->examType; }
    public function setExamType(string $examType): static { $this->examType = $examType; return $this; }

    public function getExamContent(): ?array { return $this->examContent; }
    public function setExamContent(?array $examContent): static { $this->examContent = $examContent; return $this; }

    public function getAnswerKey(): ?array { return $this->answerKey; }
    public function setAnswerKey(?array $answerKey): static { $this->answerKey = $answerKey; return $this; }

    public function getPromptUsed(): ?string { return $this->promptUsed; }
    public function setPromptUsed(?string $promptUsed): static { $this->promptUsed = $promptUsed; return $this; }

    public function getCreatedAt(): \DateTimeImmutable { return $this->createdAt; }

    public function getOwner(): ?User { return $this->owner; }
    public function setOwner(?User $owner): static { $this->owner = $owner; return $this; }

    /** @return Collection<int, MockExamResult> */
    public function getResults(): Collection { return $this->results; }

    public function getResultCount(): int { return $this->results->count(); }

    public function getMaxPoints(): int
    {
        $content = $this->examContent;
        if (!$content) {
            return 0;
        }
        $total = 0;
        foreach ($content['parts'] ?? [] as $part) {
            foreach ($part['questions'] ?? [] as $q) {
                $total += $q['points'] ?? 1;
            }
        }
        // Essay part
        if (isset($content['essayTopics'])) {
            $total += 20; // CKE: treść 4 + forma 4 + kompozycja 3 + język 3 + ortografia 2 + interpunkcja 2 + bogactwo 2 = 20
        }
        return $total;
    }

    public function getAverageScore(): ?float
    {
        if ($this->results->isEmpty()) {
            return null;
        }
        $sum = 0;
        foreach ($this->results as $r) {
            $sum += $r->getTotalScore();
        }
        return round($sum / $this->results->count(), 1);
    }

    public function getAveragePercent(): ?float
    {
        $max = $this->getMaxPoints();
        $avg = $this->getAverageScore();
        if ($avg === null || $max === 0) {
            return null;
        }
        return round($avg / $max * 100, 0);
    }

    public static function getExamTypeLabels(): array
    {
        return [
            'full' => 'Pełny arkusz',
            'reading_literary' => 'Tylko tekst literacki',
            'reading_informational' => 'Tylko tekst nieliteracki',
            'essay_only' => 'Tylko wypracowanie',
        ];
    }

    public function getExamTypeLabel(): string
    {
        return self::getExamTypeLabels()[$this->examType] ?? $this->examType;
    }
}
