import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Tessenderlo Group — Industrial group producing specialty chemicals, agricultural products, and bio-valorization solutions.
 *
 * Tessenderlo Group is an industrial company active in agriculture,
 * valorizing bio-residuals, energy, and industrial solutions. Its
 * Tessenderlo Kerley business serves agriculture, mining, industrial, and
 * water reclamation markets with chemical products and technologies.
 *
 * Sector: Chemicals / Industrial manufacturing. HQ: Brussels, Belgium.
 *
 * Source: SmartRecruiters job board, company identifier `TessenderloGroup`
 * (`https://jobs.smartrecruiters.com/TessenderloGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TessenderloGroup';
const COMPANY_NAME = 'Tessenderlo Group';

@SourcePlugin({
  site: Site.TESSENDERLO_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TessenderloGroupService implements IScraper {
  private readonly logger = new Logger(TessenderloGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Tessenderlo Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Tessenderlo Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TESSENDERLO_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'tessenderlogroup-');
      }
    }

    this.logger.log(`Tessenderlo Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
