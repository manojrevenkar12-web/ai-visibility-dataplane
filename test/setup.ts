// Tests use their own databases so they can run next to a local stack or a drill.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://avd:avd@127.0.0.1:5432/avd_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15";
process.env.CLICKHOUSE_DB = process.env.TEST_CLICKHOUSE_DB ?? "avd_test";
process.env.LOG_LEVEL = "error";

import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000);
