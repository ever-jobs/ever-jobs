import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Stanford Medicine Children\'s Health — Pediatric and obstetric academic health care system affiliated with Stanford Medicine.
 *
 * Stanford Medicine Children's Health is a pediatric and obstetric health
 * care system centered on Lucile Packard Children's Hospital Stanford. It is
 * affiliated with Stanford University School of Medicine and provides
 * specialized care for children and expectant mothers.
 *
 * Sector: Healthcare / Pediatric Hospital. HQ: Palo Alto, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `StanfordMedicineChildrensHealth`
 * (`https://jobs.smartrecruiters.com/StanfordMedicineChildrensHealth`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'StanfordMedicineChildrensHealth';
const COMPANY_NAME = 'Stanford Medicine Children\'s Health';

@SourcePlugin({
  site: Site.STANFORD_MEDICINE_CHILDREN_S_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StanfordMedicineChildrenSHealthService implements IScraper {
  private readonly logger = new Logger(StanfordMedicineChildrenSHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Stanford Medicine Children\'s Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Stanford Medicine Children\'s Health: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STANFORD_MEDICINE_CHILDREN_S_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'stanfordmedicinechildrenshealth-');
      }
    }

    this.logger.log(`Stanford Medicine Children\'s Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
