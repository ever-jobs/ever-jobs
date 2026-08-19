import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Exploding Kittens — Card and party game company that also builds digital game adaptations.
 *
 * Exploding Kittens is a games company known for its card games and their
 * digital adaptations. It hires across game design, finance and sales.
 *
 * Sector: gaming. HQ: Los Angeles, California, United States.
 *
 * Source: Lever job board, company slug `explodingkittens`
 * (`https://jobs.lever.co/explodingkittens`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'explodingkittens';
const COMPANY_NAME = 'Exploding Kittens';

@SourcePlugin({
  site: Site.EXPLODING_KITTENS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ExplodingKittensService implements IScraper {
  private readonly logger = new Logger(ExplodingKittensService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Exploding Kittens',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Exploding Kittens: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EXPLODING_KITTENS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'explodingkittens-');
      }
    }

    this.logger.log(`Exploding Kittens: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
