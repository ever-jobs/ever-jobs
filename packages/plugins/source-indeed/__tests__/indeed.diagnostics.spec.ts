import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  diagnoseGraphqlErrors,
  diagnoseHttpError,
  diagnoseMissingJobSearch,
  graphqlErrorCode,
  graphqlErrorDetail,
  isBlockPage,
} from '../src/indeed.diagnostics';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const VALIDATION_ERROR = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'indeed-graphql-validation-error.json'), 'utf8'),
);
const WAF_BLOCK_HTML = fs.readFileSync(path.join(FIXTURE_DIR, 'indeed-waf-block.html'), 'utf8');
const CSRF_ERROR = {
  errors: [
    {
      message: 'This operation has been blocked as a potential Cross-Site Request Forgery (CSRF).',
      extensions: { code: 'CSRF_ERROR' },
    },
  ],
};

function httpError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

/**
 * Spec 1702 — a failing Indeed request is a diagnostic, never a silent empty result.
 */
describe('Indeed diagnostics — Spec 1702', () => {
  describe('graphqlErrorDetail / graphqlErrorCode', () => {
    it('reads the first error and its code', () => {
      expect(graphqlErrorDetail(VALIDATION_ERROR)).toBe(
        'Cannot query field "dateOnSite" on type "Job". [GRAPHQL_VALIDATION_FAILED]',
      );
      expect(graphqlErrorCode(VALIDATION_ERROR)).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('reads a JSON string body too', () => {
      expect(graphqlErrorCode(JSON.stringify(CSRF_ERROR))).toBe('CSRF_ERROR');
    });

    it('counts further errors and truncates to 300 characters', () => {
      const body = {
        errors: [{ message: 'x'.repeat(500) }, { message: 'second' }, { message: 'third' }],
      };
      const detail = graphqlErrorDetail(body)!;
      expect(detail.length).toBe(300);
      expect(detail.endsWith('...')).toBe(true);
      expect(graphqlErrorDetail({ errors: [{ message: 'a' }, { message: 'b' }] })).toBe('a (+1 more)');
    });

    it('is null when there are no errors', () => {
      for (const body of [null, undefined, '', 'plain text', WAF_BLOCK_HTML, {}, { errors: [] }, { data: {} }, '{bad json']) {
        expect(graphqlErrorDetail(body)).toBeNull();
      }
    });
  });

  describe('isBlockPage', () => {
    it('recognises the edge block page', () => {
      expect(isBlockPage(WAF_BLOCK_HTML)).toBe(true);
      expect(isBlockPage('<html><h1>Sorry, you have been blocked</h1></html>')).toBe(true);
      expect(isBlockPage('<title>Just a moment...</title>')).toBe(true);
    });

    it('does not flag JSON or ordinary text', () => {
      expect(isBlockPage(JSON.stringify(VALIDATION_ERROR))).toBe(false);
      expect(isBlockPage(VALIDATION_ERROR)).toBe(false);
      expect(isBlockPage('')).toBe(false);
      expect(isBlockPage('<html><body>Jobs</body></html>')).toBe(false);
    });
  });

  describe('diagnoseHttpError', () => {
    it('a 403 edge block page is blocked and says so', () => {
      const d = diagnoseHttpError(httpError(403, WAF_BLOCK_HTML));
      expect(d.reason).toBe('blocked');
      expect(d.detail).toContain('403');
      expect(d.detail).toContain('cloudflare');
    });

    it('a block page behind a non-403 status is still blocked', () => {
      expect(diagnoseHttpError(httpError(503, WAF_BLOCK_HTML)).reason).toBe('blocked');
    });

    it('a 400 validation error is bad_input and names the field', () => {
      const d = diagnoseHttpError(httpError(400, VALIDATION_ERROR));
      expect(d.reason).toBe('bad_input');
      expect(d.detail).toContain('dateOnSite');
      expect(d.detail).toContain('GRAPHQL_VALIDATION_FAILED');
    });

    it('a CSRF refusal is blocked', () => {
      expect(diagnoseHttpError(httpError(400, CSRF_ERROR)).reason).toBe('blocked');
    });

    it('adds the status when the message lacks it', () => {
      const err = Object.assign(new Error('boom'), { response: { status: 418, data: '' } });
      const d = diagnoseHttpError(err);
      expect(d.detail).toBe('boom (HTTP 418)');
      expect(d.reason).toBe('bad_input');
    });

    it('keeps the network classifications', () => {
      expect(
        diagnoseHttpError(Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' })).reason,
      ).toBe('timeout');
      expect(diagnoseHttpError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).reason).toBe(
        'fetch_error',
      );
      expect(diagnoseHttpError(httpError(502, '<html>Bad gateway</html>')).reason).toBe('fetch_error');
    });

    it('is total on odd thrown values', () => {
      expect(diagnoseHttpError(undefined).reason).toBe('unknown');
      expect(diagnoseHttpError('weird').detail).toBe('weird');
    });
  });

  describe('diagnoseGraphqlErrors', () => {
    it('maps the error codes', () => {
      expect(diagnoseGraphqlErrors(VALIDATION_ERROR)?.reason).toBe('bad_input');
      expect(diagnoseGraphqlErrors(CSRF_ERROR)?.reason).toBe('blocked');
      expect(
        diagnoseGraphqlErrors({ errors: [{ message: 'nope', extensions: { code: 'UNAUTHENTICATED' } }] })?.reason,
      ).toBe('blocked');
      const other = diagnoseGraphqlErrors({ errors: [{ message: 'Internal error' }] });
      expect(other?.reason).toBe('unknown');
      expect(other?.detail).toBe('GraphQL: Internal error');
    });

    it('is null without errors', () => {
      expect(diagnoseGraphqlErrors({ data: { jobSearch: null } })).toBeNull();
    });
  });

  describe('diagnoseMissingJobSearch', () => {
    it('a 200 block page is blocked', () => {
      expect(diagnoseMissingJobSearch(WAF_BLOCK_HTML).reason).toBe('blocked');
    });

    it('a 200 error envelope is classified by its code', () => {
      const d = diagnoseMissingJobSearch({ ...VALIDATION_ERROR, data: { jobSearch: null } });
      expect(d.reason).toBe('bad_input');
      expect(d.detail).toContain('dateOnSite');
    });

    it('anything else is unknown, never silent', () => {
      expect(diagnoseMissingJobSearch({ data: null })).toEqual(
        expect.objectContaining({ reason: 'unknown', detail: 'response had no data.jobSearch' }),
      );
      expect(diagnoseMissingJobSearch('<html>maintenance</html>').detail).toContain('non-JSON');
      expect(diagnoseMissingJobSearch(undefined).reason).toBe('unknown');
    });
  });
});
