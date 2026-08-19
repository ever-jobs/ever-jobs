import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Greenlight Financial Technology — Family finance app providing debit cards and money-management tools for kids and teens.
 *
 * Greenlight offers a family finance platform combining debit cards, banking
 * features, and money-management and financial-literacy tools designed for
 * kids, teens, and their parents.
 *
 * Sector: Consumer Fintech. HQ: Atlanta, Georgia, United States.
 *
 * Source: Lever job board, company slug `greenlight`
 * (`https://jobs.lever.co/greenlight`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'greenlight';
const COMPANY_NAME = 'Greenlight Financial Technology';

@SourcePlugin({
  site: Site.GREENLIGHT_FINANCIAL_TECHNOLOGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GreenlightFinancialTechnologyService implements IScraper {
  private readonly logger = new Logger(GreenlightFinancialTechnologyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Greenlight Financial Technology',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Greenlight Financial Technology: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GREENLIGHT_FINANCIAL_TECHNOLOGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'greenlight-');
      }
    }

    this.logger.log(`Greenlight Financial Technology: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
