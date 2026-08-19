import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Astra Security — Penetration testing and vulnerability management platform.
 *
 * Astra Security provides a pentest platform that combines automated
 * scanning with manual penetration testing to help companies find and fix
 * vulnerabilities in their applications. The platform supports managing
 * pentests and remediation workflows.
 *
 * Sector: Offensive Security / Pentesting. HQ: Delaware, United States.
 *
 * Source: Ashby job board, company slug `astra`
 * (`https://jobs.ashbyhq.com/astra`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'astra';
const COMPANY_NAME = 'Astra Security';

@SourcePlugin({
  site: Site.ASTRA_SECURITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AstraSecurityService implements IScraper {
  private readonly logger = new Logger(AstraSecurityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Astra Security',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Astra Security: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASTRA_SECURITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'astrasecurity-');
      }
    }

    this.logger.log(`Astra Security: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
