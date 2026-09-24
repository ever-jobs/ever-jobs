import { Injectable } from '@nestjs/common';
import type {
  CareerLevelInput,
  CareerLevelVerdict,
  ICareerLevelClassifier,
} from '@ever-jobs/models';

import { classifyCareerLevel } from './career-level.rules';

/**
 * Deterministic, explainable career-level classifier (Spec 1730, contract C7).
 *
 * Pure + in-memory: classifies the level a posting targets (internship, new grad, entry … executive)
 * from its title, the structured source fields and the opening of its description. Never throws;
 * never mutates its input. The rules live in `career-level.rules.ts`.
 */
@Injectable()
export class CareerLevelClassifierService implements ICareerLevelClassifier {
  classify(input: CareerLevelInput): CareerLevelVerdict {
    return classifyCareerLevel(input);
  }

  classifyBatch(inputs: ReadonlyArray<CareerLevelInput>): CareerLevelVerdict[] {
    return inputs.map((input) => classifyCareerLevel(input));
  }
}
