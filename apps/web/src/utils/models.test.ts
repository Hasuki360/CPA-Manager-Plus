import { describe, expect, it } from 'vitest';
import { classifyModels, modelDisplayLabel, normalizeModelList } from './models';

describe('classifyModels', () => {
  it('classifies devin/* models into Devin group without altering model names', () => {
    const input = [
      { name: 'devin/gpt-5' },
      { name: 'devin/claude-sonnet' },
      { name: 'devin/gemini-3-8-flash' },
      { name: 'devin/grok-4-6' },
      { name: 'devin/deepseek-v4-1-flash' },

      { name: 'gpt-5' },
      { name: 'claude-sonnet' },
      { name: 'gemini-3-8-flash' },
      { name: 'grok-4-6' },
      { name: 'deepseek-v4-1-flash' },
    ];

    const groups = classifyModels(input);

    const devinGroup = groups.find((g) => g.id === 'devin');
    expect(devinGroup).toBeDefined();
    expect(devinGroup?.items.map((m) => m.name)).toEqual([
      'devin/gpt-5',
      'devin/claude-sonnet',
      'devin/gemini-3-8-flash',
      'devin/grok-4-6',
      'devin/deepseek-v4-1-flash',
    ]);

    const gptGroup = groups.find((g) => g.id === 'gpt');
    expect(gptGroup).toBeDefined();
    expect(gptGroup?.items.map((m) => m.name)).toEqual(['gpt-5']);

    const claudeGroup = groups.find((g) => g.id === 'claude');
    expect(claudeGroup).toBeDefined();
    expect(claudeGroup?.items.map((m) => m.name)).toEqual(['claude-sonnet']);

    const geminiGroup = groups.find((g) => g.id === 'gemini');
    expect(geminiGroup).toBeDefined();
    expect(geminiGroup?.items.map((m) => m.name)).toEqual(['gemini-3-8-flash']);

    const grokGroup = groups.find((g) => g.id === 'grok');
    expect(grokGroup).toBeDefined();
    expect(grokGroup?.items.map((m) => m.name)).toEqual(['grok-4-6']);

    const deepseekGroup = groups.find((g) => g.id === 'deepseek');
    expect(deepseekGroup).toBeDefined();
    expect(deepseekGroup?.items.map((m) => m.name)).toEqual(['deepseek-v4-1-flash']);

    devinGroup?.items.forEach((item) => {
      expect(item.name.startsWith('devin/')).toBe(true);
    });
  });

  it('keeps devin namespace check strictly on name and does not classify by alias alone', () => {
    const input = [
      { name: 'custom-model', alias: 'devin/something' },
    ];
    const groups = classifyModels(input);
    const devinGroup = groups.find((g) => g.id === 'devin');
    expect(devinGroup).toBeUndefined();
  });
});

describe('normalizeModelList', () => {
  it('keeps an upstream display name out of the routing alias', () => {
    const [model] = normalizeModelList({
      object: 'list',
      data: [{ id: 'gpt-5.6-luna', object: 'model', display_name: 'GPT 5.6 Luna' }],
    });

    expect(model.name).toBe('gpt-5.6-luna');
    expect(model.alias).toBeUndefined();
    expect(model.displayName).toBe('GPT 5.6 Luna');
  });

  it('accepts the camelCase display name spelling as display metadata', () => {
    const [model] = normalizeModelList([{ id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }]);

    expect(model.alias).toBeUndefined();
    expect(model.displayName).toBe('GPT-5.6 Luna');
  });

  it('preserves an explicitly supplied alias alongside the display name', () => {
    const [model] = normalizeModelList([
      { id: 'gpt-5.6-luna', alias: 'my-luna', display_name: 'GPT 5.6 Luna' },
    ]);

    expect(model.alias).toBe('my-luna');
    expect(model.displayName).toBe('GPT 5.6 Luna');
  });

  it('leaves both fields unset when the entry carries an id only', () => {
    const [model] = normalizeModelList([{ id: 'gpt-5.6-luna' }]);

    expect(model.alias).toBeUndefined();
    expect(model.displayName).toBeUndefined();
  });

  it('drops a display name that merely repeats the model id', () => {
    const [model] = normalizeModelList([
      { id: 'gpt-5.6-luna', display_name: 'gpt-5.6-luna' },
    ]);

    expect(model.alias).toBeUndefined();
    expect(model.displayName).toBeUndefined();
  });

  it('still groups a model by its display name', () => {
    const groups = classifyModels(
      normalizeModelList([{ id: 'meta-muse-internal-7', display_name: 'Claude Sonnet 4.6' }])
    );

    expect(groups.find((group) => group.id === 'claude')?.items.map((m) => m.name)).toEqual([
      'meta-muse-internal-7',
    ]);
  });
});

describe('modelDisplayLabel', () => {
  it('prefers an explicit alias over the upstream display name', () => {
    expect(modelDisplayLabel({ name: 'gpt-5.6-luna', alias: 'my-luna', displayName: 'GPT 5.6 Luna' }))
      .toBe('my-luna');
  });

  it('falls back to the display name so discovery rows stay readable', () => {
    expect(modelDisplayLabel({ name: 'gpt-5.6-luna', displayName: 'GPT 5.6 Luna' }))
      .toBe('GPT 5.6 Luna');
  });

  it('returns an empty string when the model carries neither', () => {
    expect(modelDisplayLabel({ name: 'gpt-5.6-luna' })).toBe('');
  });
});
