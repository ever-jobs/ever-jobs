import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cartesia — Builds real-time voice and generative audio models.
 *
 * Cartesia develops generative models for real-time voice and audio,
 * including text-to-speech, offered to developers through an API. It focuses
 * on low-latency voice applications.
 *
 * Sector: Applied AI / voice. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `cartesia`
 * (`https://jobs.ashbyhq.com/cartesia`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cartesia';
const COMPANY_NAME = 'Cartesia';

@SourcePlugin({
  site: Site.CARTESIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CartesiaService implements IScraper {
  private readonly logger = new Logger(CartesiaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Cartesia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cartesia: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CARTESIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'cartesia-');
      }
    }

    this.logger.log(`Cartesia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
