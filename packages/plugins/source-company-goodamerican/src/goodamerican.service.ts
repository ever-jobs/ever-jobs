import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Good American — Inclusive fashion brand selling denim, ready-to-wear, swim, and accessories.
 *
 * Good American is a fashion brand founded in 2016 offering denim,
 * ready-to-wear, swim, and accessories with a focus on inclusive sizing. It
 * is a certified B Corp and sells direct-to-consumer online and through
 * retail stores.
 *
 * Sector: Retail / Fashion e-commerce. HQ: Los Angeles, California, USA.
 *
 * Source: Lever job board, company slug `goodamerican`
 * (`https://jobs.lever.co/goodamerican`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'goodamerican';
const COMPANY_NAME = 'Good American';

@SourcePlugin({
  site: Site.GOOD_AMERICAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GoodAmericanService implements IScraper {
  private readonly logger = new Logger(GoodAmericanService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Good American',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Good American: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GOOD_AMERICAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'goodamerican-');
      }
    }

    this.logger.log(`Good American: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
