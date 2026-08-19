import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Madhappy — Los Angeles-based apparel brand focused on optimism and mental health awareness.
 *
 * Madhappy is a Los Angeles-based clothing brand founded in 2017 that sells
 * apparel online and through retail and pop-up spaces. Its work incorporates
 * mental health awareness and community events.
 *
 * Sector: Retail / Apparel e-commerce. HQ: Los Angeles, California, USA.
 *
 * Source: Lever job board, company slug `madhappy`
 * (`https://jobs.lever.co/madhappy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'madhappy';
const COMPANY_NAME = 'Madhappy';

@SourcePlugin({
  site: Site.MADHAPPY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MadhappyService implements IScraper {
  private readonly logger = new Logger(MadhappyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Madhappy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Madhappy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MADHAPPY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'madhappy-');
      }
    }

    this.logger.log(`Madhappy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
