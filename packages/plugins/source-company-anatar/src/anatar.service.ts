import { createHash } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import * as cheerio from "cheerio";
import { SourcePlugin } from "@ever-jobs/plugin";
import { classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  getJobTypeFromString,
  ScraperInputDto,
  Site,
} from "@ever-jobs/models";
import {
  createHttpClient,
  decodeHtmlEntities,
  extractEmails,
  htmlToPlainText,
  parseLocationText,
} from "@ever-jobs/common";
import {
  ANATAR_CAREERS_URL,
  ANATAR_DEFAULT_RESULTS,
  ANATAR_DEFAULT_TIMEOUT_SECONDS,
  ANATAR_FALLBACK_URL,
  ANATAR_MAX_FLIGHT_SCRIPTS,
  ANATAR_MAX_HTML_BYTES,
  ANATAR_MAX_POSITION_BYTES,
  ANATAR_MAX_RETRIES,
} from "./anatar.constants";
import { AnatarExtractionResult, AnatarPosition } from "./anatar.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

@SourcePlugin({
  site: Site.ANATAR,
  name: "Anatar",
  category: "company",
})
@Injectable()
export class AnatarService implements IScraper {
  private readonly logger = new Logger(AnatarService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const client = createHttpClient({
        ...input,
        requestTimeout: this.validPositiveNumber(input.requestTimeout)
          ? input.requestTimeout
          : ANATAR_DEFAULT_TIMEOUT_SECONDS,
        retries: Math.min(
          ANATAR_MAX_RETRIES,
          this.validNonNegativeNumber(input.retries)
            ? Math.floor(input.retries as number)
            : ANATAR_MAX_RETRIES,
        ),
      });

      const response = await client.get<string>(ANATAR_CAREERS_URL, {
        responseType: "text",
      });
      if (typeof response.data !== "string" || response.data.length === 0) {
        this.logger.warn("Anatar returned an empty or non-text response");
        return new JobResponseDto([]);
      }

      const html = this.boundHtml(response.data);
      const extracted = this.extractFlightPositions(html);
      let positions = extracted.candidates
        .map((candidate) => this.validatePosition(candidate))
        .filter((position): position is AnatarPosition => position !== null);

      if (
        !extracted.found ||
        (extracted.candidates.length > 0 && positions.length === 0)
      ) {
        positions = this.extractRenderedPositions(html);
      }

      if (!extracted.found && positions.length === 0) {
        this.logger.warn(
          "Anatar careers page did not contain a recognized job structure",
        );
      }

      const jobs = this.applyInput(this.mapAndDeduplicate(positions), input);
      this.logger.log(`Anatar: scraped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (error: unknown) {
      this.logger.error(`Anatar scrape failed (${this.safeErrorLabel(error)})`);
      return new JobResponseDto([], classifyScrapeError(error));
    }
  }

  private boundHtml(html: string): string {
    if (Buffer.byteLength(html, "utf8") <= ANATAR_MAX_HTML_BYTES) return html;
    return Buffer.from(html, "utf8")
      .subarray(0, ANATAR_MAX_HTML_BYTES)
      .toString("utf8");
  }

  /** Decode data strings from Next Flight pushes without executing page code. */
  private extractFlightPositions(html: string): AnatarExtractionResult {
    const $ = cheerio.load(html);
    const payloads: string[] = [];
    const scripts = $("script")
      .filter(
        (_index, element) =>
          $(element).html()?.includes("self.__next_f.push") ?? false,
      )
      .slice(0, ANATAR_MAX_FLIGHT_SCRIPTS);

    scripts.each((_index, element) => {
      const script = $(element).html() ?? "";
      for (const argument of this.extractPushArguments(script)) {
        try {
          const decoded: unknown = JSON.parse(argument);
          if (
            Array.isArray(decoded) &&
            decoded[0] === 1 &&
            typeof decoded[1] === "string"
          ) {
            payloads.push(decoded[1]);
          }
        } catch {
          // Ignore malformed pushes. Embedded JavaScript is never executed.
        }
      }
    });

    const payload = payloads.join("");
    let searchFrom = 0;
    while (searchFrom < payload.length) {
      const propertyIndex = payload.indexOf('"positions"', searchFrom);
      if (propertyIndex < 0) break;

      const colonIndex = payload.indexOf(
        ":",
        propertyIndex + '"positions"'.length,
      );
      if (colonIndex < 0) break;
      const arrayStart = this.findNextNonWhitespace(payload, colonIndex + 1);
      if (arrayStart >= 0 && payload[arrayStart] === "[") {
        const arrayText = this.extractBalanced(payload, arrayStart, "[", "]");
        if (arrayText) {
          try {
            const candidates: unknown = JSON.parse(arrayText);
            if (Array.isArray(candidates)) {
              return {
                found: true,
                candidates,
              };
            }
          } catch {
            // Continue to a later positions property if this one is malformed.
          }
        }
      }
      searchFrom = propertyIndex + '"positions"'.length;
    }

    return { found: false, candidates: [] };
  }

  private extractPushArguments(script: string): string[] {
    const marker = "self.__next_f.push";
    const argumentsFound: string[] = [];
    let searchFrom = 0;

    while (searchFrom < script.length) {
      const markerIndex = script.indexOf(marker, searchFrom);
      if (markerIndex < 0) break;
      const openIndex = script.indexOf("(", markerIndex + marker.length);
      if (openIndex < 0) break;
      const callText = this.extractBalanced(script, openIndex, "(", ")");
      if (!callText) {
        searchFrom = openIndex + 1;
        continue;
      }
      argumentsFound.push(callText.slice(1, -1));
      searchFrom = openIndex + callText.length;
    }

    return argumentsFound;
  }

  private extractBalanced(
    source: string,
    start: number,
    open: string,
    close: string,
  ): string | null {
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === open) depth++;
      else if (character === close) {
        depth--;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  }

  private findNextNonWhitespace(source: string, start: number): number {
    for (let index = start; index < source.length; index++) {
      if (!/\s/.test(source[index])) return index;
    }
    return -1;
  }

  private validatePosition(candidate: unknown): AnatarPosition | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return null;
    const record = candidate as Record<string, unknown>;
    if (
      DANGEROUS_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(record, key),
      )
    ) {
      return null;
    }

    let encoded: string;
    try {
      encoded = JSON.stringify(record);
    } catch {
      return null;
    }
    if (Buffer.byteLength(encoded, "utf8") > ANATAR_MAX_POSITION_BYTES)
      return null;

    const title = this.normalize(record.title);
    if (!title) return null;
    return {
      id: this.optionalString(record.id),
      title,
      department: this.optionalString(record.department),
      location: this.optionalString(record.location),
      type: this.optionalString(record.type),
      description: this.optionalDescription(record.description),
    };
  }

  private extractRenderedPositions(html: string): AnatarPosition[] {
    const $ = cheerio.load(html);
    const section = $("#open-positions").first();
    if (section.length === 0) return [];

    const positions: AnatarPosition[] = [];
    section.find("h3").each((_index, heading) => {
      let card = $(heading).parent();
      while (card.length > 0 && card.get(0) !== section.get(0)) {
        const hasApplyButton = card
          .find("button")
          .toArray()
          .some(
            (button) =>
              this.normalize($(button).text()).toLowerCase() === "apply now",
          );
        if (hasApplyButton) break;
        card = card.parent();
      }
      if (card.length === 0 || card.get(0) === section.get(0)) return;

      const metadata = card
        .find("span")
        .toArray()
        .map((span) => this.normalize($(span).text()))
        .filter(Boolean);
      const position = this.validatePosition({
        title: $(heading).text(),
        department: metadata[0],
        location: metadata[1],
        type: metadata[2],
      });
      if (position) positions.push(position);
    });
    return positions;
  }

  private mapAndDeduplicate(positions: AnatarPosition[]): JobPostDto[] {
    const jobs: JobPostDto[] = [];
    const seen = new Set<string>();

    for (const position of positions) {
      const sourceId =
        position.id && UUID_PATTERN.test(position.id) ? position.id : null;
      const fallbackId = this.fallbackId(position);
      const id = sourceId ? `anatar-${sourceId}` : fallbackId;
      if (seen.has(id)) continue;
      seen.add(id);

      const jobUrl = sourceId
        ? `${ANATAR_CAREERS_URL}?id=${sourceId.split("-")[0]}`
        : ANATAR_FALLBACK_URL;
      const locationText = position.location ?? null;
      const jobType = position.type
        ? getJobTypeFromString(position.type)
        : null;
      const description = position.description ?? null;
      const parsedLocation = parseLocationText(locationText);

      jobs.push(
        new JobPostDto({
          id,
          site: Site.ANATAR,
          title: position.title,
          companyName: "Anatar",
          companyUrl: ANATAR_CAREERS_URL,
          jobUrl,
          department: position.department ?? null,
          location: parsedLocation.location,
          description,
          ...(jobType
            ? { jobType: [jobType] }
            : position.type
              ? { employmentType: position.type }
              : {}),
          isRemote: locationText ? parsedLocation.remoteMentioned : null,
          workFromHomeType: parsedLocation.workFromHomeType,
          datePosted: null,
          emails: extractEmails(description),
        }),
      );
    }
    return jobs;
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;
    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.department, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const locationTerm = this.normalize(input.location).toLowerCase();
    if (locationTerm) {
      filtered = filtered.filter((job) =>
        this.normalize(job.location?.displayLocation())
          .toLowerCase()
          .includes(locationTerm),
      );
    }
    if (input.isRemote === true)
      filtered = filtered.filter((job) => job.isRemote === true);
    if (input.jobType) {
      filtered = filtered.filter((job) =>
        job.jobType?.includes(input.jobType as JobType),
      );
    }

    const offset = this.validNonNegativeNumber(input.offset)
      ? Math.floor(input.offset as number)
      : 0;
    const requested = this.validNonNegativeNumber(input.resultsWanted)
      ? Math.floor(input.resultsWanted as number)
      : ANATAR_DEFAULT_RESULTS;
    return filtered.slice(offset, offset + requested);
  }

  private fallbackId(position: AnatarPosition): string {
    const identity = [
      position.title,
      position.department ?? "",
      position.location ?? "",
      position.type ?? "",
    ].join("|");
    return `anatar-fallback-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === "string"
      ? this.normalize(value) || undefined
      : undefined;
  }

  private optionalDescription(value: unknown): string | undefined {
    return typeof value === "string"
      ? this.normalize(htmlToPlainText(value)) || undefined
      : undefined;
  }

  private normalize(value: unknown): string {
    if (typeof value !== "string") return "";
    return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  }

  private validNonNegativeNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  private validPositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  private safeErrorLabel(error: unknown): string {
    if (!error || typeof error !== "object") return "unknown error";
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === "number") return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" && name ? name : "request error";
  }
}
