import { runWithRequestId } from '@ever-jobs/common';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Longest correlation id we will echo. A UUID is 36 characters and a W3C
 * `traceparent` is 55; the cap is generous while keeping an inbound header out
 * of every retry log line at Node's ~16 KB header budget.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Characters permitted in a correlation id — enough for UUIDs, trace ids and
 * the usual vendor formats. Anything outside this set is rejected rather than
 * sanitised: the id is reflected in the `X-Request-Id` response header and
 * interpolated into log lines, so it must not be able to carry separators or
 * control characters into either.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Whether an inbound correlation id is safe to adopt as-is. */
function isUsableRequestId(value: string): boolean {
  return value.length <= MAX_REQUEST_ID_LENGTH && REQUEST_ID_PATTERN.test(value);
}

/**
 * Establish the request-scoped correlation id before anything else runs, so every
 * outbound call the request causes (scraper HTTP, retries) can name the request it
 * belongs to. An inbound `X-Request-Id` is honored so a caller can correlate too —
 * but only when it is well-formed; otherwise we mint our own rather than let a
 * caller choose what lands in our logs and response headers.
 */
export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers['x-request-id'];
  const candidate = (Array.isArray(inbound) ? inbound[0] : inbound)?.trim();
  const requestId = candidate && isUsableRequestId(candidate) ? candidate : uuidv4();
  runWithRequestId(requestId, () => next());
}
