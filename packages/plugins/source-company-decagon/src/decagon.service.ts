import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Decagon — AI agents for customer support automation.
 *
 * Decagon builds AI customer-support agents that resolve customer inquiries
 * across channels for enterprises. Its platform integrates with existing
 * support systems.
 *
 * Sector: Applied AI / customer support. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `decagon`
 * (`https://jobs.ashbyhq.com/decagon`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'decagon';
const COMPANY_NAME = 'Decagon';

@SourcePlugin({
  site: Site.DECAGON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DecagonService implements IScraper {
  private readonly logger = new Logger(DecagonService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Decagon',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Decagon: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DECAGON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'decagon-');
      }
    }

    this.logger.log(`Decagon: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
