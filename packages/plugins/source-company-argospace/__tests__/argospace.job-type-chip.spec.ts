import { createHttpClient } from '@ever-jobs/common';
import { JobType, ScraperInputDto } from '@ever-jobs/models';
import { ArgospaceService } from '../src/argospace.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

/**
 * Spec 1697: the specification chips are recognised by resolving them as whole labels, so
 * a "Permanent" or "Apprenticeship" chip now names its own member. Synthetic pages, shaped
 * like the live markup the plugin parses.
 */
const careersHtml = `<html><body><div class="careers-list-2"><div class="careers-item-2">
  <a class="career-box" href="/careers/test-engineer"><h2 class="jobtitletxt">Test Engineer</h2></a>
</div></div></body></html>`;

function detailHtml(chips: string[]): string {
  const specs = chips.map((chip) => `<div class="spec_txt">${chip}</div>`).join('');
  return `<html><body>
<h1 class="heading-6">Test Engineer</h1>
<div class="spec_div"><div class="spec_txt">Specifications</div>${specs}</div>
<div class="w-richtext"><p>Build and test flight hardware.</p></div>
</body></html>`;
}

describe('ArgospaceService employment-type chips (Spec 1697)', () => {
  let service: ArgospaceService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new ArgospaceService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  async function scrapeWith(chips: string[]) {
    getMock
      .mockResolvedValueOnce({ data: careersHtml })
      .mockResolvedValueOnce({ data: detailHtml(chips) });
    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 5 }));
    expect(response.jobs).toHaveLength(1);
    return response.jobs[0];
  }

  it.each([
    ['Permanent', JobType.PERMANENT, 'Permanent'],
    ['Apprenticeship', JobType.APPRENTICESHIP, 'Apprenticeship'],
    ['Full-Time', JobType.FULL_TIME, 'Full-Time'],
  ])('recognises the %s chip', async (chip, member, label) => {
    const job = await scrapeWith(['Long Beach, CA', chip, '$90,000 - $120,000']);

    expect(job.jobType).toEqual([member]);
    expect(job.employmentType).toBe(label);
  });

  it('has no job type when no chip names one', async () => {
    const job = await scrapeWith(['Long Beach, CA', '$90,000 - $120,000']);

    expect(job.jobType).toBeNull();
    expect(job.employmentType).toBeNull();
  });
});
