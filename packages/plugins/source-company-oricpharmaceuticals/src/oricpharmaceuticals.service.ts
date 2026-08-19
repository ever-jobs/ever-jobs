import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ORIC Pharmaceuticals — Clinical-stage oncology company developing therapies to overcome cancer treatment resistance.
 *
 * ORIC Pharmaceuticals is a clinical-stage biopharmaceutical company
 * developing treatments designed to address mechanisms of therapeutic
 * resistance in cancer. Its pipeline targets tumor types including prostate
 * and lung cancers. It is headquartered in South San Francisco.
 *
 * Sector: Biotechnology / Pharmaceuticals. HQ: South San Francisco, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `ORICPharmaceuticals`
 * (`https://jobs.smartrecruiters.com/ORICPharmaceuticals`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ORICPharmaceuticals';
const COMPANY_NAME = 'ORIC Pharmaceuticals';

@SourcePlugin({
  site: Site.ORIC_PHARMACEUTICALS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ORICPharmaceuticalsService implements IScraper {
  private readonly logger = new Logger(ORICPharmaceuticalsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ORIC Pharmaceuticals',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ORIC Pharmaceuticals: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ORIC_PHARMACEUTICALS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'oricpharmaceuticals-');
      }
    }

    this.logger.log(`ORIC Pharmaceuticals: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
