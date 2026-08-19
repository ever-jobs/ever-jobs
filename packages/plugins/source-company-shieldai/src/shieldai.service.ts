import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Shield AI — Builds autonomy software and aircraft for defense applications.
 *
 * Shield AI develops the Hivemind autonomy stack and associated aircraft for
 * defense missions. Engineering roles include aerostructures, autonomy AI/ML
 * and product management.
 *
 * Sector: Applied AI / autonomy and defense. HQ: San Diego, California, USA.
 *
 * Source: Lever job board, company slug `shieldai`
 * (`https://jobs.lever.co/shieldai`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'shieldai';
const COMPANY_NAME = 'Shield AI';

@SourcePlugin({
  site: Site.SHIELD_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ShieldAIService implements IScraper {
  private readonly logger = new Logger(ShieldAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Shield AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Shield AI: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SHIELD_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'shieldai-');
      }
    }

    this.logger.log(`Shield AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
