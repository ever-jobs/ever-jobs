import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Vanta — Trust management platform that automates security compliance and GRC.
 *
 * Vanta builds a trust management platform that automates security and
 * compliance work across frameworks such as SOC 2, ISO 27001, and FedRAMP.
 * It helps companies achieve and maintain compliance and demonstrate
 * security posture.
 *
 * Sector: Security Compliance & GRC. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `vanta`
 * (`https://jobs.ashbyhq.com/vanta`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'vanta';
const COMPANY_NAME = 'Vanta';

@SourcePlugin({
  site: Site.VANTA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VantaService implements IScraper {
  private readonly logger = new Logger(VantaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Vanta',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Vanta: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VANTA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'vanta-');
      }
    }

    this.logger.log(`Vanta: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
