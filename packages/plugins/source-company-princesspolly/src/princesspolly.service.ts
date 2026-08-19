import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Princess Polly — Online women\'s fashion brand with a growing US retail footprint.
 *
 * Princess Polly is an online women's fashion retailer with corporate
 * offices in Los Angeles and Australia's Gold Coast. It operates a
 * direct-to-consumer e-commerce business alongside physical retail stores
 * across the US and Australia.
 *
 * Sector: Retail / Fashion e-commerce. HQ: Los Angeles, California, USA.
 *
 * Source: Lever job board, company slug `princesspolly`
 * (`https://jobs.lever.co/princesspolly`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'princesspolly';
const COMPANY_NAME = 'Princess Polly';

@SourcePlugin({
  site: Site.PRINCESS_POLLY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PrincessPollyService implements IScraper {
  private readonly logger = new Logger(PrincessPollyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Princess Polly',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Princess Polly: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PRINCESS_POLLY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'princesspolly-');
      }
    }

    this.logger.log(`Princess Polly: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
