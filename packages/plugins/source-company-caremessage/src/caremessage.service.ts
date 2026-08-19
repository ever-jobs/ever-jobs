import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CareMessage — Nonprofit patient-engagement technology platform for safety-net healthcare organizations.
 *
 * CareMessage is a nonprofit that provides a patient-engagement platform
 * using text messaging and interoperability tools to help safety-net
 * healthcare organizations reach underserved patients.
 *
 * Sector: Health Tech. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `caremessage`
 * (`https://jobs.lever.co/caremessage`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'caremessage';
const COMPANY_NAME = 'CareMessage';

@SourcePlugin({
  site: Site.CAREMESSAGE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CareMessageService implements IScraper {
  private readonly logger = new Logger(CareMessageService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape CareMessage',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `CareMessage: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CAREMESSAGE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'caremessage-');
      }
    }

    this.logger.log(`CareMessage: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
