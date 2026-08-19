import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Equip Health — Virtual, evidence-based treatment for eating disorders.
 *
 * Equip Health provides virtual treatment for eating disorders using a
 * team-based model that includes therapists, dietitians, physicians, and
 * peer and family mentors. Care is delivered remotely across the United
 * States. Treatment is based on evidence-based protocols such as
 * family-based treatment.
 *
 * Sector: Healthtech (eating disorder care). HQ: Carlsbad, CA, USA.
 *
 * Source: Ashby job board, company slug `equip`
 * (`https://jobs.ashbyhq.com/equip`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'equip';
const COMPANY_NAME = 'Equip Health';

@SourcePlugin({
  site: Site.EQUIP_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EquipHealthService implements IScraper {
  private readonly logger = new Logger(EquipHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Equip Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Equip Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EQUIP_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'equiphealth-');
      }
    }

    this.logger.log(`Equip Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
