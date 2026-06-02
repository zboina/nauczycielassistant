<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Kolumna `category` w `gazetka_page_template` — grupowanie szablonów stron w zakładki.
 */
final class Version20260529130000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add category column to gazetka_page_template (for grouping into tabs).';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE gazetka_page_template ADD COLUMN category VARCHAR(60) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE gazetka_page_template DROP COLUMN category');
    }
}
