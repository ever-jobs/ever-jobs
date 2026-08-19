import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Office Depot — Office products and business supplies retailer operating stores and e-commerce under Office Depot and OfficeMax.
 *
 * Office Depot is a US retailer of office products, technology, furniture,
 * and business services, part of The ODP Corporation. It operates retail
 * stores under the Office Depot and OfficeMax banners plus an e-commerce
 * channel. The company also provides business-to-business supply and
 * services.
 *
 * Sector: Retail (office products & business supplies). HQ: Boca Raton, Florida, USA.
 *
 * Source: SmartRecruiters job board, company identifier `OfficeDepot`
 * (`https://jobs.smartrecruiters.com/OfficeDepot`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'OfficeDepot';
const COMPANY_NAME = 'Office Depot';

@SourcePlugin({
  site: Site.OFFICE_DEPOT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OfficeDepotService implements IScraper {
  private readonly logger = new Logger(OfficeDepotService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Office Depot',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Office Depot: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OFFICE_DEPOT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'officedepot-');
      }
    }

    this.logger.log(`Office Depot: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
