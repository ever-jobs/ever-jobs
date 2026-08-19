import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * QLF Brands (lampenlicht.nl) — International e-commerce lighting retailer operating dozens of webshops (incl. lampenlicht.nl) plus physical stores across Europe.
 *
 * QLF Brands is a Dutch e-commerce lighting retailer, best known for
 * lampenlicht.nl, operating around 39 webshops across 31 European countries
 * alongside physical stores. Its careers copy cites a warehouse in Hapert
 * and offices/stores in the Netherlands and abroad (including
 * Barcelona/Krakow support hubs). The Recruitee board
 * qlfbrands.recruitee.com returned 7 live offers.
 *
 * Sector: E-commerce retail (home / lighting). HQ: Hapert, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `qlfbrands`
 * (`https://qlfbrands.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'qlfbrands';
const COMPANY_NAME = 'QLF Brands (lampenlicht.nl)';

@SourcePlugin({
  site: Site.QLF_BRANDS_LAMPENLICHT_NL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QLFBrandsLampenlichtNlService implements IScraper {
  private readonly logger = new Logger(QLFBrandsLampenlichtNlService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape QLF Brands (lampenlicht.nl)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `QLF Brands (lampenlicht.nl): delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QLF_BRANDS_LAMPENLICHT_NL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'qlfbrandslampenlichtnl-');
      }
    }

    this.logger.log(`QLF Brands (lampenlicht.nl): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
