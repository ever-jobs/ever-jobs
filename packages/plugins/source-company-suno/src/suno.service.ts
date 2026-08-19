import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Suno — AI music generation platform that creates songs from text prompts.
 *
 * Suno builds generative AI models for music creation, allowing users to
 * produce songs including vocals and instrumentation from text prompts. It
 * is available as a web and mobile application.
 *
 * Sector: Applied AI / music. HQ: Cambridge, Massachusetts, USA.
 *
 * Source: Ashby job board, company slug `suno`
 * (`https://jobs.ashbyhq.com/suno`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'suno';
const COMPANY_NAME = 'Suno';

@SourcePlugin({
  site: Site.SUNO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SunoService implements IScraper {
  private readonly logger = new Logger(SunoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Suno',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Suno: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUNO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'suno-');
      }
    }

    this.logger.log(`Suno: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
