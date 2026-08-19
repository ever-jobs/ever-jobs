import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sysdig — Cloud and container security company built on open-source Falco for runtime threat detection and CNAPP.
 *
 * Sysdig provides a cloud-native application protection platform (CNAPP)
 * covering runtime threat detection, cloud security posture management,
 * vulnerability management, and container security. It is the company behind
 * the open-source Falco runtime-security project.
 *
 * Sector: Cybersecurity (Cloud/Container Security). HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `sysdig`
 * (`https://jobs.lever.co/sysdig`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sysdig';
const COMPANY_NAME = 'Sysdig';

@SourcePlugin({
  site: Site.SYSDIG,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SysdigService implements IScraper {
  private readonly logger = new Logger(SysdigService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Sysdig',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sysdig: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SYSDIG;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'sysdig-');
      }
    }

    this.logger.log(`Sysdig: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
