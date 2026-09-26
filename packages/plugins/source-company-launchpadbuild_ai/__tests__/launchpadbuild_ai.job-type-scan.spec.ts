import { createHttpClient } from '@ever-jobs/common';
import { JOB_TYPE_SCAN_MODE_ENV, JobType, ScraperInputDto } from '@ever-jobs/models';
import { LaunchpadbuildAiService } from '../src/launchpadbuild_ai.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

/**
 * Spec 1697: when no employment-type chip is present the plugin scans every word of the
 * summary / benefits / type sections, so prose-ambiguous words must not become job types.
 * Synthetic pages, shaped like the live job-listing markup the plugin parses.
 */
function careersHtml(employmentTerm = ''): string {
  const spec = employmentTerm
    ? `<div class="awsm-job-specification-job-type"><span class="awsm-job-specification-term">${employmentTerm}</span></div>`
    : '';
  return `<html><body><div class="awsm-job-listings awsm-lists">
  <div class="awsm-job-listing-item">
    <h2 class="awsm-job-post-title"><a href="https://www.launchpadbuild.ai/jobs/test-technician/">Test Technician</a></h2>
    ${spec}
  </div>
</div></body></html>`;
}

function detailHtml(sections: Record<string, string>): string {
  const body = Object.entries(sections)
    .map(([heading, text]) => `<h3>${heading}</h3><p>${text}</p>`)
    .join('\n');
  return `<html><body>
<h1 class="elementor-heading-title">Test Technician</h1>
<div class="awsm-job-entry-content entry-content">${body}</div>
</body></html>`;
}

const SUMMARY =
  'We are an early-stage company at the growth stage. Applicants must hold U.S. citizenship or ' +
  'permanent residency. This is not a temp or seasonal position, and there is no interim ' +
  'placement. Full time, with health cover and other perks.';

describe('LaunchpadbuildAiService job-type scan (Spec 1697)', () => {
  let service: LaunchpadbuildAiService;
  let getMock: jest.Mock;
  const savedMode = process.env[JOB_TYPE_SCAN_MODE_ENV];

  beforeEach(() => {
    service = new LaunchpadbuildAiService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
    delete process.env[JOB_TYPE_SCAN_MODE_ENV];
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (savedMode === undefined) delete process.env[JOB_TYPE_SCAN_MODE_ENV];
    else process.env[JOB_TYPE_SCAN_MODE_ENV] = savedMode;
  });

  async function scrapeWith(listHtml: string, pageHtml: string) {
    getMock.mockResolvedValueOnce({ data: listHtml }).mockResolvedValueOnce({ data: pageHtml });
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 5 }));
    expect(response.jobs).toHaveLength(1);
    return response.jobs[0];
  }

  it('ignores prose-ambiguous words in a scanned Summary section', async () => {
    const job = await scrapeWith(careersHtml(), detailHtml({ Summary: SUMMARY }));

    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.employmentType).toBe('Full time');
  });

  it('keeps the legacy word scan reachable with EVER_JOBS_JOB_TYPE_SCAN_MODE=label (control)', async () => {
    process.env[JOB_TYPE_SCAN_MODE_ENV] = 'label';

    const job = await scrapeWith(careersHtml(), detailHtml({ Summary: SUMMARY }));

    expect(job.jobType).toEqual(
      expect.arrayContaining([
        JobType.FULL_TIME,
        JobType.PERMANENT,
        JobType.TEMPORARY,
        JobType.OTHER,
      ]),
    );
  });

  it('resolves an Apprenticeship employment-type section', async () => {
    const job = await scrapeWith(
      careersHtml(),
      detailHtml({ 'Employment Type': 'Apprenticeship', Summary: 'Hands-on work.' }),
    );

    expect(job.jobType).toEqual([JobType.APPRENTICESHIP]);
    expect(job.employmentType).toBe('Apprenticeship');
  });

  it('trusts a whole employment-type chip in label mode ("Permanent")', async () => {
    const job = await scrapeWith(careersHtml('Permanent'), detailHtml({ Summary: 'Hands-on work.' }));

    expect(job.jobType).toEqual([JobType.PERMANENT]);
    expect(job.employmentType).toBe('Permanent');
  });
});
