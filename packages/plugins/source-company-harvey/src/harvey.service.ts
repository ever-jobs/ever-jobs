import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Harvey — AI platform for legal and professional-services work.
 *
 * Harvey builds an AI platform for law firms and professional-services
 * organizations, applying large language models to legal research, drafting,
 * and workflow tasks. It serves enterprise legal customers.
 *
 * Sector: Applied AI / legal. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `harvey`
 * (`https://jobs.ashbyhq.com/harvey`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'harvey';
const COMPANY_NAME = 'Harvey';

@SourcePlugin({
  site: Site.HARVEY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HarveyService implements IScraper {
  private readonly logger = new Logger(HarveyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Harvey',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Harvey: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HARVEY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'harvey-');
      }
    }

    this.logger.log(`Harvey: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
