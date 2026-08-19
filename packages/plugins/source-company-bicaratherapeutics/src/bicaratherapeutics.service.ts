import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bicara Therapeutics — Clinical-stage biotech developing bifunctional therapies for cancer.
 *
 * Bicara Therapeutics is a clinical-stage biotechnology company developing
 * bifunctional antibody therapies, with a lead candidate targeting solid
 * tumors. It focuses on oncology and immuno-oncology. The company is
 * publicly traded.
 *
 * Sector: Biotech (oncology therapeutics). HQ: Boston, MA, USA.
 *
 * Source: Ashby job board, company slug `bicara-therapeutics`
 * (`https://jobs.ashbyhq.com/bicara-therapeutics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'bicara-therapeutics';
const COMPANY_NAME = 'Bicara Therapeutics';

@SourcePlugin({
  site: Site.BICARA_THERAPEUTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BicaraTherapeuticsService implements IScraper {
  private readonly logger = new Logger(BicaraTherapeuticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Bicara Therapeutics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bicara Therapeutics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BICARA_THERAPEUTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'bicaratherapeutics-');
      }
    }

    this.logger.log(`Bicara Therapeutics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
