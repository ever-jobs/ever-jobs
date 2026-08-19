import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ElevenLabs — AI voice and audio company offering text-to-speech and voice generation.
 *
 * ElevenLabs develops AI models for speech synthesis, voice cloning,
 * dubbing, and audio generation. It provides these capabilities through
 * consumer products and a developer API.
 *
 * Sector: Applied AI / voice. HQ: London, England, United Kingdom.
 *
 * Source: Ashby job board, company slug `elevenlabs`
 * (`https://jobs.ashbyhq.com/elevenlabs`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'elevenlabs';
const COMPANY_NAME = 'ElevenLabs';

@SourcePlugin({
  site: Site.ELEVENLABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ElevenLabsService implements IScraper {
  private readonly logger = new Logger(ElevenLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape ElevenLabs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `ElevenLabs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ELEVENLABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'elevenlabs-');
      }
    }

    this.logger.log(`ElevenLabs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
