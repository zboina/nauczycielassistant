<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Tabela szablonów stron gazetki (per użytkownik) — zapisana CAŁA strona do wielokrotnego użycia.
 */
final class Version20260529120000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add gazetka_page_template table (per-owner whole-page templates).';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE gazetka_page_template (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name VARCHAR(120) NOT NULL, page_width INTEGER NOT NULL, page_height INTEGER NOT NULL, background VARCHAR(16) DEFAULT NULL, element_count INTEGER NOT NULL, preview CLOB DEFAULT NULL, elements CLOB NOT NULL, created_at DATETIME NOT NULL, owner_id INTEGER NOT NULL, CONSTRAINT FK_PAGETPL_OWNER FOREIGN KEY (owner_id) REFERENCES "user" (id) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_PAGETPL_OWNER ON gazetka_page_template (owner_id)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE gazetka_page_template');
    }
}
