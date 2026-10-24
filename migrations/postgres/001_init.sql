-- System of record: projects and what they track, runs and their results, and the two outboxes
-- (analytics to ClickHouse, events to webhooks) written in the same transaction as the result.

CREATE TABLE project (
  id text PRIMARY KEY,
  name text NOT NULL,
  daily_budget_eur numeric(12, 4) NOT NULL DEFAULT 50,
  providers text[] NOT NULL DEFAULT ARRAY['openai', 'anthropic', 'perplexity', 'gemini', 'ai_overview'],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brand (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  domains text[] NOT NULL DEFAULT '{}',
  is_own boolean NOT NULL DEFAULT false,
  ambiguous boolean NOT NULL DEFAULT false   -- the name is also an ordinary word ("Linear", "Bear")
);
CREATE INDEX brand_project ON brand(project_id);

CREATE TABLE prompt (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  text text NOT NULL,
  country text NOT NULL DEFAULT 'DE',
  active boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 1440
);
CREATE INDEX prompt_project ON prompt(project_id) WHERE active;

-- One row per (prompt, provider, country, slot). The id is derived from those, so scheduling the
-- same slot twice is a no-op.
CREATE TABLE run (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  prompt_id text NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  provider text NOT NULL,
  country text NOT NULL,
  slot timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'succeeded', 'failed', 'skipped_budget')),
  attempts integer NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,           -- highest lease fence that wrote this run
  error_kind text,
  last_error text,
  cost_eur numeric(12, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX run_pending ON run(created_at) WHERE status = 'pending';
CREATE INDEX run_project_slot ON run(project_id, slot);

CREATE TABLE run_result (
  run_id text PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  model text,
  provider_request_id text,
  answer_text text NOT NULL,
  raw jsonb NOT NULL,
  parser text NOT NULL,
  fence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every provider call, including failed ones: what we spent and why.
CREATE TABLE provider_call (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  provider text NOT NULL,
  attempt integer NOT NULL,
  outcome text NOT NULL,
  http_status integer,
  latency_ms integer,
  cost_eur numeric(12, 6) NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_call_run ON provider_call(run_id);

-- Responses no parser accepted, kept for the engineer who updates the parser.
CREATE TABLE quarantine (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  provider text NOT NULL,
  reason text NOT NULL,
  sample text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_outbox (
  run_id text PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  fence bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  shipped_at timestamptz
);
CREATE INDEX analytics_outbox_pending ON analytics_outbox(created_at) WHERE shipped_at IS NULL;

CREATE TABLE event_outbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  project_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fanned_out_at timestamptz
);
CREATE INDEX event_outbox_pending ON event_outbox(id) WHERE fanned_out_at IS NULL;

CREATE TABLE webhook_endpoint (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  event_types text[] NOT NULL DEFAULT ARRAY['run.completed', 'run.failed', 'budget.exhausted'],
  active boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_delivery (
  id bigserial PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES webhook_endpoint(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  delivered_at timestamptz,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_delivery_due ON webhook_delivery(next_attempt_at) WHERE status = 'pending';

-- The scheduler's leader writes its lock fence here; a deposed leader's writes are refused.
CREATE TABLE leader_fence (
  name text PRIMARY KEY,
  fence bigint NOT NULL
);
