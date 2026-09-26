import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PluginRegistry } from '@ever-jobs/plugin';
import { UP42Service } from '../src';

describe('UP42Service decorator metadata canary', () => {
  it('emits design:paramtypes metadata', () => {
    const paramtypes = Reflect.getMetadata('design:paramtypes', UP42Service);
    expect(paramtypes).toBeDefined();
    expect(paramtypes[0]).toBe(PluginRegistry);
  });

  it('injects PluginRegistry via constructor metadata', async () => {
    const module = await Test.createTestingModule({
      providers: [PluginRegistry, UP42Service],
    }).compile();
    const service = module.get(UP42Service);
    expect((service as any).registry).toBeDefined();
  });
});
