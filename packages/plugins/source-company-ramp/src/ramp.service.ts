import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ramp — A finance automation platform offering corporate cards, expense management, bill pay, and treasury tools.
 *
 * Ramp is a financial operations platform that provides corporate cards,
 * expense management, bill payment, procurement, and treasury products for
 * businesses. The company automates finance workflows to help teams control
 * spend. Ramp is backed by investors including Founders Fund, Thrive
 * Capital, and Sequoia.
 *
 * Sector: Fintech - Spend management & payments. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `ramp`
 * (`https://jobs.ashbyhq.com/ramp`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'ramp';
const COMPANY_NAME = 'Ramp';

@SourcePlugin({
  site: Site.RAMP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RampService implements IScraper {
  private readonly logger = new Logger(RampService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Ramp',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ramp: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RAMP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'ramp-');
      }
    }

    this.logger.log(`Ramp: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
