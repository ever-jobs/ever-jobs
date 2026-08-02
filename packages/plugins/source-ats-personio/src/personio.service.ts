import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  PERSONIO_XML_URL_DE,
  PERSONIO_XML_URL_COM,
  PERSONIO_JOB_URL_DE,
  PERSONIO_HEADERS,
  PERSONIO_API_AUTH_URL,
  PERSONIO_API_POSITIONS_URL,
} from './personio.constants';
import {
  PersonioPosition,
  PersonioDescription,
  PersonioApiAuthResponse,
  PersonioApiPositionsResponse,
  PersonioApiPosition,
} from './personio.types';

@SourcePlugin({
  site: Site.PERSONIO,
  name: 'Personio',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PersonioService implements IScraper {
  private readonly logger = new Logger(PersonioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Personio scraper');
      return new JobResponseDto([]);
    }

    // Check for API credentials: per-request auth overrides env vars
    const clientId =
      input.auth?.personio?.clientId ?? process.env.PERSONIO_CLIENT_ID;
    const clientSecret =
      input.auth?.personio?.clientSecret ?? process.env.PERSONIO_CLIENT_SECRET;

    if (clientId && clientSecret) {
      try {
        const result = await this.scrapeWithApi(
          clientId,
          clientSecret,
          companySlug,
          input,
        );
        return result;
      } catch (err: any) {
        this.logger.warn(
          `Personio authenticated API failed for ${companySlug}: ${err.message}. Falling back to public XML scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PERSONIO_HEADERS);

    // Try .de domain first, then .com fallback
    const urlDe = PERSONIO_XML_URL_DE.replace('{slug}', encodeURIComponent(companySlug))
      + '?language=en';
    const urlCom = PERSONIO_XML_URL_COM.replace('{slug}', encodeURIComponent(companySlug))
      + '?language=en';

    let xmlData: string | null = null;
    let usedDomain: 'de' | 'com' = 'de';

    try {
      this.logger.log(`Fetching Personio XML feed (.de) for: ${companySlug}`);
      const response = await client.get<string>(urlDe);
      xmlData = response.data;
    } catch {
      this.logger.log(`Personio .de failed, trying .com for: ${companySlug}`);
      try {
        const response = await client.get<string>(urlCom);
        xmlData = response.data;
        usedDomain = 'com';
      } catch (err: any) {
        this.logger.error(`Personio scrape error for ${companySlug}: ${err.message}`);
        return new JobResponseDto([]);
      }
    }

    if (!xmlData) {
      return new JobResponseDto([]);
    }

    try {
      const positions = this.parseXml(xmlData);
      this.logger.log(`Personio: found ${positions.length} positions for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const pos of positions) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.mapPosition(pos, companySlug, usedDomain, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Personio position ${pos.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Personio XML parse error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Fetch jobs using the authenticated Personio Recruiting API.
   *
   * 1. Authenticates via POST to /v1/auth to obtain a Bearer token.
   * 2. Fetches active positions via GET /v1/recruiting/positions?status=active.
   * 3. Maps API positions to JobPostDto using the same site/atsType identifiers.
   *
   * @throws on any HTTP or mapping error so the caller can fall back to XML scraping.
   */
  private async scrapeWithApi(
    clientId: string,
    clientSecret: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `Personio: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    // Step 1: Authenticate to obtain Bearer token
    const authResponse = await client.post<PersonioApiAuthResponse>(
      PERSONIO_API_AUTH_URL,
      { client_id: clientId, client_secret: clientSecret },
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
    );

    const token = authResponse.data?.data?.token;
    if (!token) {
      throw new Error('Personio API auth response did not include a token');
    }

    // Step 2: Fetch active positions with pagination
    const resultsWanted = input.resultsWanted ?? 100;
    const pageSize = 50;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    const apiHeaders = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    while (jobPosts.length < resultsWanted) {
      const positionsResponse =
        await client.get<PersonioApiPositionsResponse>(
          `${PERSONIO_API_POSITIONS_URL}?status=active&limit=${pageSize}&offset=${offset}`,
          { headers: apiHeaders },
        );

      const positions = positionsResponse.data?.data ?? [];

      if (positions.length === 0) break;

      this.logger.log(
        `Personio (authenticated): fetched ${positions.length} positions at offset ${offset} for ${companySlug}`,
      );

      // Step 3: Map API positions to JobPostDto
      for (const pos of positions) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.mapApiPosition(
            pos,
            companySlug,
            input.descriptionFormat,
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Personio API position ${pos.id}: ${err.message}`,
          );
        }
      }

      offset += positions.length;

      // If we got fewer than page size, there are no more results
      if (positions.length < pageSize) break;
    }

    this.logger.log(
      `Personio (authenticated) total: ${jobPosts.length} positions for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  /**
   * Map a single Personio API position to a JobPostDto.
   * Uses the same site / atsType identifiers as the XML-based mapper.
   */
  private mapApiPosition(
    pos: PersonioApiPosition,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const attrs = pos.attributes;
    if (!attrs?.name || !pos.id) return null;

    // Description handling
    let description: string | null = null;
    if (attrs.description) {
      if (format === DescriptionFormat.HTML) {
        description = attrs.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(attrs.description) ?? attrs.description;
      } else {
        description = htmlToPlainText(attrs.description);
      }
    }

    const location = new LocationDto({
      city: attrs.office?.attributes?.name ?? null,
    });

    // Build job URL (default to .de domain for API-sourced positions)
    const jobUrl = `https://${encodeURIComponent(companySlug)}.jobs.personio.de/job/${pos.id}`;

    const datePosted = attrs.created_at
      ? toDateOnly(attrs.created_at)
      : null;

    const skills =
      attrs.keywords && Array.isArray(attrs.keywords)
        ? attrs.keywords.filter(Boolean)
        : null;

    return new JobPostDto({
      id: `personio-${pos.id}`,
      title: attrs.name,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.PERSONIO,
      atsId: pos.id.toString(),
      atsType: 'personio',
      department: attrs.department?.attributes?.name ?? null,
      employmentType: attrs.employment_type ?? null,
      skills,
    });
  }

  private parseXml(xml: string): PersonioPosition[] {
    const $ = cheerio.load(xml, { xmlMode: true });
    const positions: PersonioPosition[] = [];

    $('position').each((_, el) => {
      const pos = $(el);
      const descriptions: PersonioDescription[] = [];

      pos.find('jobDescriptions jobDescription').each((__, descEl) => {
        const d = $(descEl);
        descriptions.push({
          name: d.find('name').text().trim(),
          value: d.find('value').text().trim(),
        });
      });

      positions.push({
        id: pos.find('id').first().text().trim(),
        name: pos.find('name').first().text().trim(),
        office: pos.find('office').text().trim() || null,
        department: pos.find('department').text().trim() || null,
        recruitingCategory: pos.find('recruitingCategory').text().trim() || null,
        employmentType: pos.find('employmentType').text().trim() || null,
        seniority: pos.find('seniority').text().trim() || null,
        schedule: pos.find('schedule').text().trim() || null,
        keywords: pos.find('keywords').text().trim() || null,
        createdAt: pos.find('createdAt').text().trim() || null,
        descriptions,
      });
    });

    return positions;
  }

  private mapPosition(
    pos: PersonioPosition,
    companySlug: string,
    domain: 'de' | 'com',
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!pos.name || !pos.id) return null;

    // Combine all description sections
    const rawHtml = pos.descriptions
      .map((d) => d.value)
      .filter(Boolean)
      .join('\n');

    let description: string | null = null;
    if (rawHtml) {
      if (format === DescriptionFormat.HTML) {
        description = rawHtml;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawHtml) ?? rawHtml;
      } else {
        description = htmlToPlainText(rawHtml);
      }
    }

    const location = new LocationDto({
      city: pos.office,
    });

    const tld = domain === 'de' ? 'de' : 'com';
    const jobUrl = `https://${encodeURIComponent(companySlug)}.jobs.personio.${tld}/job/${pos.id}`;

    const datePosted = pos.createdAt
      ? toDateOnly(pos.createdAt)
      : null;

    const skills = pos.keywords
      ? pos.keywords.split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    return new JobPostDto({
      id: `personio-${pos.id}`,
      title: pos.name,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.PERSONIO,
      atsId: pos.id,
      atsType: 'personio',
      department: pos.department,
      skills,
    });
  }
}
