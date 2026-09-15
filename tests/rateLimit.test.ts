import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, resetRateLimiter } from "../src/middleware/rateLimit.js";

function mockRes() {
  const calls: { statusCode: number; body: any }[] = [];
  return {
    calls,
    status(code: number) {
      return {
        json: (body: any) => {
          calls.push({ statusCode: code, body });
        },
      };
    },
  };
}

function mockReq(userId?: string) {
  return { userId } as any;
}

test("allows up to burst requests then returns 429", () => {
  resetRateLimiter();
  const limiter = rateLimit({ refillPerMinute: 1, burst: 2 });

  const res1 = mockRes();
  limiter(mockReq("user-a"), res1 as any, () => {});
  assert.equal(res1.calls.length, 0);

  const res2 = mockRes();
  limiter(mockReq("user-a"), res2 as any, () => {});
  assert.equal(res2.calls.length, 0);

  const res3 = mockRes();
  limiter(mockReq("user-a"), res3 as any, () => {});
  assert.equal(res3.calls.length, 1);
  assert.equal(res3.calls[0].statusCode, 429);
});

test("buckets are per-user, not shared", () => {
  resetRateLimiter();
  const limiter = rateLimit({ refillPerMinute: 1, burst: 1 });

  limiter(mockReq("user-a"), mockRes() as any, () => {});
  const resA2 = mockRes();
  limiter(mockReq("user-a"), resA2 as any, () => {});
  assert.equal(resA2.calls.length, 1);
  assert.equal(resA2.calls[0].statusCode, 429);

  // A different user is unaffected.
  const resB = mockRes();
  limiter(mockReq("user-b"), resB as any, () => {});
  assert.equal(resB.calls.length, 0);
});

test("requests without a userId share an anonymous bucket", () => {
  resetRateLimiter();
  const limiter = rateLimit({ refillPerMinute: 1, burst: 1 });

  limiter(mockReq(undefined), mockRes() as any, () => {});
  const res = mockRes();
  limiter(mockReq(undefined), res as any, () => {});
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].statusCode, 429);
});
