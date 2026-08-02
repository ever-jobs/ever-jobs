import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      post: mockPost,
      setHeaders: jest.fn(),
    })),
  };
});

import { NotionService } from '../src/notion.service';

const ROOT_ID = '361cc3fe-052a-8109-8df8-d9d81147636d';
const ROLE1_ID = '377cc3fe-052a-8107-84c2-e6cbe245d292';
const ROLE2_ID = '377cc3fe-052a-81f1-8292-d4db0d90b3a9';
const CAREERS_URL = `https://fossil-surfboard-e82.notion.site/Careers-at-Stone-Power-${ROOT_ID.replace(/-/g, '')}`;

const dashless = (id: string) => id.replace(/-/g, '');

/** Build one block record in the flat `{ role, value }` envelope. */
function block(
  id: string,
  type: string,
  title: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    role: 'reader',
    value: {
      id,
      type,
      ...(title !== null ? { properties: { title: [[title]] } } : {}),
      ...extra,
    },
  };
}

/** The root board page: intro text + heading + two role sub-pages. */
function rootChunk() {
  const textId = '11111111-1111-1111-1111-111111111111';
  const headingId = '22222222-2222-2222-2222-222222222222';
  return {
    recordMap: {
      block: {
        [ROOT_ID]: block(ROOT_ID, 'page', 'Careers at Stone Power', {
          content: [textId, headingId, ROLE1_ID, ROLE2_ID],
        }),
        [textId]: block(textId, 'text', 'Join the team building turbines'),
        [headingId]: block(headingId, 'sub_header', 'Current Openings'),
        [ROLE1_ID]: block(ROLE1_ID, 'page', 'Head of Turbomachinery'),
        [ROLE2_ID]: block(ROLE2_ID, 'page', 'General Application'),
      },
    },
  };
}

/** A fully-templated role sub-page (header dup, Location line, sections). */
function role1Chunk() {
  const hdr = 'aaaaaaaa-0000-0000-0000-000000000001';
  const loc = 'aaaaaaaa-0000-0000-0000-000000000002';
  const about = 'aaaaaaaa-0000-0000-0000-000000000003';
  const bullet = 'aaaaaaaa-0000-0000-0000-000000000004';
  const apply = 'aaaaaaaa-0000-0000-0000-000000000005';
  return {
    recordMap: {
      block: {
        [ROLE1_ID]: block(ROLE1_ID, 'page', 'Head of Turbomachinery', {
          content: [hdr, loc, about, bullet, apply],
          created_time: 1780710149216,
        }),
        [hdr]: block(hdr, 'header', 'Head of Turbomachinery'),
        [loc]: block(
          loc,
          'text',
          'Location: Los Angeles, CA (On-Site)\nTeam: Engineering\nReports to: CEO',
        ),
        [about]: block(about, 'sub_header', 'About Stone Power'),
        [bullet]: block(bullet, 'bulleted_list', 'Own rotating machinery'),
        [apply]: block(
          apply,
          'text',
          'Email careers@stonepower.us with your resume',
        ),
      },
    },
  };
}

/** A bare role sub-page: no Location line (the catch-all application). */
function role2Chunk() {
  const body = 'bbbbbbbb-0000-0000-0000-000000000001';
  return {
    recordMap: {
      block: {
        [ROLE2_ID]: block(ROLE2_ID, 'page', 'General Application', {
          content: [body],
          created_time: 1780710149216,
        }),
        [body]: block(body, 'text', 'Do not see your role? Email us.'),
      },
    },
  };
}

/** Route mocked POSTs to the right page chunk by the requested page id. */
function routeChunks(chunks: Record<string, unknown>) {
  mockPost.mockImplementation(async (_url: string, data: any) => {
    const id = dashless(String(data?.page?.id ?? ''));
    return { data: chunks[id] ?? { recordMap: { block: {} } } };
  });
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('NotionService', () => {
  beforeEach(() => mockPost.mockReset());

  it('scrapes child-page roles with fields from the page-id-keyed API', async () => {
    routeChunks({
      [dashless(ROOT_ID)]: rootChunk(),
      [dashless(ROLE1_ID)]: role1Chunk(),
      [dashless(ROLE2_ID)]: role2Chunk(),
    });

    const service = new NotionService();
    const result = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID), companyUrl: CAREERS_URL }),
    );

    expect(result.jobs).toHaveLength(2);

    const head = result.jobs.find((j) => j.title === 'Head of Turbomachinery')!;
    expect(head).toBeDefined();
    expect(head.site).toBe(Site.NOTION_PAGES);
    expect(head.companyName).toBe('Stone Power');
    expect(head.id).toBe(`notion-${dashless(ROLE1_ID)}`);
    // jobUrl keeps the notion.site subdomain from companyUrl
    expect(head.jobUrl).toBe(
      `https://fossil-surfboard-e82.notion.site/${dashless(ROLE1_ID)}`,
    );
    // location parsed from the labelled line; "(On-Site)" is not remote
    expect(head.location?.displayLocation()).toContain('Los Angeles');
    expect(head.location?.displayLocation()).not.toMatch(/on-?site/i);
    expect(head.isRemote).toBe(false);
    // description carries sections + bullets, drops the duplicated title header
    expect(head.description).toContain('### About Stone Power');
    expect(head.description).toContain('- Own rotating machinery');
    expect(head.description).not.toContain('## Head of Turbomachinery');
    // email apply: the address lives in `emails`; `applyUrl` is left unset
    expect(head.emails).toEqual(['careers@stonepower.us']);
    expect(head.applyUrl == null).toBe(true);
    expect(head.datePosted).toBe('2026-06-06');
  });

  it('includes roles with no Location line (null location, still listed)', async () => {
    routeChunks({
      [dashless(ROOT_ID)]: rootChunk(),
      [dashless(ROLE1_ID)]: role1Chunk(),
      [dashless(ROLE2_ID)]: role2Chunk(),
    });

    const service = new NotionService();
    const result = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID), companyUrl: CAREERS_URL }),
    );

    const gen = result.jobs.find((j) => j.title === 'General Application')!;
    expect(gen).toBeDefined();
    expect(gen.location).toBeNull();
    expect(gen.isRemote).toBeNull();
  });

  it('resolves the page id from a full notion URL and falls back to www.notion.so', async () => {
    routeChunks({
      [dashless(ROOT_ID)]: rootChunk(),
      [dashless(ROLE1_ID)]: role1Chunk(),
      [dashless(ROLE2_ID)]: role2Chunk(),
    });

    const service = new NotionService();
    // page id only via companySlug carrying the URL; no companyUrl subdomain
    const result = await service.scrape(inputFrom({ companySlug: CAREERS_URL }));

    const head = result.jobs.find((j) => j.title === 'Head of Turbomachinery')!;
    expect(head.jobUrl).toBe(`https://www.notion.so/${dashless(ROLE1_ID)}`);
  });

  it('parses the nested { value: { role, value } } envelope', async () => {
    const nested = {
      recordMap: {
        block: {
          [dashless(ROOT_ID)]: undefined as unknown,
          [ROOT_ID]: {
            value: {
              role: 'reader',
              value: {
                id: ROOT_ID,
                type: 'page',
                properties: { title: [['Careers at Stone Power']] },
                content: [ROLE1_ID],
              },
            },
          },
          [ROLE1_ID]: {
            value: {
              role: 'reader',
              value: {
                id: ROLE1_ID,
                type: 'page',
                properties: { title: [['Head of Turbomachinery']] },
              },
            },
          },
        },
      },
    };
    routeChunks({
      [dashless(ROOT_ID)]: nested,
      [dashless(ROLE1_ID)]: role1Chunk(),
    });

    const service = new NotionService();
    const result = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID) }),
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe('Head of Turbomachinery');
  });

  it('returns empty when the root exposes no child-page roles', async () => {
    routeChunks({
      [dashless(ROOT_ID)]: {
        recordMap: {
          block: {
            [ROOT_ID]: block(ROOT_ID, 'page', 'Careers', { content: [] }),
          },
        },
      },
    });

    const service = new NotionService();
    const result = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID) }),
    );
    expect(result.jobs).toHaveLength(0);
  });

  it('returns empty when no Notion page id is present', async () => {
    const service = new NotionService();
    const result = await service.scrape(inputFrom({ companySlug: 'not-an-id' }));
    expect(result.jobs).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    routeChunks({
      [dashless(ROOT_ID)]: rootChunk(),
      [dashless(ROLE1_ID)]: role1Chunk(),
      [dashless(ROLE2_ID)]: role2Chunk(),
    });

    const service = new NotionService();
    const filtered = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID), searchTerm: 'Turbomachinery' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Head of Turbomachinery');

    const capped = await service.scrape(
      inputFrom({ companySlug: dashless(ROOT_ID), resultsWanted: 1 }),
    );
    expect(capped.jobs).toHaveLength(1);
  });
});
