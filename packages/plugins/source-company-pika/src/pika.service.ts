import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pika — AI video generation platform for creating and editing video from prompts.
 *
 * Pika develops generative AI models for video creation and editing,
 * enabling users to generate and modify video clips from text and image
 * inputs. It is offered as a consumer product.
 *
 * Sector: Applied AI / video. HQ: Palo Alto, California, USA.
 *
 * Source: Ashby job board, company slug `pika`
 * (`https://jobs.ashbyhq.com/pika`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'pika';
const COMPANY_NAME = 'Pika';

@SourcePlugin({
  site: Site.PIKA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PikaService implements IScraper {
  private readonly logger = new Logger(PikaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Pika',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pika: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PIKA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'pika-');
      }
    }

    this.logger.log(`Pika: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
