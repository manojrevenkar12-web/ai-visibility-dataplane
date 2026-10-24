export interface Citation {
  url: string;
  title?: string | undefined;
}

/** What every provider's response is normalised to. */
export interface ProviderAnswer {
  text: string;
  citations: Citation[];
  model: string;
  requestId: string | null;
  hasAnswer: boolean; // an AI Overview is often simply absent; that is a valid result, not an error
  parser: string; // which parser version read it
}

export type FailureKind =
  | "throttled" // 429: wait and try again; not the provider's fault, not ours if the limiter is right
  | "unavailable" // 5xx, connection errors, timeouts: retry with backoff, counts against the circuit
  | "truncated" // 200 but the body is cut off: retry
  | "schema_drift" // the body parses but no parser knows its shape: do not retry; park the raw response
  | "rejected"; // 4xx other than 429: our request is wrong; retrying will not help

export class ProviderError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly raw: string | null = null,
    readonly billed = false,
    readonly timedOut = false,
  ) {
    super(message);
  }

  get retryable() {
    return this.kind === "throttled" || this.kind === "unavailable" || this.kind === "truncated";
  }
}
