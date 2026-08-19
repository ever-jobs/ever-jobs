import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Meshy — AI platform for generating 3D models from text and images.
 *
 * Meshy develops an AI platform that generates 3D models and textures from
 * text prompts and images, aimed at game developers, artists, and creators.
 * The company operates an AI model-serving infrastructure supporting its
 * generation products.
 *
 * Sector: AI infrastructure / 3D generation. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `meshy`
 * (`https://jobs.ashbyhq.com/meshy`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'meshy';
const COMPANY_NAME = 'Meshy';

@SourcePlugin({
  site: Site.MESHY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MeshyService implements IScraper {
  private readonly logger = new Logger(MeshyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Meshy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Meshy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MESHY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'meshy-');
      }
    }

    this.logger.log(`Meshy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
