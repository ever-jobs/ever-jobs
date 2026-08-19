import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Analytic Partners — Marketing analytics and measurement firm providing commercial and marketing-mix analytics.
 *
 * Analytic Partners provides marketing and commercial analytics, including
 * marketing-mix modeling and measurement, delivered through its analytics
 * platform and consulting teams.
 *
 * Sector: Marketing analytics. HQ: Miami, Florida, United States.
 *
 * Source: Lever job board, company slug `analyticpartners`
 * (`https://jobs.lever.co/analyticpartners`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'analyticpartners';
const COMPANY_NAME = 'Analytic Partners';

@SourcePlugin({
  site: Site.ANALYTIC_PARTNERS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AnalyticPartnersService implements IScraper {
  private readonly logger = new Logger(AnalyticPartnersService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Analytic Partners',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Analytic Partners: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANALYTIC_PARTNERS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'analyticpartners-');
      }
    }

    this.logger.log(`Analytic Partners: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
