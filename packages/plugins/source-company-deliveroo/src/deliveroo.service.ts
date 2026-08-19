import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deliveroo — Online marketplace connecting consumers with restaurants and grocery stores for delivery.
 *
 * Deliveroo is an online food and grocery delivery marketplace that connects
 * consumers with local restaurants and shops. Riders deliver orders placed
 * through its app and website. The company is headquartered in London and
 * operates across several countries.
 *
 * Sector: Food & grocery delivery marketplace. HQ: London, England, United Kingdom.
 *
 * Source: Ashby job board, company slug `deliveroo`
 * (`https://jobs.ashbyhq.com/deliveroo`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'deliveroo';
const COMPANY_NAME = 'Deliveroo';

@SourcePlugin({
  site: Site.DELIVEROO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeliverooService implements IScraper {
  private readonly logger = new Logger(DeliverooService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Deliveroo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deliveroo: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELIVEROO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'deliveroo-');
      }
    }

    this.logger.log(`Deliveroo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
