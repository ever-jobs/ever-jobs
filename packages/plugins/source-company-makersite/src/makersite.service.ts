import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Makersite — Product lifecycle and sustainability data platform for supply-chain decisions.
 *
 * Makersite GmbH provides a product lifecycle management platform that
 * combines product, supply-chain, and sustainability data to support
 * product-development and compliance decisions. It operates remote-first
 * with offices in Stuttgart and Berlin.
 *
 * Sector: Sustainability / PLM SaaS. HQ: Stuttgart, Germany.
 *
 * Source: Recruitee careers board, subdomain `makersitegmbh`
 * (`https://makersitegmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'makersitegmbh';
const COMPANY_NAME = 'Makersite';

@SourcePlugin({
  site: Site.MAKERSITE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MakersiteService implements IScraper {
  private readonly logger = new Logger(MakersiteService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Makersite',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Makersite: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MAKERSITE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'makersite-');
      }
    }

    this.logger.log(`Makersite: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
