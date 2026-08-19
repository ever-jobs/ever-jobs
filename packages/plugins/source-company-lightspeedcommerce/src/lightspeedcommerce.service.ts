import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lightspeed Commerce — Cloud-based point-of-sale and commerce platform for retail, restaurant, and hospitality businesses.
 *
 * Lightspeed Commerce is a publicly traded company that provides a cloud
 * commerce platform for small and medium-sized businesses. Its software
 * combines point-of-sale, payments, inventory management, and e-commerce for
 * retailers and restaurants. The company is headquartered in Montreal and
 * operates in multiple countries.
 *
 * Sector: Retail tech / commerce platform. HQ: Montreal, Quebec, Canada.
 *
 * Source: Ashby job board, company slug `lightspeedhq`
 * (`https://jobs.ashbyhq.com/lightspeedhq`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lightspeedhq';
const COMPANY_NAME = 'Lightspeed Commerce';

@SourcePlugin({
  site: Site.LIGHTSPEED_COMMERCE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LightspeedCommerceService implements IScraper {
  private readonly logger = new Logger(LightspeedCommerceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lightspeed Commerce',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lightspeed Commerce: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LIGHTSPEED_COMMERCE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'lightspeedcommerce-');
      }
    }

    this.logger.log(`Lightspeed Commerce: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
