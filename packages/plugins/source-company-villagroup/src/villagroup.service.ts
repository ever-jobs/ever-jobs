import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Villa Group — Mexican resort operator managing beachfront hotels and vacation properties.
 *
 * Villa Group (Grupo Villa) is a Mexican hospitality company operating
 * beachfront resorts and vacation properties across destinations including
 * Puerto Vallarta, Cancun, Cabo San Lucas, and Loreto. It runs hotels, spas,
 * and related leisure services.
 *
 * Sector: Hospitality. HQ: Puerto Vallarta, Jalisco, Mexico.
 *
 * Source: SmartRecruiters job board, company identifier `VillaGroup`
 * (`https://jobs.smartrecruiters.com/VillaGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'VillaGroup';
const COMPANY_NAME = 'Villa Group';

@SourcePlugin({
  site: Site.VILLA_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VillaGroupService implements IScraper {
  private readonly logger = new Logger(VillaGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Villa Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Villa Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VILLA_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'villagroup-');
      }
    }

    this.logger.log(`Villa Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
