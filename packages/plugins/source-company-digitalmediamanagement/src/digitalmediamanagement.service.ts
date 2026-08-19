import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Digital Media Management — Social media marketing agency serving entertainment clients.
 *
 * Digital Media Management (DMM), a Keywords Studios company, is a social
 * media marketing agency that works with entertainment and studio clients
 * across movies, TV and brands.
 *
 * Sector: media. HQ: Los Angeles, California, United States.
 *
 * Source: Lever job board, company slug `digitalmediamanagement`
 * (`https://jobs.lever.co/digitalmediamanagement`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'digitalmediamanagement';
const COMPANY_NAME = 'Digital Media Management';

@SourcePlugin({
  site: Site.DIGITAL_MEDIA_MANAGEMENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DigitalMediaManagementService implements IScraper {
  private readonly logger = new Logger(DigitalMediaManagementService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Digital Media Management',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Digital Media Management: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DIGITAL_MEDIA_MANAGEMENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'digitalmediamanagement-');
      }
    }

    this.logger.log(`Digital Media Management: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
