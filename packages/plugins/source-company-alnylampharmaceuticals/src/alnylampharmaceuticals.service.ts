import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Alnylam Pharmaceuticals — Biopharmaceutical company developing RNA interference (RNAi) therapeutics.
 *
 * Alnylam Pharmaceuticals is a biopharmaceutical company focused on
 * discovering and developing RNA interference (RNAi) therapeutics for
 * genetic, cardio-metabolic, and other diseases. It is headquartered in
 * Cambridge, Massachusetts.
 *
 * Sector: Biotechnology / Pharmaceuticals. HQ: Cambridge, Massachusetts, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Alnylam`
 * (`https://jobs.smartrecruiters.com/Alnylam`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Alnylam';
const COMPANY_NAME = 'Alnylam Pharmaceuticals';

@SourcePlugin({
  site: Site.ALNYLAM_PHARMACEUTICALS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AlnylamPharmaceuticalsService implements IScraper {
  private readonly logger = new Logger(AlnylamPharmaceuticalsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Alnylam Pharmaceuticals',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Alnylam Pharmaceuticals: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALNYLAM_PHARMACEUTICALS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'alnylampharmaceuticals-');
      }
    }

    this.logger.log(`Alnylam Pharmaceuticals: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
