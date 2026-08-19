import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fietsenwinkel.nl — Omnichannel e-bike and bicycle retailer combining an online shop with physical stores across the Netherlands.
 *
 * Fietsenwinkel.nl is a Dutch omnichannel bicycle and e-bike retailer
 * operating an e-commerce platform alongside several physical stores and a
 * megastore. The Recruitee board fietsenwinkelnl.recruitee.com returned 7
 * live offers across customer service, logistics, mechanics, store
 * management and recruitment, in Utrecht, Amsterdam, Groningen and Zwolle.
 *
 * Sector: E-commerce retail (bicycles / e-bikes). HQ: Utrecht, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `fietsenwinkelnl`
 * (`https://fietsenwinkelnl.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'fietsenwinkelnl';
const COMPANY_NAME = 'Fietsenwinkel.nl';

@SourcePlugin({
  site: Site.FIETSENWINKEL_NL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FietsenwinkelNlService implements IScraper {
  private readonly logger = new Logger(FietsenwinkelNlService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Fietsenwinkel.nl',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fietsenwinkel.nl: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIETSENWINKEL_NL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'fietsenwinkelnl-');
      }
    }

    this.logger.log(`Fietsenwinkel.nl: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
