import 'reflect-metadata';
import type { NextFunction, Request, Response } from 'express';
import { getRequestId } from '@ever-jobs/common';
import { requestContextMiddleware } from '../request-context.middleware';

/**
 * The correlation id established here is reflected in the `X-Request-Id`
 * response header and interpolated into every outbound retry log line the
 * request causes, so an inbound value is adopted only when it is well-formed.
 */
describe('requestContextMiddleware', () => {
  /** Run the middleware for one inbound header value and capture the id in scope. */
  function idFor(header: string | string[] | undefined): string {
    const req = { headers: header === undefined ? {} : { 'x-request-id': header } } as unknown as Request;

    let seen = '';
    const next: NextFunction = () => {
      seen = getRequestId() ?? '';
    };
    requestContextMiddleware(req, {} as Response, next);

    return seen;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('mints a uuid when no inbound id is present', () => {
    expect(idFor(undefined)).toMatch(UUID_RE);
  });

  it('always establishes an id, so getRequestId() is never empty in a request', () => {
    expect(idFor(undefined)).not.toBe('');
  });

  it.each([
    ['a uuid', '3f8a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b'],
    ['a W3C traceparent-style id', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['a vendor id with dots and colons', 'svc.web:req-12345'],
  ])('honours %s', (_label, value) => {
    expect(idFor(value)).toBe(value);
  });

  it('trims surrounding whitespace before adopting an id', () => {
    expect(idFor('  req-42  ')).toBe('req-42');
  });

  it('takes the first value when the header is repeated', () => {
    expect(idFor(['req-first', 'req-second'])).toBe('req-first');
  });

  describe('rejects ids it will not echo', () => {
    it.each([
      ['an overlong id', 'x'.repeat(129)],
      ['a CRLF injection attempt', 'abc\r\nX-Injected: 1'],
      ['a bare newline', 'abc\ndef'],
      ['a space-separated value', 'abc def'],
      ['a semicolon', 'abc;def'],
    ])('replaces %s with a minted uuid', (_label, value) => {
      const id = idFor(value);

      expect(id).toMatch(UUID_RE);
      expect(id).not.toContain(value.trim());
    });

    it('mints a uuid for a whitespace-only id', () => {
      expect(idFor('   ')).toMatch(UUID_RE);
    });

    it('accepts an id exactly at the length limit', () => {
      const atLimit = 'y'.repeat(128);

      expect(idFor(atLimit)).toBe(atLimit);
    });
  });
});
