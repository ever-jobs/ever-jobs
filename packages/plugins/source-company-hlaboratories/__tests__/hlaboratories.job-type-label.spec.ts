import { createHttpClient } from '@ever-jobs/common';
import { JobType, ScraperInputDto } from '@ever-jobs/models';
import { HlaboratoriesService } from '../src/hlaboratories.service';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(),
  };
});

/** Spec 1697: the new members get their own label instead of the "Full time" fallback. */
function role(id: number, employmentType: string) {
  return {
    id,
    title: `Role ${id}`,
    department: null,
    location: 'Austin, TX',
    employment_type: employmentType,
    remote: false,
    description: 'Build robots.',
    requirements: null,
    is_open: true,
    created_at: '2026-09-01T00:00:00',
  };
}

describe('HlaboratoriesService job-type labels (Spec 1697)', () => {
  let service: HlaboratoriesService;
  let getMock: jest.Mock;

  beforeEach(() => {
    service = new HlaboratoriesService();
    getMock = jest.fn();
    (createHttpClient as jest.Mock).mockReturnValue({ get: getMock });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['permanent', JobType.PERMANENT, 'Permanent'],
    ['apprenticeship', JobType.APPRENTICESHIP, 'Apprenticeship'],
    ['part_time', JobType.PART_TIME, 'Part time'],
    ['freelance', JobType.CONTRACT, 'Contract'],
    ['unknown_kind', JobType.FULL_TIME, 'Full time'],
  ])('maps employment_type %s', async (employmentType, member, label) => {
    getMock.mockResolvedValueOnce({ data: [role(1, employmentType)] });

    const response = await service.scrape(new ScraperInputDto({ resultsWanted: 5 }));

    expect(response.jobs).toHaveLength(1);
    expect(response.jobs[0].jobType).toEqual([member]);
    expect(response.jobs[0].employmentType).toBe(label);
  });
});
