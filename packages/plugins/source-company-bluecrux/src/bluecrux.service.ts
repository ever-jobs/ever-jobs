import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bluecrux — Supply-chain consulting and value-chain software (Binocs, Axon).
 *
 * Bluecrux is a Belgian supply-chain consultancy and software company
 * (products include Binocs and Axon) serving value-chain optimization for
 * enterprises. Its Recruitee board at bluecrux.recruitee.com listed 5 offers
 * spanning Belgium, the US, and Ireland.
 *
 * Sector: Software / Supply-chain consulting. HQ: Aalst, Belgium.
 *
 * Source: Recruitee careers board, subdomain `bluecrux`
 * (`https://bluecrux.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'bluecrux';
const COMPANY_NAME = 'Bluecrux';

@SourcePlugin({
  site: Site.BLUECRUX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BluecruxService implements IScraper {
  private readonly logger = new Logger(BluecruxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Bluecrux',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bluecrux: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BLUECRUX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'bluecrux-');
      }
    }

    this.logger.log(`Bluecrux: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
