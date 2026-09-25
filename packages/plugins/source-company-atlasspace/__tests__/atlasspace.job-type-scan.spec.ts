import { createHttpClient } from '@ever-jobs/common';
import { JOB_TYPE_SCAN_MODE_ENV, JobType, ScraperInputDto } from '@ever-jobs/models';
import { AtlasspaceService } from '../src/atlasspace.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

/**
 * Spec 1697: the job-type scan reads every word of the "Position Details"-style sections, so
 * prose-ambiguous words must not become job types. Synthetic pages, shaped like the live
 * Elementor markup the plugin parses.
 */
const careersHtml = `<html><body>
<div class="elementor-widget-heading"><h2 class="elementor-heading-title">Current Openings</h2></div>
<div class="elementor-widget-icon-list"><ul class="elementor-icon-list-items">
  <li class="elementor-icon-list-item"><a href="/test-engineer/"><span class="elementor-icon-list-text">Test Engineer</span></a></li>
</ul></div>
</body></html>`;

function detailHtml(positionDetails: string): string {
  return `<html><body>
<div class="elementor-widget-heading"><h2 class="elementor-heading-title">Test Engineer</h2></div>
<div class="elementor-widget-heading"><h4 class="elementor-heading-title">Position Details:</h4></div>
<div class="elementor-widget-text-editor"><div class="elementor-widget-container"><p>${positionDetails}</p></div></div>
<div class="elementor-widget-heading"><h4 class="elementor-heading-title">Location</h4></div>
<div class="elementor-widget-text-editor"><div class="elementor-widget-container"><p>Traverse City, MI</p></div></div>
</body></html>`;
}

const PROSE =
  'Full time role. You will join an early-stage team where each program is at a different stage ' +
  'of its lifecycle. U.S. citizenship or permanent residency is required. Temp-to-perm is not ' +
  'offered. Interim reviews happen quarterly, and you will take on scheduling and other duties.';

describe('AtlasspaceService job-type scan (Spec 1697)', () => {
  let service: AtlasspaceService;
  let getMock: jest.Mock;
  const savedMode = process.env[JOB_TYPE_SCAN_MODE_ENV];

  beforeEach(() => {
    service = new AtlasspaceService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
    delete process.env[JOB_TYPE_SCAN_MODE_ENV];
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (savedMode === undefined) delete process.env[JOB_TYPE_SCAN_MODE_ENV];
    else process.env[JOB_TYPE_SCAN_MODE_ENV] = savedMode;
  });

  async function scrapeWith(positionDetails: string) {
    getMock
      .mockResolvedValueOnce({ data: careersHtml })
      .mockResolvedValueOnce({ data: detailHtml(positionDetails) });
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 5 }));
    expect(response.jobs).toHaveLength(1);
    return response.jobs[0];
  }

  it('ignores prose-ambiguous words (stage, permanent, temp, interim, other)', async () => {
    const job = await scrapeWith(PROSE);

    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.employmentType).toBe('Full time');
  });

  it('keeps the legacy word scan reachable with EVER_JOBS_JOB_TYPE_SCAN_MODE=label (control)', async () => {
    process.env[JOB_TYPE_SCAN_MODE_ENV] = 'label';

    const job = await scrapeWith(PROSE);

    expect(job.jobType).toEqual(
      expect.arrayContaining([
        JobType.FULL_TIME,
        JobType.PERMANENT,
        JobType.TEMPORARY,
        JobType.OTHER,
      ]),
    );
    expect(job.jobType).not.toContain(JobType.INTERNSHIP);
  });

  it('labels the new members when an unambiguous word names them', async () => {
    const job = await scrapeWith('Apprenticeship programme, fixed term of 24 months.');

    expect(job.jobType).toEqual([JobType.APPRENTICESHIP, JobType.CONTRACT]);
    expect(job.employmentType).toBe('Apprenticeship, Contract');
  });
});
