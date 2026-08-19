import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Scalian — Engineering consulting firm serving aerospace, defense, rail, and energy sectors.
 *
 * Scalian is a multinational engineering consulting firm specialized in
 * digital systems and industrial performance. It serves technological
 * sectors including aerospace, defense, rail, and energy, providing
 * engineering roles such as FPGA and systems engineering. The firm operates
 * across multiple countries.
 *
 * Sector: Aerospace & defense engineering services. HQ: Labege, Occitanie, France.
 *
 * Source: SmartRecruiters job board, company identifier `Scalian`
 * (`https://jobs.smartrecruiters.com/Scalian`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Scalian';
const COMPANY_NAME = 'Scalian';

@SourcePlugin({
  site: Site.SCALIAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ScalianService implements IScraper {
  private readonly logger = new Logger(ScalianService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Scalian',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Scalian: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SCALIAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'scalian-');
      }
    }

    this.logger.log(`Scalian: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
