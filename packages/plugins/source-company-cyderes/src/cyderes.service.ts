import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cyderes — Global managed cybersecurity services provider delivering managed detection and response, identity, and security engineering.
 *
 * Cyderes is a managed cybersecurity services provider offering managed
 * detection and response, identity and access management, and security
 * engineering across platforms such as Microsoft Sentinel and SailPoint. It
 * operates globally for enterprise clients.
 *
 * Sector: Cybersecurity (Managed Security Services). HQ: Kansas City, Missouri, United States.
 *
 * Source: Lever job board, company slug `cyderes`
 * (`https://jobs.lever.co/cyderes`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cyderes';
const COMPANY_NAME = 'Cyderes';

@SourcePlugin({
  site: Site.CYDERES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CyderesService implements IScraper {
  private readonly logger = new Logger(CyderesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Cyderes',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cyderes: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CYDERES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'cyderes-');
      }
    }

    this.logger.log(`Cyderes: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
