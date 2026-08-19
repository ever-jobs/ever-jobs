import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cyber & Mason (PinDirect) — Amersfoort payments company delivering card/terminal payment solutions for SMBs and hospitality under the PinDirect brand.
 *
 * Cyber & Mason, operating under the PinDirect brand, is a Dutch payments
 * company based in Amersfoort that provides payment terminals and
 * transaction-processing solutions aimed at SMBs and the hospitality sector.
 * Its Recruitee board (cybermason.recruitee.com) listed four live openings
 * across IT, sales and customer support.
 *
 * Sector: Payments / SME acquiring. HQ: Amersfoort, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `cybermason`
 * (`https://cybermason.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'cybermason';
const COMPANY_NAME = 'Cyber & Mason (PinDirect)';

@SourcePlugin({
  site: Site.CYBER_MASON_PINDIRECT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CyberMasonPinDirectService implements IScraper {
  private readonly logger = new Logger(CyberMasonPinDirectService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Cyber & Mason (PinDirect)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cyber & Mason (PinDirect): delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CYBER_MASON_PINDIRECT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'cybermasonpindirect-');
      }
    }

    this.logger.log(`Cyber & Mason (PinDirect): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
