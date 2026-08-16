import { runWithRequestId } from '@ever-jobs/common';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Establish the request-scoped correlation id before anything else runs, so every
 * outbound call the request causes (scraper HTTP, retries) can name the request it
 * belongs to. An inbound `X-Request-Id` is honored so a caller can correlate too.
 */
export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers['x-request-id'];
  const requestId = (Array.isArray(inbound) ? inbound[0] : inbound)?.trim() || uuidv4();
  runWithRequestId(requestId, () => next());
}
