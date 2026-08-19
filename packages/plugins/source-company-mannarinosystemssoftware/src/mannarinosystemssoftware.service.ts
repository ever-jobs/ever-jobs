import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mannarino Systems & Software — Provider of safety-critical systems and software engineering for aerospace and defense.
 *
 * Mannarino Systems & Software provides safety-critical systems and software
 * engineering services to the aerospace, defense, space, simulation, and
 * power generation industries. It supports certification and integration of
 * embedded systems for these regulated sectors.
 *
 * Sector: Aerospace & defense engineering services. HQ: Saint-Laurent, Quebec, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `MannarinoSystemsSoftwareInc`
 * (`https://jobs.smartrecruiters.com/MannarinoSystemsSoftwareInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'MannarinoSystemsSoftwareInc';
const COMPANY_NAME = 'Mannarino Systems & Software';

@SourcePlugin({
  site: Site.MANNARINO_SYSTEMS_SOFTWARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MannarinoSystemsSoftwareService implements IScraper {
  private readonly logger = new Logger(MannarinoSystemsSoftwareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Mannarino Systems & Software',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mannarino Systems & Software: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MANNARINO_SYSTEMS_SOFTWARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'mannarinosystemssoftware-');
      }
    }

    this.logger.log(`Mannarino Systems & Software: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
