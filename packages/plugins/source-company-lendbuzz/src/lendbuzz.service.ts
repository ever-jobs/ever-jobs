import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lendbuzz — AI-based auto lending platform financing consumers through dealerships.
 *
 * Lendbuzz is a fintech company that uses AI and alternative data to provide
 * auto financing to consumers, including those with limited US credit
 * history, through a dealership network.
 *
 * Sector: Auto Lending / Fintech. HQ: Boston, Massachusetts, United States.
 *
 * Source: Lever job board, company slug `lendbuzz`
 * (`https://jobs.lever.co/lendbuzz`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lendbuzz';
const COMPANY_NAME = 'Lendbuzz';

@SourcePlugin({
  site: Site.LENDBUZZ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LendbuzzService implements IScraper {
  private readonly logger = new Logger(LendbuzzService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Lendbuzz',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lendbuzz: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LENDBUZZ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'lendbuzz-');
      }
    }

    this.logger.log(`Lendbuzz: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
