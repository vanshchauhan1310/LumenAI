import { Request, Response, NextFunction } from "express";
import { AuthedRequest } from "./requireAuth.js";

/**
 * In-memory token-bucket rate limiter, keyed per user. Prevents a single
 * account from hammering the paid/third-party endpoints (chat orchestration,
 * LLM key validation) — a real abuse vector once usage metering makes the
 * platform monetizable. In-memory is fine for single-process deployments;
 * swap for a Redis-backed limiter (keyed by userId) if scaled horizontally.
 *
 * Must be mounted AFTER requireAuth so req.userId is populated — otherwise
 * every request shares one anonymous bucket.
 */

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(opts: { refillPerMinute: number; burst: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as AuthedRequest).userId ?? "anon";
    const now = Date.now();

    let bucket = buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: opts.burst, last: now };
      buckets.set(userId, bucket);
    }

    // Refill continuously toward the burst ceiling.
    const elapsedMinutes = Math.max(0, (now - bucket.last) / 60_000);
    bucket.tokens = Math.min(opts.burst, bucket.tokens + elapsedMinutes * opts.refillPerMinute);
    bucket.last = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
    } else {
      res.status(429).json({ error: "Rate limit exceeded — please wait a moment and try again." });
    }
  };
}

/** Test helper: clears all buckets (so tests don't share state). */
export function resetRateLimiter(): void {
  buckets.clear();
}
