import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Canvas Medical — Builds an EHR platform with AI agents that automate clinical and administrative work.
 *
 * Canvas Medical provides an electronic health record platform and develops
 * AI agents that automate work for its customers. Applied AI roles lead
 * evaluations for in-development and deployed agents.
 *
 * Sector: Applied AI / healthcare software. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `canvasmedical`
 * (`https://jobs.lever.co/canvasmedical`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'canvasmedical';
const COMPANY_NAME = 'Canvas Medical';

@SourcePlugin({
  site: Site.CANVAS_MEDICAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CanvasMedicalService implements IScraper {
  private readonly logger = new Logger(CanvasMedicalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Canvas Medical',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Canvas Medical: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CANVAS_MEDICAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'canvasmedical-');
      }
    }

    this.logger.log(`Canvas Medical: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
