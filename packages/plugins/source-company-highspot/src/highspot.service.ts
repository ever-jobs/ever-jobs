import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Highspot — Sales enablement platform for content management, training, and buyer engagement.
 *
 * Highspot provides a sales enablement platform that manages sales content,
 * guides reps through plays, and analyzes buyer engagement. It sells to
 * enterprise revenue teams and has engineering in Seattle and Hyderabad.
 *
 * Sector: B2B SaaS / Sales Enablement. HQ: Seattle, Washington, United States.
 *
 * Source: Lever job board, company slug `highspot`
 * (`https://jobs.lever.co/highspot`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'highspot';
const COMPANY_NAME = 'Highspot';

@SourcePlugin({
  site: Site.HIGHSPOT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HighspotService implements IScraper {
  private readonly logger = new Logger(HighspotService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Highspot',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Highspot: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIGHSPOT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'highspot-');
      }
    }

    this.logger.log(`Highspot: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
