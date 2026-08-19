import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sodexo — Global provider of food services and integrated facilities management.
 *
 * Sodexo is a France-headquartered multinational company providing food
 * services and integrated facilities management. Its offerings include
 * corporate and institutional catering, cafeteria and dining operations, and
 * food service across healthcare, education, and business sites worldwide.
 *
 * Sector: Food Services & Facilities Management. HQ: Issy-les-Moulineaux, France.
 *
 * Source: SmartRecruiters job board, company identifier `Sodexo`
 * (`https://jobs.smartrecruiters.com/Sodexo`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Sodexo';
const COMPANY_NAME = 'Sodexo';

@SourcePlugin({
  site: Site.SODEXO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SodexoService implements IScraper {
  private readonly logger = new Logger(SodexoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Sodexo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sodexo: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SODEXO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sodexo-');
      }
    }

    this.logger.log(`Sodexo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
