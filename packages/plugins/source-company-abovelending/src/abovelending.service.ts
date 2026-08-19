import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Above Lending — Consumer lending company offering personal loans and debt-consolidation products.
 *
 * Above Lending is a consumer financial services company providing personal
 * loan and debt-consolidation products, with a focus on transparent terms
 * and personalized support across the client lifecycle.
 *
 * Sector: Consumer Lending. HQ: Chicago, Illinois, United States.
 *
 * Source: Lever job board, company slug `abovelending`
 * (`https://jobs.lever.co/abovelending`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'abovelending';
const COMPANY_NAME = 'Above Lending';

@SourcePlugin({
  site: Site.ABOVE_LENDING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AboveLendingService implements IScraper {
  private readonly logger = new Logger(AboveLendingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Above Lending',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Above Lending: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ABOVE_LENDING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'abovelending-');
      }
    }

    this.logger.log(`Above Lending: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
