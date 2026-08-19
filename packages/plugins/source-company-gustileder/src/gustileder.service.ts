import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gusti Leder — E-commerce retailer of leather bags, accessories and goods selling internationally via its own shop and marketplaces.
 *
 * Gusti Leder GmbH is a German e-commerce company selling leather bags,
 * backpacks and accessories through its own online shop and third-party
 * marketplaces including Zalando. Its Recruitee board
 * (gustileder.recruitee.com) returned a JSON offers array including roles
 * such as 'Customer Support Agent', 'Country Manager (m/w/d)' and an
 * 'E-Commerce Assistant (Zalando)' remote position.
 *
 * Sector: E-commerce (leather goods / fashion accessories). HQ: Rostock, Germany.
 *
 * Source: Recruitee careers board, subdomain `gustileder`
 * (`https://gustileder.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'gustileder';
const COMPANY_NAME = 'Gusti Leder';

@SourcePlugin({
  site: Site.GUSTI_LEDER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GustiLederService implements IScraper {
  private readonly logger = new Logger(GustiLederService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Gusti Leder',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gusti Leder: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GUSTI_LEDER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'gustileder-');
      }
    }

    this.logger.log(`Gusti Leder: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
