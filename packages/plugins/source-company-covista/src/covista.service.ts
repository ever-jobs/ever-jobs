import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Covista — Healthcare-focused higher education provider, formerly Adtalem Global Education, and parent of Chamberlain University and Walden University.
 *
 * Covista (formerly Adtalem Global Education) is a large U.S. workforce
 * solutions and higher-education provider focused on healthcare education.
 * It is the parent organization of institutions including Chamberlain
 * University, Walden University, Ross University School of Medicine, and
 * Ross University School of Veterinary Medicine. It educates nursing,
 * medical, and other healthcare professionals across campuses nationwide and
 * online.
 *
 * Sector: Education (higher education / healthcare education). HQ: Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Covista`
 * (`https://jobs.smartrecruiters.com/Covista`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Covista';
const COMPANY_NAME = 'Covista';

@SourcePlugin({
  site: Site.COVISTA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CovistaService implements IScraper {
  private readonly logger = new Logger(CovistaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Covista',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Covista: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COVISTA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'covista-');
      }
    }

    this.logger.log(`Covista: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
