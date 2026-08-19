import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Isometric — Operates a scientific carbon removal registry that verifies and issues carbon credits.
 *
 * Isometric is a carbon removal registry that develops scientific protocols
 * to measure, verify, and issue credits for durable carbon removal projects.
 * It focuses on transparency and rigorous measurement in the carbon removal
 * market. The company is based in London.
 *
 * Sector: Carbon removal / registry. HQ: London, United Kingdom.
 *
 * Source: Ashby job board, company slug `isometric`
 * (`https://jobs.ashbyhq.com/isometric`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'isometric';
const COMPANY_NAME = 'Isometric';

@SourcePlugin({
  site: Site.ISOMETRIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IsometricService implements IScraper {
  private readonly logger = new Logger(IsometricService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Isometric',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Isometric: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ISOMETRIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'isometric-');
      }
    }

    this.logger.log(`Isometric: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
