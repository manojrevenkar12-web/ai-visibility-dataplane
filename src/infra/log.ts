// Structured JSON logs: one line per event, with the fields an on-call engineer filters on.
import { env } from "./config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
let sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`);
let min = LEVELS[env.logLevel] ?? 20;

export function setLogSink(fn: (line: string) => void, level: Level = "debug") {
  sink = fn;
  min = LEVELS[level];
}

function emit(level: Level, msg: string, fields: Record<string, unknown>) {
  if (LEVELS[level] < min) return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
}

export const log = {
  debug: (msg: string, f: Record<string, unknown> = {}) => emit("debug", msg, f),
  info: (msg: string, f: Record<string, unknown> = {}) => emit("info", msg, f),
  warn: (msg: string, f: Record<string, unknown> = {}) => emit("warn", msg, f),
  error: (msg: string, f: Record<string, unknown> = {}) => emit("error", msg, f),
};
