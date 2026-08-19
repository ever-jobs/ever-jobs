import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Gamma — AI platform for creating presentations, documents, and websites.
 *
 * Gamma provides an AI-powered application for generating presentations,
 * documents, and websites from prompts and outlines. It is used by
 * individuals and teams for content creation.
 *
 * Sector: Applied AI / productivity. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `gamma`
 * (`https://jobs.ashbyhq.com/gamma`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gamma';
const COMPANY_NAME = 'Gamma';

@SourcePlugin({
  site: Site.GAMMA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GammaService implements IScraper {
  private readonly logger = new Logger(GammaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Gamma',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Gamma: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GAMMA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'gamma-');
      }
    }

    this.logger.log(`Gamma: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
