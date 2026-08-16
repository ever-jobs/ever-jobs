import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { JobType, ScraperInputDto, Site } from "@ever-jobs/models";

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

import { AnatarModule, AnatarService } from "../src";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
const CAREERS_HTML = fs.readFileSync(
  path.join(FIXTURE_DIR, "careers.html"),
  "utf8",
);
const FALLBACK_HTML = fs.readFileSync(
  path.join(FIXTURE_DIR, "careers-dom-fallback.html"),
  "utf8",
);

describe("AnatarService", () => {
  beforeEach(() => mockGet.mockReset());

  it("resolves through its module and exports the site value", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AnatarModule],
    }).compile();

    expect(moduleRef.get(AnatarService)).toBeInstanceOf(AnatarService);
    expect(Site.ANATAR).toBe("anatar");
    await moduleRef.close();
  });

  it("maps all seven Flight positions and stable deep links", async () => {
    mockGet.mockResolvedValueOnce({ data: CAREERS_HTML });
    const result = await new AnatarService().scrape({
      resultsWanted: 9999,
    } as ScraperInputDto);

    expect(result.jobs).toHaveLength(7);
    const executive = result.jobs.find((job) =>
      job.title.startsWith("Executive Assistant"),
    );
    expect(executive).toMatchObject({
      id: "anatar-916b7750-cb60-4998-b126-a35a98fff6cd",
      site: Site.ANATAR,
      companyName: "Anatar",
      companyUrl: "https://anatar.com/careers",
      jobUrl: "https://anatar.com/careers?id=916b7750",
      jobType: [JobType.FULL_TIME],
      isRemote: false,
      datePosted: null,
      emails: null,
    });
    expect(executive).not.toHaveProperty("applyUrl");
    expect(executive).not.toHaveProperty("atsId");
    expect(executive).not.toHaveProperty("atsType");
    expect(executive).not.toHaveProperty("companyUrlDirect");
    expect(executive).not.toHaveProperty("compensation");
    expect(executive).not.toHaveProperty("employmentType");
    expect(executive?.location).toMatchObject({ city: "Atlanta", state: "GA" });

    const cfo = result.jobs.find((job) => job.title === "Fractional CFO");
    expect(cfo?.jobUrl).toBe("https://anatar.com/careers?id=1ed586e4");
    expect(cfo?.jobType).toEqual([JobType.PART_TIME]);
    expect(cfo?.isRemote).toBe(true);
    expect(cfo?.location).toMatchObject({ city: "Atlanta", state: "GA" });
    expect(cfo?.workFromHomeType).toBe("Remote");

    const defense = result.jobs.find(
      (job) => job.title === "Technical Designer (Defense)",
    );
    expect(defense?.department).toBe("Product & Development");
    expect(defense?.jobType).toEqual([JobType.CONTRACT]);
    expect(defense?.isRemote).toBe(true);
    expect(defense?.location).toMatchObject({ city: "Atlanta", state: "GA" });
    expect(defense?.workFromHomeType).toBe("Hybrid or Remote");

    const sales = result.jobs.find((job) => job.department === "Merchandising");
    expect(sales?.title).toBe("Sales Representative – Merchandising (Atlanta)");

    const software = result.jobs.find(
      (job) => job.title === "Software Engineer (Full Stack)",
    );
    expect(software?.location).toMatchObject({ city: "Atlanta", state: "GA" });
    expect(software?.workFromHomeType).toBe("Remote");
    expect(software?.description).toContain("supply-chain integrations");
  });

  it("filters by title, department, description, location, remote, and job type", async () => {
    const service = new AnatarService();
    const cases: Array<[Partial<ScraperInputDto>, string]> = [
      [{ searchTerm: "fractional cfo" }, "Fractional CFO"],
      [{ searchTerm: "engineering" }, "Software Engineer (Full Stack)"],
      [{ searchTerm: "supply-chain" }, "Software Engineer (Full Stack)"],
      [{ location: "atlanta, ga" }, "Technical Designer (Defense)"],
      [{ jobType: JobType.PART_TIME }, "Fractional CFO"],
    ];

    for (const [input, expectedTitle] of cases) {
      mockGet.mockResolvedValueOnce({ data: CAREERS_HTML });
      const result = await service.scrape(input as ScraperInputDto);
      expect(result.jobs.map((job) => job.title)).toContain(expectedTitle);
    }

    mockGet.mockResolvedValueOnce({ data: CAREERS_HTML });
    const remote = await service.scrape({ isRemote: true } as ScraperInputDto);
    expect(remote.jobs).toHaveLength(3);
    expect(remote.jobs.every((job) => job.isRemote)).toBe(true);
  });

  it("applies offset after filtering and honors zero resultsWanted", async () => {
    mockGet.mockResolvedValueOnce({ data: CAREERS_HTML });
    const paged = await new AnatarService().scrape({
      searchTerm: "technical designer",
      offset: 1,
      resultsWanted: 1,
    } as ScraperInputDto);
    expect(paged.jobs).toHaveLength(1);
    expect(paged.jobs[0].title).toBe(
      "Technical Designer / Product Development Lead",
    );

    mockGet.mockResolvedValueOnce({ data: CAREERS_HTML });
    const empty = await new AnatarService().scrape({
      resultsWanted: 0,
    } as ScraperInputDto);
    expect(empty.jobs).toEqual([]);
  });

  it("uses semantic cards and deterministic IDs as a degraded fallback", async () => {
    mockGet.mockResolvedValueOnce({ data: FALLBACK_HTML });
    const first = await new AnatarService().scrape({} as ScraperInputDto);
    mockGet.mockResolvedValueOnce({ data: FALLBACK_HTML });
    const second = await new AnatarService().scrape({} as ScraperInputDto);

    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({
      title: "Fallback & Platform Engineer",
      department: "Engineering",
      jobType: [JobType.INTERNSHIP],
      isRemote: true,
      jobUrl: "https://anatar.com/careers#open-positions",
    });
    expect(first.jobs[0]).not.toHaveProperty("employmentType");
    expect(first.jobs[0]).not.toHaveProperty("applyUrl");
    expect(first.jobs[0]).not.toHaveProperty("atsId");
    expect(first.jobs[0].id).toMatch(/^anatar-fallback-[0-9a-f]{16}$/);
    expect(second.jobs[0].id).toBe(first.jobs[0].id);
  });

  it("does not combine rendered cards with valid primary data", async () => {
    const html = CAREERS_HTML.replace(
      '<section id="open-positions"></section>',
      FALLBACK_HTML.match(/<section[\s\S]*<\/section>/)?.[0] ?? "",
    );
    mockGet.mockResolvedValueOnce({ data: html });

    const result = await new AnatarService().scrape({
      resultsWanted: 9999,
    } as ScraperInputDto);
    expect(result.jobs).toHaveLength(7);
    expect(result.jobs.some((job) => job.title.startsWith("Fallback"))).toBe(
      false,
    );
  });

  it("treats an explicit empty positions array as a valid zero result", async () => {
    const html =
      '<section id="open-positions"><div><h3>Stale Card</h3><button>Apply Now</button></div></section>' +
      '<script>self.__next_f.push([1,"7:{\\"positions\\":[]}"])</script>';
    mockGet.mockResolvedValueOnce({ data: html });

    const result = await new AnatarService().scrape({} as ScraperInputDto);
    expect(result.jobs).toEqual([]);
  });

  it("does not impose a plugin-specific 100-job cap", async () => {
    const positions = Array.from({ length: 125 }, (_value, index) => ({
      id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, "0")}`,
      title: `Role ${index + 1}`,
      location: "Atlanta, GA",
      type: "Full-time",
    }));
    const flight = `7:${JSON.stringify({ positions })}`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;

    mockGet.mockResolvedValueOnce({ data: html });
    const all = await new AnatarService().scrape({
      resultsWanted: 9999,
    } as ScraperInputDto);
    expect(all.jobs).toHaveLength(125);

    mockGet.mockResolvedValueOnce({ data: html });
    const limited = await new AnatarService().scrape({
      resultsWanted: 101,
    } as ScraperInputDto);
    expect(limited.jobs).toHaveLength(101);
  });

  it("skips malformed and duplicate primary records", async () => {
    const payload = {
      positions: [
        { title: "" },
        {
          id: "916b7750-cb60-4998-b126-a35a98fff6cd",
          title: "Valid Role",
          location: "Atlanta, GA",
        },
        {
          id: "916b7750-cb60-4998-b126-a35a98fff6cd",
          title: "Duplicate Role",
        },
      ],
    };
    const flight = `7:${JSON.stringify(payload)}`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
    mockGet.mockResolvedValueOnce({ data: html });

    const result = await new AnatarService().scrape({} as ScraperInputDto);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe("Valid Role");
  });

  it("extracts emails and preserves only unmapped raw employment types", async () => {
    const flight = `7:${JSON.stringify({
      positions: [
        {
          id: "916b7750-cb60-4998-b126-a35a98fff6cd",
          title: "Executive Assistant / Chief of Staff",
          type: "Seasonal specialist",
          description: "Support Anatar's CEO. Contact careers@anatar.com.",
        },
      ],
    })}`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
    mockGet.mockResolvedValueOnce({ data: html });

    const result = await new AnatarService().scrape({} as ScraperInputDto);
    const executive = result.jobs.find((item) =>
      item.title.startsWith("Executive Assistant"),
    );

    expect(executive).toMatchObject({
      employmentType: "Seasonal specialist",
      emails: ["careers@anatar.com"],
    });
    expect(executive).not.toHaveProperty("jobType");
  });

  it("returns empty results with a diagnostic for transport failures", async () => {
    mockGet.mockRejectedValueOnce({ name: "TimeoutError" });
    const transport = await new AnatarService().scrape({} as ScraperInputDto);
    expect(transport.jobs).toEqual([]);
    expect(transport.diagnostics?.reason).toBe("timeout");

    mockGet.mockResolvedValueOnce({ data: { not: "html" } });
    const invalid = await new AnatarService().scrape({} as ScraperInputDto);
    expect(invalid.jobs).toEqual([]);
  });
});
