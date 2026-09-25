import "reflect-metadata";
import { createHash } from "crypto";
import {
  DescriptionFormat,
  JobPostDto,
  JobType,
  ScraperInputDto,
  Site,
} from "@ever-jobs/models";

const mockGet = jest.fn();
jest.mock("@ever-jobs/common", () => {
  const actual = jest.requireActual("@ever-jobs/common");
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { RipplingService } from "../src/rippling.service";
import { RipplingJob } from "../src/rippling.types";

function uuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function job(seed: string, title = `Role ${seed}`): RipplingJob {
  const id = uuid(seed);
  return {
    uuid: id,
    title,
    companyName: "Boom Supersonic",
    url: `https://ats.rippling.com/boom-supersonic/jobs/${id}`,
    locations: [{ city: "Centennial", state: "CO", country: "US" }],
    description: { role: `Description for ${title}` },
  };
}

function page(items: RipplingJob[]): string {
  return pageWithQueries([items]);
}

function pageWithQueries(itemArrays: unknown[][]): string {
  return `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        pageProps: {
          dehydratedState: {
            queries: itemArrays.map((items) => ({
              state: { data: { items } },
            })),
          },
        },
      },
    },
  )}</script>`;
}

describe("RipplingService pagination", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: {} });
  });

  it("collects unique jobs across zero-based pages until exhaustion", async () => {
    mockGet
      .mockResolvedValueOnce({ data: page([job("a"), job("b")]) })
      .mockResolvedValueOnce({ data: page([job("c")]) })
      .mockResolvedValueOnce({ data: page([]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      siteType: [Site.RIPPLING],
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs.map((item) => item.atsId)).toEqual([
      uuid("a"),
      uuid("b"),
      uuid("c"),
    ]);
    expect(
      mockGet.mock.calls
        .map((call) => call[0])
        .filter((url) => url.includes("jobs?page=")),
    ).toEqual([
      "https://ats.rippling.com/boom-supersonic/jobs?page=0&jobBoardSlug=boom-supersonic",
      "https://ats.rippling.com/boom-supersonic/jobs?page=1&jobBoardSlug=boom-supersonic",
      "https://ats.rippling.com/boom-supersonic/jobs?page=2&jobBoardSlug=boom-supersonic",
    ]);
  });

  it("stops requesting pages as soon as resultsWanted is satisfied", async () => {
    mockGet.mockResolvedValueOnce({ data: page([job("a"), job("b")]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].atsId).toBe(uuid("a"));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("fetches a missing description from the public detail endpoint", async () => {
    const listed = job("detail", "Detailed Role");
    delete listed.description;
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockResolvedValueOnce({
        data: {
          description: {
            company: "<p>Company <strong>introduction</strong></p>",
            role: "<h2>Role details</h2><p>Contact jobs@boom.test</p>",
          },
          applyUrl:
            "https://ats.rippling.com/boom-supersonic/jobs/detail/apply",
        },
      });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
      descriptionFormat: DescriptionFormat.PLAIN,
    } as ScraperInputDto);

    expect(result.jobs[0]).toMatchObject({
      description:
        "Company introduction\n\nRole details\nContact jobs@boom.test",
      emails: ["jobs@boom.test"],
      applyUrl: "https://ats.rippling.com/boom-supersonic/jobs/detail/apply",
    });
    expect(mockGet.mock.calls[1][0]).toBe(
      `https://ats.rippling.com/api/v2/board/boom-supersonic/jobs/${uuid("detail")}`,
    );
  });

  it("prefers authoritative Boom detail identity, timestamp, and employment type", async () => {
    const listed = job("authoritative", "Authoritative Role");
    listed.createdOn = "2025-09-29T10:00:00Z";
    listed.employmentType = { label: "Old list value" };
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockResolvedValueOnce({
        data: {
          companyName: "Boom Technology, Inc.",
          createdOn: "2025-09-30T14:03:21.450000-07:00",
          employmentType: { label: "SALARIED_FT" },
        },
      });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
    } as ScraperInputDto);

    expect(result.jobs[0]).toMatchObject({
      companyName: "Boom Technology, Inc.",
      datePosted: "2025-09-30T14:03:21.450000-07:00",
      employmentType: "SALARIED_FT",
      description: "Description for Authoritative Role",
    });
    expect(mockGet.mock.calls[1][0]).toBe(
      `https://ats.rippling.com/api/v2/board/boom-supersonic/jobs/${uuid("authoritative")}`,
    );
  });

  it.each([
    [
      DescriptionFormat.HTML,
      "<p>Company <strong>intro</strong></p>\n\n<h2>Role</h2>",
    ],
    [DescriptionFormat.MARKDOWN, "Company **intro**\n\nRole\n----"],
    [DescriptionFormat.PLAIN, "Company intro\n\nRole"],
  ])("formats detail HTML as %s", async (descriptionFormat, expected) => {
    const listed = job(`format-${descriptionFormat}`);
    delete listed.description;
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockResolvedValueOnce({
        data: {
          description: {
            company: "<p>Company <strong>intro</strong></p>",
            role: "<h2>Role</h2>",
          },
        },
      });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
      descriptionFormat,
    } as ScraperInputDto);

    expect(result.jobs[0].description).toBe(expected);
  });

  it("keeps a valid list job when its detail request fails", async () => {
    const listed = job("detail-failure");
    delete listed.description;
    listed.createdOn = "2025-09-30T14:03:21.450000-07:00";
    listed.employmentType = { label: "SALARIED_FT" };
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockRejectedValueOnce(new Error("HTTP 503"));

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].description).toBeNull();
    expect(result.jobs[0]).toMatchObject({
      companyName: "Boom Supersonic",
      datePosted: "2025-09-30T14:03:21.450000-07:00",
      employmentType: "SALARIED_FT",
    });
  });

  it("bounds detail enrichment to five simultaneous requests", async () => {
    const listed = Array.from({ length: 6 }, (_value, index) => {
      const item = job(`concurrency-${index}`);
      delete item.description;
      return item;
    });
    let active = 0;
    let maximumActive = 0;
    mockGet
      .mockResolvedValueOnce({ data: page(listed) })
      .mockImplementation(async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return { data: { description: { role: "<p>Detailed role</p>" } } };
      });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 6,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(6);
    expect(maximumActive).toBe(5);
    expect(mockGet).toHaveBeenCalledTimes(7);
  });

  it("stops when an out-of-range page repeats existing source IDs", async () => {
    mockGet
      .mockResolvedValueOnce({ data: page([job("a"), job("b")]) })
      .mockResolvedValueOnce({ data: page([job("b"), job("a")]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs.map((item) => item.atsId)).toEqual([
      uuid("a"),
      uuid("b"),
    ]);
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  it("deduplicates repeated IDs while retaining unseen jobs on later pages", async () => {
    mockGet
      .mockResolvedValueOnce({ data: page([job("a"), job("b")]) })
      .mockResolvedValueOnce({ data: page([job("b"), job("c")]) })
      .mockResolvedValueOnce({ data: page([]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs.map((item) => item.atsId)).toEqual([
      uuid("a"),
      uuid("b"),
      uuid("c"),
    ]);
  });

  it("returns partial results when a later page fails", async () => {
    mockGet
      .mockResolvedValueOnce({ data: page([job("a"), job("b")]) })
      .mockRejectedValueOnce(new Error("HTTP 500"));

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs.map((item) => item.atsId)).toEqual([
      uuid("a"),
      uuid("b"),
    ]);
  });

  it("does not impose a 100-job cap", async () => {
    const jobs = Array.from({ length: 125 }, (_value, index) =>
      job(`job-${index}`),
    );
    mockGet
      .mockResolvedValueOnce({ data: page(jobs) })
      .mockResolvedValueOnce({ data: page([]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(125);
  });

  it("rejects filter items and selects the strict job-shaped query", async () => {
    const bogusItems = [
      { name: "Centennial, CO" },
      { id: uuid("filter"), name: "Engineering" },
    ];
    mockGet
      .mockResolvedValueOnce({
        data: pageWithQueries([bogusItems, [job("real", "Real Engineer")]]),
      })
      .mockResolvedValueOnce({ data: page([]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      id: `rippling-${uuid("real")}`,
      atsId: uuid("real"),
      title: "Real Engineer",
      companyUrl: "https://ats.rippling.com/boom-supersonic/jobs",
    });
    expect(result.jobs[0].jobUrl).not.toContain("undefined");
  });

  it("returns no rows when dehydrated items contain only filter data", async () => {
    mockGet.mockResolvedValueOnce({
      data: pageWithQueries([[{ name: "Centennial, CO" }]]),
    });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs).toEqual([]);
  });

  it("returns no jobs without a slug or when resultsWanted is zero", async () => {
    await expect(
      new RipplingService().scrape({ resultsWanted: 10 } as ScraperInputDto),
    ).resolves.toEqual({ jobs: [] });
    await expect(
      new RipplingService().scrape({
        companySlug: "boom-supersonic",
        resultsWanted: 0,
      } as ScraperInputDto),
    ).resolves.toEqual({ jobs: [] });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("normalizes mapped types and preserves only unmapped raw labels", async () => {
    const mapped = job("mapped-type");
    mapped.employmentType = { label: "Full-time" };
    mapped.applyUrl = mapped.url;
    mapped.locations = [
      { name: "Centennial Campus", stateCode: "CO", countryCode: "US" },
    ];
    const unmapped = job("unmapped-type");
    unmapped.employmentType = { label: "Seasonal specialist" };
    unmapped.locations = [];
    unmapped.workLocations = ["Remote - United States"];

    mockGet
      .mockResolvedValueOnce({ data: page([mapped, unmapped]) })
      .mockResolvedValueOnce({ data: page([]) });

    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs[0]).toMatchObject({
      jobType: [JobType.FULL_TIME],
      employmentType: "Full-time",
      location: {
        state: "CO",
        country: "United States",
      },
      locations: [
        { name: "Centennial Campus", state: "CO", country: "United States" },
      ],
    });
    expect(result.jobs[0].location?.city).toBeFalsy();
    expect(result.jobs[0]).not.toHaveProperty("applyUrl");
    expect(result.jobs[1]).toMatchObject({
      employmentType: "Seasonal specialist",
      location: { country: "United States" },
      isRemote: true,
    });
    expect(result.jobs[1]).not.toHaveProperty("jobType");
  });
});

describe("RipplingService structured locations (Spec 5119)", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: {} });
  });

  async function scrapeOne(listed: RipplingJob): Promise<JobPostDto> {
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockResolvedValueOnce({ data: page([]) });
    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
    } as ScraperInputDto);
    return result.jobs[0];
  }

  it("keeps each structured entry's own country instead of re-parsing labels", async () => {
    const listed = job("per-site-country");
    listed.locations = [
      { name: "Brisbane HQ", city: "Brisbane", stateCode: "CA", countryCode: "US" },
      { name: "Berlin Office", city: "Berlin", countryCode: "DE" },
    ];

    const post = await scrapeOne(listed);

    expect(post.locations).toEqual([
      { name: "Brisbane HQ", city: "Brisbane", state: "CA", country: "United States" },
      { name: "Berlin Office", city: "Berlin", state: null, country: "Germany" },
    ]);
    // merged view: structured join, country omitted when sites disagree
    expect(post.location).toMatchObject({
      city: "Brisbane, CA; Berlin, Germany",
    });
    expect(post.location?.country).toBeFalsy();
  });

  it("consumes remote-marker names as a signal and drops them from locations", async () => {
    const listed = job("remote-marker");
    listed.locations = [
      { name: "Remote (US)", workplaceType: "REMOTE" },
      { city: "Denver", stateCode: "CO", countryCode: "US" },
    ];

    const post = await scrapeOne(listed);

    expect(post.isRemote).toBe(true);
    expect(post.workFromHomeType).toBe("Remote");
    expect(post.locations).toEqual([
      { name: null, city: "Denver", state: "CO", country: "United States" },
    ]);
    expect(post.location?.city).toBe("Denver");
  });

  it("keeps a differing hiring-entity name but not one equal to companyName", async () => {
    const listed = job("entity-names");
    listed.companyName = "Boom Supersonic";
    listed.locations = [
      { city: "Centennial", stateCode: "CO", countryCode: "US" },
      { name: "Boom Supersonic" },
      { name: "Boom Technology, Inc." },
    ];

    const post = await scrapeOne(listed);

    expect(post.locations).toEqual([
      { name: null, city: "Centennial", state: "CO", country: "United States" },
      { name: "Boom Technology, Inc." },
    ]);
    expect(post.location?.city).toBe("Centennial");
  });

  it("uses workLocations and parseable pay-band labels only as fallback", async () => {
    const listed = job("fallback");
    listed.locations = [];
    listed.workLocations = ["Austin, TX"];
    listed.payRangeDetails = [
      {
        location: "Manager",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 100000,
        rangeEnd: 120000,
      },
      {
        location: "Sandy, UT",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 90000,
        rangeEnd: 110000,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.locations).toEqual([
      expect.objectContaining({ city: "Austin", state: "TX" }),
      expect.objectContaining({ city: "Sandy", state: "UT" }),
    ]);
    expect(post.location?.city).toBe("Austin, TX; Sandy, UT");
  });

  it("ignores free-text fallbacks when structured sites exist", async () => {
    const listed = job("structured-wins-location");
    listed.locations = [{ city: "Denver", stateCode: "CO", countryCode: "US" }];
    listed.workLocations = ["Bogus, ZZ"];
    listed.payRangeDetails = [
      {
        location: "Sandy, UT",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 1,
        rangeEnd: 2,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.locations).toEqual([
      { name: null, city: "Denver", state: "CO", country: "United States" },
    ]);
    expect(post.location?.city).toBe("Denver");
  });

  it("reads payRangeDetails.isRemote as a remote signal", async () => {
    const listed = job("pay-band-remote");
    listed.locations = [{ city: "Denver", stateCode: "CO", countryCode: "US" }];
    listed.payRangeDetails = [
      {
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 1,
        rangeEnd: 2,
        isRemote: true,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.isRemote).toBe(true);
  });
});

describe("RipplingService compensation and work mode", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: {} });
  });

  async function scrapeOne(listed: RipplingJob): Promise<JobPostDto> {
    mockGet
      .mockResolvedValueOnce({ data: page([listed]) })
      .mockResolvedValueOnce({ data: page([]) });
    const result = await new RipplingService().scrape({
      companySlug: "boom-supersonic",
      resultsWanted: 1,
    } as ScraperInputDto);
    return result.jobs[0];
  }

  it("maps a single structured pay band without a salarySource", async () => {
    const listed = job("single-band");
    listed.payRangeDetails = [
      {
        location: "Centennial, CO",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 109000,
        rangeEnd: 137000,
        isRemote: false,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      interval: "yearly",
      minAmount: 109000,
      maxAmount: 137000,
      currency: "USD",
    });
    expect(post).not.toHaveProperty("salarySource");
  });

  it("honors an hourly frequency", async () => {
    const listed = job("hourly-band");
    listed.payRangeDetails = [
      {
        location: "Centennial, CO",
        currency: "USD",
        frequency: "HOUR",
        rangeStart: 39,
        rangeEnd: 50,
        isRemote: false,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      interval: "hourly",
      minAmount: 39,
      maxAmount: 50,
    });
  });

  it("collapses distinct pay bands into a min-max envelope with per-band salarySource", async () => {
    const listed = job("distinct-bands");
    listed.payRangeDetails = [
      {
        location: "Oakland, CA",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 130000,
        rangeEnd: 200000,
        isRemote: false,
      },
      {
        location: "Sandy, UT",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 115000,
        rangeEnd: 155000,
        isRemote: false,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      interval: "yearly",
      minAmount: 115000,
      maxAmount: 200000,
      currency: "USD",
    });
    expect(post.salarySource).toBe(
      "Oakland, CA 130,000\u2013200,000; Sandy, UT 115,000\u2013155,000",
    );
  });

  it("folds three+ bands and ignores a mismatched-currency band (Spec 5019)", async () => {
    const listed = job("three-bands");
    listed.payRangeDetails = [
      {
        location: "San Francisco, CA",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 180000,
        rangeEnd: 220000,
        isRemote: false,
      },
      {
        location: "New York, NY",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 170000,
        rangeEnd: 210000,
        isRemote: false,
      },
      {
        location: "Remote, US",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 150000,
        rangeEnd: 190000,
        isRemote: true,
      },
      {
        location: "London, UK",
        currency: "GBP",
        frequency: "YEAR",
        rangeStart: 120000,
        rangeEnd: 240000,
        isRemote: false,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      interval: "yearly",
      minAmount: 150000,
      maxAmount: 220000,
      currency: "USD",
    });
  });

  it("does not emit salarySource when multiple bands share an identical range", async () => {
    const listed = job("identical-bands");
    listed.payRangeDetails = [
      {
        location: "Mytra, Inc.",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 140000,
        rangeEnd: 160000,
        isRemote: false,
      },
      {
        location: "Remote",
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 140000,
        rangeEnd: 160000,
        isRemote: true,
      },
    ];

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      minAmount: 140000,
      maxAmount: 160000,
    });
    expect(post).not.toHaveProperty("salarySource");
  });

  it("falls back to parsing the description text when no structured pay range exists", async () => {
    const listed = job("text-fallback");
    listed.payRangeDetails = [];
    listed.description = {
      role: "<p>Base Salary Range: $109,000 - $137,000 per year.</p>",
    };

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      interval: "yearly",
      minAmount: 109000,
      maxAmount: 137000,
      currency: "USD",
    });
    expect(post).not.toHaveProperty("salarySource");
  });

  it("prefers structured compensation over description text", async () => {
    const listed = job("structured-wins");
    listed.payRangeDetails = [
      {
        currency: "USD",
        frequency: "YEAR",
        rangeStart: 200000,
        rangeEnd: 250000,
      },
    ];
    listed.description = {
      role: "<p>Base Salary Range: $109,000 - $137,000 per year.</p>",
    };

    const post = await scrapeOne(listed);

    expect(post.compensation).toMatchObject({
      minAmount: 200000,
      maxAmount: 250000,
    });
  });

  it("derives workFromHomeType from a hybrid location workplaceType", async () => {
    const listed = job("hybrid");
    listed.locations = [
      { city: "Centennial", state: "CO", country: "US", workplaceType: "HYBRID" },
    ];

    const post = await scrapeOne(listed);

    expect(post.workFromHomeType).toBe("Hybrid");
    expect(post.isRemote).toBe(false);
  });

  it("marks a remote location workplaceType as remote", async () => {
    const listed = job("remote");
    listed.locations = [
      { name: "Remote", country: "US", workplaceType: "REMOTE" },
    ];

    const post = await scrapeOne(listed);

    expect(post.workFromHomeType).toBe("Remote");
    expect(post.isRemote).toBe(true);
  });

  it("joins multiple structured locations through the shared parser", async () => {
    const listed = job("multi-location");
    listed.locations = [
      { city: "Oakland", state: "CA", country: "US" },
      { city: "Sandy", state: "UT", country: "US" },
    ];

    const post = await scrapeOne(listed);

    expect(post.location).toMatchObject({
      city: "Oakland, CA; Sandy, UT",
      country: "United States",
    });
  });
});
