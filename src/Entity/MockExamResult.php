<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\MockExamResultRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity(repositoryClass: MockExamResultRepository::class)]
class MockExamResult
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne(inversedBy: 'results')]
    #[ORM\JoinColumn(nullable: false)]
    private ?MockExam $exam = null;

    #[ORM\Column(length: 100)]
    private ?string $studentName = null;

    /** Points per category: {"czytanie": 15, "wypracowanie_tresc": 4, ...} */
    #[ORM\Column(type: Types::JSON, nullable: true)]
    private ?array $scores = null;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $notes = null;

    public function getId(): ?int { return $this->id; }

    public function getExam(): ?MockExam { return $this->exam; }
    public function setExam(?MockExam $exam): static { $this->exam = $exam; return $this; }

    public function getStudentName(): ?string { return $this->studentName; }
    public function setStudentName(string $studentName): static { $this->studentName = $studentName; return $this; }

    public function getScores(): ?array { return $this->scores; }
    public function setScores(?array $scores): static { $this->scores = $scores; return $this; }

    public function getNotes(): ?string { return $this->notes; }
    public function setNotes(?string $notes): static { $this->notes = $notes; return $this; }

    public function getTotalScore(): int
    {
        return $this->scores ? array_sum($this->scores) : 0;
    }

    public function getPercent(): float
    {
        $max = $this->exam?->getMaxPoints() ?? 0;
        return $max > 0 ? round($this->getTotalScore() / $max * 100, 0) : 0;
    }

    public function getGradeColor(): string
    {
        $pct = $this->getPercent();
        if ($pct >= 85) return 'green';
        if ($pct >= 70) return 'blue';
        if ($pct >= 50) return 'yellow';
        if ($pct >= 30) return 'orange';
        return 'red';
    }
}
