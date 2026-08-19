import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deepgram — Speech-to-text and voice AI API platform.
 *
 * Deepgram develops speech recognition and voice AI models offered through a
 * developer API, including transcription and audio-understanding
 * capabilities for real-time and recorded audio.
 *
 * Sector: Applied AI / speech. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `deepgram`
 * (`https://jobs.ashbyhq.com/deepgram`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'deepgram';
const COMPANY_NAME = 'Deepgram';

@SourcePlugin({
  site: Site.DEEPGRAM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeepgramService implements IScraper {
  private readonly logger = new Logger(DeepgramService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Deepgram',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deepgram: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEEPGRAM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'deepgram-');
      }
    }

    this.logger.log(`Deepgram: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
