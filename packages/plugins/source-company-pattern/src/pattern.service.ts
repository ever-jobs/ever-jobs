import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pattern — E-commerce acceleration company managing brands across online marketplaces.
 *
 * Pattern is an e-commerce acceleration company that uses technology and AI
 * to manage brands' sales and fulfillment across marketplaces including
 * Amazon, Walmart, and Target. It owns Reach Logistics, which operates
 * warehouses across multiple countries.
 *
 * Sector: E-commerce / Marketplaces. HQ: Lehi, Utah, USA.
 *
 * Source: Lever job board, company slug `pattern`
 * (`https://jobs.lever.co/pattern`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'pattern';
const COMPANY_NAME = 'Pattern';

@SourcePlugin({
  site: Site.PATTERN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PatternService implements IScraper {
  private readonly logger = new Logger(PatternService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Pattern',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pattern: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PATTERN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'pattern-');
      }
    }

    this.logger.log(`Pattern: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
