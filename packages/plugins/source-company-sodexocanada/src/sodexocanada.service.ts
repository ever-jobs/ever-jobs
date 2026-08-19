import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sodexo Canada — Canadian arm of the global food services and facilities management company.
 *
 * Sodexo Canada is the Canadian operating entity of Sodexo, a global
 * provider of food services and integrated facilities management. It
 * delivers catering, corporate dining, and food service operations across
 * corporate, healthcare, education, and other sites in Canada.
 *
 * Sector: Food Services & Facilities Management. HQ: Burlington, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `SodexoCanadaLtd`
 * (`https://jobs.smartrecruiters.com/SodexoCanadaLtd`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SodexoCanadaLtd';
const COMPANY_NAME = 'Sodexo Canada';

@SourcePlugin({
  site: Site.SODEXO_CANADA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SodexoCanadaService implements IScraper {
  private readonly logger = new Logger(SodexoCanadaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Sodexo Canada',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sodexo Canada: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SODEXO_CANADA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sodexocanada-');
      }
    }

    this.logger.log(`Sodexo Canada: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
