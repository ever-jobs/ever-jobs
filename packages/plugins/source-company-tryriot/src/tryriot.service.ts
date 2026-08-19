import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * RIOT — Security awareness platform delivering short chat-based training, phishing simulations, and employee-facing security tools.
 *
 * RIOT is a cybersecurity awareness and human-risk platform founded in 2020.
 * It delivers short chat-based training courses, phishing simulations, and
 * additional products such as email filtering, data loss prevention, and an
 * AI-powered security hotline to help organizations reduce employee-driven
 * risk.
 *
 * Sector: Cybersecurity (Security Awareness / Human Risk). HQ: Paris, France.
 *
 * Source: Lever job board, company slug `tryriot`
 * (`https://jobs.lever.co/tryriot`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tryriot';
const COMPANY_NAME = 'RIOT';

@SourcePlugin({
  site: Site.RIOT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RIOTService implements IScraper {
  private readonly logger = new Logger(RIOTService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape RIOT',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `RIOT: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RIOT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'tryriot-');
      }
    }

    this.logger.log(`RIOT: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
