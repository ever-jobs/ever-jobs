import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { CAREER_LEVEL_CLASSIFIER_TOKEN, type ICareerLevelClassifier } from '@ever-jobs/models';

import { CareerLevelClassifierModule } from '../src/career-level-classifier.module';
import { CareerLevelClassifierService } from '../src/career-level-classifier.service';

describe('CareerLevelClassifierService (Spec 1730)', () => {
  const svc = new CareerLevelClassifierService();

  it('classify() returns a verdict', () => {
    expect(svc.classify({ title: 'Software Engineer Intern' })).toMatchObject({
      level: 'internship',
      confidence: 'high',
    });
  });

  it('classifyBatch() preserves input order and length', () => {
    const out = svc.classifyBatch([
      { title: 'Staff Engineer' },
      { title: 'Barista' },
      { title: 'Software Engineer, New Grad' },
    ]);
    expect(out.map((v) => v.level)).toEqual(['staff', 'unknown', 'new_grad']);
  });

  it('classifyBatch([]) is empty', () => {
    expect(svc.classifyBatch([])).toEqual([]);
  });

  it('the module binds the service under CAREER_LEVEL_CLASSIFIER_TOKEN', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CareerLevelClassifierModule] }).compile();
    const byToken = moduleRef.get<ICareerLevelClassifier>(CAREER_LEVEL_CLASSIFIER_TOKEN);
    expect(byToken).toBeInstanceOf(CareerLevelClassifierService);
    expect(byToken).toBe(moduleRef.get(CareerLevelClassifierService));
    expect(byToken.classify({ title: 'Director of Engineering' }).level).toBe('director');
  });
});
