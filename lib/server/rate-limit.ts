import "server-only";
import { headers } from "next/headers";
import { S, withService } from "@/lib/db";

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Fixed-window rate limit backed by the database (works across server instances). */
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const ws = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / ws) * ws);
  const row = await withService((tx) =>
    tx.one<{ count: number }>(
      `DELETE FROM ${S}.rate_limits WHERE window_start < dateadd(day, -1, sysdatetimeoffset());
       MERGE ${S}.rate_limits WITH (HOLDLOCK) AS t
       USING (SELECT CAST($1 AS nvarchar(200)) AS k, CAST($2 AS datetimeoffset(0)) AS w) AS s
       ON t.[key] = s.k AND t.window_start = s.w
       WHEN MATCHED THEN UPDATE SET [count] = t.[count] + 1
       WHEN NOT MATCHED THEN INSERT ([key], window_start, [count]) VALUES (s.k, s.w, 1);
       SELECT [count] AS [count] FROM ${S}.rate_limits WHERE [key] = $1 AND window_start = CAST($2 AS datetimeoffset(0));`,
      [key.slice(0, 200), windowStart],
    ),
  );
  return (row?.count ?? 1) <= max;
}
