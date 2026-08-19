import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * PowerGen Renewable Energy — Developer and operator of solar mini-grids providing electricity access across Africa.
 *
 * PowerGen Renewable Energy develops, builds and operates solar mini-grids
 * and distributed energy systems to expand electricity access across
 * sub-Saharan Africa. It works on rural electrification and grid-connected
 * renewable infrastructure.
 *
 * Sector: Renewable Energy / Energy Access. HQ: Nairobi, Nairobi, Kenya.
 *
 * Source: SmartRecruiters job board, company identifier `PowerGenRenewableEnergy`
 * (`https://jobs.smartrecruiters.com/PowerGenRenewableEnergy`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PowerGenRenewableEnergy';
const COMPANY_NAME = 'PowerGen Renewable Energy';

@SourcePlugin({
  site: Site.POWERGEN_RENEWABLE_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PowerGenRenewableEnergyService implements IScraper {
  private readonly logger = new Logger(PowerGenRenewableEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape PowerGen Renewable Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `PowerGen Renewable Energy: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.POWERGEN_RENEWABLE_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'powergenrenewableenergy-');
      }
    }

    this.logger.log(`PowerGen Renewable Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
