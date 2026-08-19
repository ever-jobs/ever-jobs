import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sierra — Conversational AI platform for customer-facing agents.
 *
 * Sierra builds a platform for companies to deploy conversational AI agents
 * that handle customer interactions. The agents are configured to a
 * company's policies and systems.
 *
 * Sector: Applied AI / customer experience. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `sierra`
 * (`https://jobs.ashbyhq.com/sierra`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sierra';
const COMPANY_NAME = 'Sierra';

@SourcePlugin({
  site: Site.SIERRA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SierraService implements IScraper {
  private readonly logger = new Logger(SierraService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sierra',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sierra: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIERRA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sierra-');
      }
    }

    this.logger.log(`Sierra: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
