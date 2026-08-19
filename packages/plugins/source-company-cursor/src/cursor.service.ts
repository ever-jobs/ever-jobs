import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import { stripHtmlTags } from '@ever-jobs/common';

const CAREERS_URL = 'https://cursor.com/careers';
const BASE_URL = 'https://cursor.com';

@SourcePlugin({
  site: Site.CURSOR,
  name: 'Cursor',
  category: 'company',
})
@Injectable()
export class CursorService implements IScraper {
  private readonly logger = new Logger(CursorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
        userAgent: 'Mozilla/5.0 (compatible; StapplyMap/1.0)',
      });

      // Step 1: Fetch careers page HTML
      const { data: html } = await client.get<string>(CAREERS_URL);

      // Step 2: Extract job links from HTML
      // Cursor's careers page has job links in <a href="/careers/..."> tags
      const linkRegex = /<a\s[^>]*href="(\/careers\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;

      while ((match = linkRegex.exec(html)) !== null) {
        const path = match[1];
        // Skip the main careers page link
        if (path === '/careers' || path === '/careers/') continue;

        const linkText = stripHtmlTags(match[2]).trim();
        if (!linkText) continue;

        const jobUrl = `${BASE_URL}${path}`;

        // Try to fetch individual job page for description
        let description: string | null = null;
        try {
          const { data: jobHtml } = await client.get<string>(jobUrl);
          description = this.extractDescription(jobHtml);
        } catch {
          // Individual page fetch failures are non-fatal
        }

        jobs.push(
          new JobPostDto({
            id: path,
            site: Site.CURSOR,
            title: linkText,
            companyName: 'Cursor',
            jobUrl,
            description,
          }),
        );
      }

      this.logger.log(`Cursor: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cursor scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  /**
   * Extract the main job description from an individual job page.
   * Looks for common content containers and strips HTML.
   */
  private extractDescription(html: string): string | null {
    const contentPatterns = [
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];

    for (const pattern of contentPatterns) {
      const m = pattern.exec(html);
      if (m?.[1]) {
        const text = stripHtmlTags(m[1]).trim();
        if (text.length > 50) return text;
      }
    }

    return null;
  }
}
