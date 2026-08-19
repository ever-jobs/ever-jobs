import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ASAPP — Builds real-time voice and generative AI for customer-experience operations.
 *
 * ASAPP builds a real-time voice AI platform and generative AI for
 * contact-center and customer-experience use cases, combining speech
 * infrastructure with applied speech intelligence.
 *
 * Sector: Applied AI / conversational and speech AI. HQ: New York, New York, USA.
 *
 * Source: Lever job board, company slug `asapp-2`
 * (`https://jobs.lever.co/asapp-2`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'asapp-2';
const COMPANY_NAME = 'ASAPP';

@SourcePlugin({
  site: Site.ASAPP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ASAPPService implements IScraper {
  private readonly logger = new Logger(ASAPPService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape ASAPP',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `ASAPP: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASAPP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'asapp2-');
      }
    }

    this.logger.log(`ASAPP: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
