import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Field AI — Builds field and dynamics foundation models for robots operating in the real world.
 *
 * Field AI develops robotics foundation models (Field Foundation Models and
 * Dynamics Foundation Models) enabling robots and humanoids to operate
 * autonomously in unstructured real-world environments.
 *
 * Sector: AI / robotics foundation models. HQ: Irvine, California, USA.
 *
 * Source: Lever job board, company slug `field-ai`
 * (`https://jobs.lever.co/field-ai`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'field-ai';
const COMPANY_NAME = 'Field AI';

@SourcePlugin({
  site: Site.FIELD_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FieldAIService implements IScraper {
  private readonly logger = new Logger(FieldAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Field AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Field AI: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIELD_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'fieldai-');
      }
    }

    this.logger.log(`Field AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
