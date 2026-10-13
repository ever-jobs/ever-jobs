import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site,
} from '@ever-jobs/models';
import { createHttpClient, stripHtmlTags, toLocationDto } from '@ever-jobs/common';

const COMEET_BOARD_BASE = 'https://www.comeet.com/jobs';

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Parse a `NAME = <json>;` assignment out of a script block. Values are
 * strict JSON — walk from the opening bracket with string/escape-aware
 * depth counting, then `JSON.parse` the balanced slice.
 */
function extractAssignment<T>(html: string, marker: string): T | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < html.length && html[i] !== '[' && html[i] !== '{') i++;
  if (i >= html.length) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

@SourcePlugin({
  site: Site.COMEET,
  name: 'Comeet',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ComeetService implements IScraper {
  private readonly logger = new Logger(ComeetService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug;
    if (!company) {
      this.logger.warn('No companySlug provided for Comeet scraper');
      return new JobResponseDto([]);
    }

    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 100;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout ?? 30,
      });

      // The careers page embeds the full board as COMPANY_DATA +
      // COMPANY_POSITIONS_DATA (spec 5174). The careers-api endpoint it
      // replaced needed a per-company token + company_uid the plugin never
      // had; the embedded payload carries complete records in one fetch.
      const pageUrl = input.companyUrl ?? `${COMEET_BOARD_BASE}/${company}`;
      this.logger.log(`Comeet: fetching ${pageUrl}`);

      const { data } = await client.get<string>(pageUrl);
      const html = typeof data === 'string' ? data : String(data ?? '');

      const positions =
        extractAssignment<JsonObj[]>(html, 'COMPANY_POSITIONS_DATA') ?? [];
      const companyData = extractAssignment<JsonObj>(html, 'COMPANY_DATA');

      if (!positions.length) {
        // A page without comeet markers is a soft-404 or a careers page that
        // isn't comeet-hosted — an empty board, not a scrape failure.
        this.logger.warn(`Comeet: no COMPANY_POSITIONS_DATA at ${pageUrl}`);
        return new JobResponseDto([]);
      }

      for (const p of positions) {
        if (jobs.length >= resultsWanted) break;

        const title = str(p.name);
        if (!title) continue;

        const jobId = str(p.uid) || str(p.id);
        const locationObj = isObj(p.location) ? p.location : null;
        const location = toLocationDto(p.location, {
          textKeys: ['name'],
          parseTextFallback: true,
        });
        const isRemote =
          locationObj?.is_remote === true ||
          /\bremote\b/i.test(str(p.workplace_type));

        const details =
          isObj(p.custom_fields) && Array.isArray(p.custom_fields.details)
            ? (p.custom_fields.details as JsonObj[])
            : [];

        const jobUrl = str(p.url_active_page) || str(p.url);

        jobs.push(
          new JobPostDto({
            id: `comeet-${company}-${jobId}`,
            site: Site.COMEET,
            title,
            companyName: str(p.company_name) || str(companyData?.name) || company,
            jobUrl,
            location,
            ...(location ? { locations: [location] } : {}),
            description: details.length
              ? stripHtmlTags(details.map((d) => str(d.value)).join('\n'))
              : null,
            datePosted: str(p.time_updated) || null,
            isRemote,
            employmentType: str(p.employment_type) || null,
            applyUrl: jobUrl || null,
            department: str(p.department) || null,
            atsId: jobId,
            atsType: 'comeet',
          }),
        );
      }

      this.logger.log(`Comeet: scraped ${jobs.length} jobs for ${company}`);
    } catch (err: any) {
      this.logger.error(`Comeet scrape failed for ${company}: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
