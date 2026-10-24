// OpenTelemetry tracing. Exports OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise spans are
// created (so trace ids appear in logs) but not exported.
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { env } from "./config";

let started = false;

export function startTracing(service: string) {
  if (started) return;
  started = true;
  if (!env.otlpUrl) return;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${env.otlpUrl}/v1/traces` }) })],
  });
  trace.setGlobalTracerProvider(provider);
}

const tracer = () => trace.getTracer("ai-visibility-dataplane");

/** Run fn inside a span; errors mark the span and propagate. */
export async function span<T>(name: string, attrs: Record<string, string | number | boolean>, fn: (s: Span) => Promise<T>): Promise<T> {
  const s = tracer().startSpan(name, { attributes: attrs });
  try {
    return await context.with(trace.setSpan(context.active(), s), () => fn(s));
  } catch (e) {
    s.recordException(e as Error);
    s.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
    throw e;
  } finally {
    s.end();
  }
}
