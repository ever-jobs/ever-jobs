import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Anchorage Digital — Federally chartered crypto bank providing institutional digital-asset custody and services.
 *
 * Anchorage Digital is a crypto platform for institutions offering custody,
 * staking, trading, governance, settlement, and security infrastructure. It
 * operates Anchorage Digital Bank N.A., a federally chartered crypto bank.
 *
 * Sector: Crypto / Banking. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `anchorage`
 * (`https://jobs.lever.co/anchorage`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'anchorage';
const COMPANY_NAME = 'Anchorage Digital';

@SourcePlugin({
  site: Site.ANCHORAGE_DIGITAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AnchorageDigitalService implements IScraper {
  private readonly logger = new Logger(AnchorageDigitalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Anchorage Digital',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Anchorage Digital: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANCHORAGE_DIGITAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'anchorage-');
      }
    }

    this.logger.log(`Anchorage Digital: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
