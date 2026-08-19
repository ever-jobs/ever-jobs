import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * UltraViolet Cyber — Platform-enabled unified security operations company providing managed detection, response, and offensive security services.
 *
 * UltraViolet Cyber is a security operations company that combines managed
 * detection and response, threat intelligence, detection engineering, and
 * offensive security (red teaming, penetration testing) on a unified
 * platform. It is built and run by security practitioners serving enterprise
 * and government clients.
 *
 * Sector: Cybersecurity (Managed Security / Security Operations). HQ: McLean, Virginia, United States.
 *
 * Source: Lever job board, company slug `uvcyber`
 * (`https://jobs.lever.co/uvcyber`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'uvcyber';
const COMPANY_NAME = 'UltraViolet Cyber';

@SourcePlugin({
  site: Site.ULTRAVIOLET_CYBER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UltraVioletCyberService implements IScraper {
  private readonly logger = new Logger(UltraVioletCyberService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape UltraViolet Cyber',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `UltraViolet Cyber: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ULTRAVIOLET_CYBER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'uvcyber-');
      }
    }

    this.logger.log(`UltraViolet Cyber: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
