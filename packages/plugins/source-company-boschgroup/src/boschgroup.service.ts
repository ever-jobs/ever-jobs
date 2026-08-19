import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bosch Group — Global technology and engineering company spanning mobility, industrial, and software.
 *
 * Bosch is a technology and engineering company operating across mobility
 * solutions, industrial technology, consumer goods, and energy/building
 * technology. It develops software, IoT, and automation systems alongside
 * its hardware businesses. It employs a large global workforce.
 *
 * Sector: Technology and engineering (industrial, mobility, software). HQ: Gerlingen, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `BoschGroup`
 * (`https://jobs.smartrecruiters.com/BoschGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'BoschGroup';
const COMPANY_NAME = 'Bosch Group';

@SourcePlugin({
  site: Site.BOSCH_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BoschGroupService implements IScraper {
  private readonly logger = new Logger(BoschGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Bosch Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bosch Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BOSCH_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'boschgroup-');
      }
    }

    this.logger.log(`Bosch Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
