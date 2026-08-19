import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bosch Home Comfort — Bosch division manufacturing heating, ventilation, and hot water systems for residential and commercial use.
 *
 * Bosch Home Comfort Group (formerly Bosch Thermotechnology) is the Bosch
 * division that develops and manufactures heating, cooling, and hot water
 * solutions, including heat pumps, boilers, and water heaters, for
 * residential and commercial buildings.
 *
 * Sector: Industrial / HVAC & heating equipment. HQ: Wetzlar, Hesse, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `Bosch-HomeComfort`
 * (`https://jobs.smartrecruiters.com/Bosch-HomeComfort`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Bosch-HomeComfort';
const COMPANY_NAME = 'Bosch Home Comfort';

@SourcePlugin({
  site: Site.BOSCH_HOME_COMFORT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BoschHomeComfortService implements IScraper {
  private readonly logger = new Logger(BoschHomeComfortService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Bosch Home Comfort',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bosch Home Comfort: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BOSCH_HOME_COMFORT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'boschhomecomfort-');
      }
    }

    this.logger.log(`Bosch Home Comfort: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
