import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sika — Specialty chemicals company supplying materials for construction and industrial bonding, sealing, and reinforcing.
 *
 * Sika is a specialty chemicals company that develops and produces systems
 * and products for bonding, sealing, damping, reinforcing, and protecting in
 * the building sector and motor vehicle industry. Its products include
 * concrete admixtures, mortars, sealants, adhesives, and roofing and
 * flooring systems. It is headquartered in Baar, Switzerland.
 *
 * Sector: Construction Materials & Specialty Chemicals. HQ: Baar, Switzerland.
 *
 * Source: SmartRecruiters job board, company identifier `SikaAG`
 * (`https://jobs.smartrecruiters.com/SikaAG`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SikaAG';
const COMPANY_NAME = 'Sika';

@SourcePlugin({
  site: Site.SIKA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SikaService implements IScraper {
  private readonly logger = new Logger(SikaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Sika',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sika: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIKA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'sika-');
      }
    }

    this.logger.log(`Sika: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
