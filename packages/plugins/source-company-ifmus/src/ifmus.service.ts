import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Institute of Foundation Models — Research institute developing large language and world foundation models.
 *
 * The Institute of Foundation Models conducts research on large language
 * models and world models, with AI research internships and community roles
 * across Sunnyvale and Abu Dhabi.
 *
 * Sector: AI / foundation model research. HQ: Sunnyvale, California, USA.
 *
 * Source: Lever job board, company slug `ifm-us`
 * (`https://jobs.lever.co/ifm-us`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'ifm-us';
const COMPANY_NAME = 'Institute of Foundation Models';

@SourcePlugin({
  site: Site.INSTITUTE_OF_FOUNDATION_MODELS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InstituteOfFoundationModelsService implements IScraper {
  private readonly logger = new Logger(InstituteOfFoundationModelsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Institute of Foundation Models',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Institute of Foundation Models: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INSTITUTE_OF_FOUNDATION_MODELS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'ifmus-');
      }
    }

    this.logger.log(`Institute of Foundation Models: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
