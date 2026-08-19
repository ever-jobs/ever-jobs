import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Northwestern Medicine — Academic health system affiliated with Northwestern University Feinberg School of Medicine.
 *
 * Northwestern Medicine is an integrated academic health system in the
 * Chicago area, comprising hospitals, outpatient facilities, and physician
 * groups. It is affiliated with Northwestern University Feinberg School of
 * Medicine. The system delivers patient care, medical education, and
 * research.
 *
 * Sector: Healthcare / Hospital System. HQ: Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `northwesternmedicine`
 * (`https://jobs.smartrecruiters.com/northwesternmedicine`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'northwesternmedicine';
const COMPANY_NAME = 'Northwestern Medicine';

@SourcePlugin({
  site: Site.NORTHWESTERN_MEDICINE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NorthwesternMedicineService implements IScraper {
  private readonly logger = new Logger(NorthwesternMedicineService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Northwestern Medicine',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Northwestern Medicine: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NORTHWESTERN_MEDICINE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'northwesternmedicine-');
      }
    }

    this.logger.log(`Northwestern Medicine: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
