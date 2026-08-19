import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sanity — Headless content platform and content operating system for developers.
 *
 * Sanity provides a headless content management platform, described as a
 * content operating system, that treats content as structured data
 * accessible via APIs. It includes a customizable editing environment called
 * Sanity Studio. The company has operations in San Francisco and Oslo.
 *
 * Sector: B2B SaaS / developer tools. HQ: San Francisco, California, USA / Oslo, Norway.
 *
 * Source: Ashby job board, company slug `sanity`
 * (`https://jobs.ashbyhq.com/sanity`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sanity';
const COMPANY_NAME = 'Sanity';

@SourcePlugin({
  site: Site.SANITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SanityService implements IScraper {
  private readonly logger = new Logger(SanityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sanity',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sanity: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SANITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sanity-');
      }
    }

    this.logger.log(`Sanity: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
