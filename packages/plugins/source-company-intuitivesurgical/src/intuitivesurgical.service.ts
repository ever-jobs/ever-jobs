import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Intuitive Surgical — Manufacturer of robotic-assisted surgical systems and related instruments.
 *
 * Intuitive Surgical, Inc. develops and manufactures robotic-assisted
 * surgical systems, including the da Vinci surgical platform and Ion
 * endoluminal system, along with associated instruments and accessories.
 *
 * Sector: Medical device manufacturing / Robotics. HQ: Sunnyvale, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Intuitive`
 * (`https://jobs.smartrecruiters.com/Intuitive`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Intuitive';
const COMPANY_NAME = 'Intuitive Surgical';

@SourcePlugin({
  site: Site.INTUITIVE_SURGICAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IntuitiveSurgicalService implements IScraper {
  private readonly logger = new Logger(IntuitiveSurgicalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Intuitive Surgical',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Intuitive Surgical: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INTUITIVE_SURGICAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'intuitivesurgical-');
      }
    }

    this.logger.log(`Intuitive Surgical: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
