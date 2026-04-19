export interface ParseJsonSafeOptions<T> {
  source: string;
  fallback?: T | undefined;
  onError?: "null" | "throw" | undefined;
}

export function safeJsonParse<T>(
  raw: string | null | undefined,
  ctx: string | ParseJsonSafeOptions<T>,
  fallback?: T,
): T | null {
  if (!raw) return (typeof ctx === "object" ? ctx.fallback : fallback) ?? null;

  const opts: ParseJsonSafeOptions<T> =
    typeof ctx === "string" ? { source: ctx, fallback, onError: "null" } : ctx;

  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const msg = `Failed to parse JSON (${opts.source}): ${e instanceof Error ? e.message : e}`;
    if (opts.onError === "throw") throw new Error(msg);
    console.warn(`[synapse-chat/server] ${msg}`);
    return opts.fallback ?? null;
  }
}
