// Calling a provider: one HTTP request with a deadline, classified into success or a typed failure.

import type { ProviderConfig } from "../infra/config";
import { retryAfterMs } from "../queue/backoff";
import { parseBody } from "./parsers";
import { type ProviderAnswer, ProviderError } from "./types";

export interface CallInput {
  runId: string;
  promptId: string;
  prompt: string;
  country: string;
}

function body(cfg: ProviderConfig, i: CallInput): unknown {
  const meta = { prompt_id: i.promptId, run_id: i.runId };
  switch (cfg.format) {
    case "openai":
      return {
        model: "gpt-search",
        messages: [{ role: "user", content: i.prompt }],
        web_search_options: { user_location: { country: i.country } },
        ...meta,
      };
    case "anthropic":
      return {
        model: "claude-search",
        max_tokens: 1024,
        messages: [{ role: "user", content: i.prompt }],
        tools: [{ type: "web_search", name: "web_search" }],
        ...meta,
      };
    case "perplexity":
      return { model: "sonar", messages: [{ role: "user", content: i.prompt }], ...meta };
    case "gemini":
      return { contents: [{ role: "user", parts: [{ text: i.prompt }] }], tools: [{ google_search: {} }], ...meta };
    default:
      return { engine: "google", q: i.prompt, gl: i.country.toLowerCase(), ...meta };
  }
}

export async function callProvider(
  baseUrl: string,
  cfg: ProviderConfig,
  input: CallInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ answer: ProviderAnswer; raw: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${cfg.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-run-id": input.runId, "idempotency-key": input.runId },
      body: JSON.stringify(body(cfg, input)),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    throw new ProviderError(
      "unavailable",
      timedOut ? `timeout after ${cfg.timeout_ms} ms` : `connection: ${(e as Error).message}`,
      null,
      null,
      null,
      false,
      timedOut,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new ProviderError("unavailable", `body read failed: ${(e as Error).message}`, res.status);
  }
  if (res.status === 429) throw new ProviderError("throttled", "429 from provider", 429, retryAfterMs(res.headers.get("retry-after")));
  if (res.status >= 500)
    throw new ProviderError(
      "unavailable",
      `${res.status} from provider`,
      res.status,
      retryAfterMs(res.headers.get("retry-after")),
      null,
      true,
    );
  if (res.status >= 400) throw new ProviderError("rejected", `${res.status}: ${text.slice(0, 200)}`, res.status);
  const parsed = parseBody(cfg.format, text);
  if (!parsed.ok) throw new ProviderError(parsed.kind, parsed.detail, res.status, null, text, true);
  return { answer: { ...parsed.answer, requestId: res.headers.get("x-request-id") }, raw: text };
}
