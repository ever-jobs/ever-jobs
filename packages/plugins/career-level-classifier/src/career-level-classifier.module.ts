import { Module } from '@nestjs/common';
import { CAREER_LEVEL_CLASSIFIER_TOKEN } from '@ever-jobs/models';

import { CareerLevelClassifierService } from './career-level-classifier.service';

/**
 * NestJS module binding the deterministic `ICareerLevelClassifier` implementation under the public
 * `CAREER_LEVEL_CLASSIFIER_TOKEN` (Spec 1730). Consumers inject by token, never by class — a
 * future model-backed classifier can bind the same token without touching its callers.
 */
@Module({
  providers: [
    CareerLevelClassifierService,
    {
      provide: CAREER_LEVEL_CLASSIFIER_TOKEN,
      useExisting: CareerLevelClassifierService,
    },
  ],
  exports: [CAREER_LEVEL_CLASSIFIER_TOKEN, CareerLevelClassifierService],
})
export class CareerLevelClassifierModule {}
