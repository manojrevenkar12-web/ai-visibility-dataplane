-- A quarantined response is resolved when a parser fix completes its run from the stored body.
ALTER TABLE quarantine ADD COLUMN resolved_at timestamptz;
ALTER TABLE quarantine ADD COLUMN resolved_by text;
CREATE INDEX quarantine_open ON quarantine(provider) WHERE resolved_at IS NULL;
