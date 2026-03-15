/**
 * Exponential backoff with jitter.
 *
 * Formula (matches client-go exactly):
 *   delay = min(baseDelay * 2^attempt, maxDelay) * jitter
 *   jitter = uniform random in [0.5, 1.0]   (equal jitter)
 *
 * The shift is capped at 62 to prevent overflow in 64-bit arithmetic.
 *
 * @param attempt   0-based attempt number
 * @param baseDelay base delay in milliseconds
 * @param maxDelay  maximum delay in milliseconds
 * @returns delay in milliseconds
 */
export function backoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  const shift = Math.min(attempt, 62);
  let delay = baseDelay * 2 ** shift;
  if (delay > maxDelay || delay <= 0) {
    delay = maxDelay;
  }
  const half = delay / 2;
  return half + Math.random() * (delay - half);
}
