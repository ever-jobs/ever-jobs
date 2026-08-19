import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gorgias — Customer support and helpdesk platform built for e-commerce merchants.
 *
 * Gorgias provides a customer support and helpdesk platform designed for
 * e-commerce stores, with deep integrations into platforms such as Shopify.
 * It centralizes customer conversations across channels and adds automation
 * to help merchants respond faster. The company is headquartered in San
 * Francisco.
 *
 * Sector: E-commerce tech / customer support. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `gorgias`
 * (`https://jobs.ashbyhq.com/gorgias`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gorgias';
const COMPANY_NAME = 'Gorgias';

@SourcePlugin({
  site: Site.GORGIAS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GorgiasService implements IScraper {
  private readonly logger = new Logger(GorgiasService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Gorgias',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gorgias: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GORGIAS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'gorgias-');
      }
    }

    this.logger.log(`Gorgias: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
