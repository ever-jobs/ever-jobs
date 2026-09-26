/**
 * Live drift detector for the shared job-type vocabulary (Spec 1697).
 *
 * One request per run: a facet-only query (`hitsPerPage: 0`) against the public French job
 * index, asking for the `contract_type` facet. Every contract token the board uses must either
 * resolve through `getJobTypeFromString(key, { locale: 'fr' })` or be listed in
 * KNOWN_UNMAPPED. A new contract token on the board turns this red, which is the signal to extend
 * `JOB_TYPE_ALIASES`.
 *
 * Sends an honest, identifying User-Agent and no retries. An outage (transport error, non-200,
 * or an empty facet map) is logged and tolerated, like the sibling `wttj.e2e-spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { createHttpClient } from '@ever-jobs/common';
import { getJobTypeFromString } from '@ever-jobs/models';
import { WTTJ_HEADERS, wttjAlgoliaQueryUrl } from '../src/wttj.constants';

const HONEST_USER_AGENT = 'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/** French index; its facet keys are the board's contract vocabulary. */
const FRENCH_INDEX = 'wttj_jobs_production_fr';

/**
 * Contract tokens deliberately left unmapped in core: an international volunteer-graduate
 * programme, a graduate programme and a rare single-row token. A source can map them locally.
 */
const KNOWN_UNMAPPED = ['vie', 'graduate_program', 'idv'];

describe('WelcomeToTheJungle contract vocabulary (live drift, Spec 1697)', () => {
  const logger = new Logger('WttjContractVocabularyE2E');

  it('every contract_type facet key resolves or is known-unmapped', async () => {
    const client = createHttpClient({ userAgent: HONEST_USER_AGENT, timeout: 15, retries: 0 });

    let facets: Record<string, number> | undefined;
    try {
      const response = await client.post<{ facets?: Record<string, Record<string, number>> }>(
        wttjAlgoliaQueryUrl(FRENCH_INDEX),
        { query: '', hitsPerPage: 0, facets: ['contract_type'] },
        { headers: { ...WTTJ_HEADERS, 'User-Agent': HONEST_USER_AGENT } },
      );
      if (response.status !== 200) {
        logger.warn(`Skipping drift check: HTTP ${response.status}`);
        return;
      }
      facets = response.data?.facets?.contract_type;
    } catch (error: unknown) {
      logger.warn(`Skipping drift check: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const keys = Object.keys(facets ?? {});
    if (keys.length === 0) {
      logger.warn('Skipping drift check: empty contract_type facet map');
      return;
    }

    const unresolved = keys.filter(
      (key) => !KNOWN_UNMAPPED.includes(key) && getJobTypeFromString(key, { locale: 'fr' }) === null,
    );
    expect(unresolved).toEqual([]);
    // The dominant bucket must still be there, or the facet itself has drifted.
    expect(keys).toContain('full_time');
  }, 30000);
});
