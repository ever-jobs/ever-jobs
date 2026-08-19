import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Synthesia — AI video generation platform with digital avatars.
 *
 * Synthesia develops an AI video creation platform that generates videos
 * featuring digital avatars and synthetic voices from text scripts, aimed at
 * business communication and training content.
 *
 * Sector: Applied AI / video. HQ: London, England, United Kingdom.
 *
 * Source: Ashby job board, company slug `synthesia`
 * (`https://jobs.ashbyhq.com/synthesia`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'synthesia';
const COMPANY_NAME = 'Synthesia';

@SourcePlugin({
  site: Site.SYNTHESIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SynthesiaService implements IScraper {
  private readonly logger = new Logger(SynthesiaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Synthesia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Synthesia: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SYNTHESIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'synthesia-');
      }
    }

    this.logger.log(`Synthesia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
