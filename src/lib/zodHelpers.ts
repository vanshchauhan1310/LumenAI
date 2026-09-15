import { z } from "zod";

// Small/free-tier models routinely ask for a `limit` above what a tool
// actually allows (seen in practice: llama-3.2-11b-vision-instruct calling
// list_workbooks with limit 1000, then 500, then 1000 again, oscillating
// until it burned through every tool round without ever reading the
// rejection). Rejecting the call with a validation error relies on the model
// correctly reading and acting on that error — plenty don't. Clamping to the
// max instead makes the call succeed the first time regardless, at the cost
// of silently capping results a stronger model would have deliberately
// wanted trimmed (which paging via `offset` already covers).
export function clampedLimit(max: number, defaultValue: number) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .default(defaultValue)
    .transform((v) => Math.min(v, max));
}
