export interface RunJob {
  runId: string;
  projectId: string;
  promptId: string;
  provider: string;
  country: string;
  slot: string; // ISO
  prompt: string;
  queuedAt: number; // ms; a run older than limits.queue.max_age_ms is given up
}

export interface AnalyticsPayload {
  run: { id: string; project_id: string; prompt_id: string; provider: string; country: string; slot: string };
  model: string;
  answer_chars: number;
  completed_at: string;
  mentions: { brand_id: string; is_own: boolean; mentioned: boolean; position: number }[];
  citations: { url: string; domain: string; source_type: string; rank: number }[];
}
