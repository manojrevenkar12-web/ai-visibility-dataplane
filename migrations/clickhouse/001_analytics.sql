-- Customer-facing analytics. ReplacingMergeTree keyed by run keeps exactly one version of each run
-- (the highest lease fence); queries read FINAL so a duplicate never reaches a customer even before
-- a merge, and inserts carry a deduplication token so a retried batch is dropped on arrival.

CREATE TABLE IF NOT EXISTS answers (
  run_id String,
  project_id LowCardinality(String),
  prompt_id String,
  provider LowCardinality(String),
  country LowCardinality(String),
  slot DateTime('UTC'),
  model LowCardinality(String),
  answer_chars UInt32,
  brands_mentioned UInt16,
  citations UInt16,
  completed_at DateTime64(3, 'UTC'),
  version UInt64
) ENGINE = ReplacingMergeTree(version)
ORDER BY (project_id, slot, provider, run_id)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS mentions (
  run_id String,
  project_id LowCardinality(String),
  prompt_id String,
  provider LowCardinality(String),
  slot DateTime('UTC'),
  brand_id String,
  is_own UInt8,
  mentioned UInt8,
  position UInt8,
  version UInt64
) ENGINE = ReplacingMergeTree(version)
ORDER BY (project_id, slot, provider, run_id, brand_id)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS citations (
  run_id String,
  project_id LowCardinality(String),
  prompt_id String,
  provider LowCardinality(String),
  slot DateTime('UTC'),
  url String,
  domain LowCardinality(String),
  source_type LowCardinality(String),
  rank UInt8,
  version UInt64
) ENGINE = ReplacingMergeTree(version)
ORDER BY (project_id, slot, provider, run_id, url)
SETTINGS non_replicated_deduplication_window = 1000;
