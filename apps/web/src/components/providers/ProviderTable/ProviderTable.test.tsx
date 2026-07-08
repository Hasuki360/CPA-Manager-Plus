import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { ProviderKeyConfig } from '@/types';
import { buildRecentRequestCompositeKey } from '@/utils/recentRequests';
import { ProviderStatusBar } from '../ProviderStatusBar';
import type { ProviderRecentUsageMap } from '../utils';
import { buildProviderRows, type ProviderRow } from './rowData';
import { filterAndSortProviderRows } from './sort';
import { ProviderTable } from './ProviderTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const emptyInput = {
  gemini: [],
  codex: [],
  claude: [],
  vertex: [],
  openai: [],
  usageByProvider: new Map() as ProviderRecentUsageMap,
};

const getRows = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => node.type === 'div' && node.props.role === 'row' && node.props.tabIndex === 0
  );

const getText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : getText(child))).join('');

const clickButton = (button: ReactTestInstance) => {
  const onClick = button.props.onClick as (() => void) | undefined;
  if (!onClick) throw new Error('Button click handler not found');

  act(() => {
    onClick();
  });
};

const mouseDownButton = (button: ReactTestInstance) => {
  const onMouseDown = button.props.onMouseDown as
    | ((event: { preventDefault: () => void }) => void)
    | undefined;
  if (!onMouseDown) throw new Error('Button mouse down handler not found');

  act(() => {
    onMouseDown({ preventDefault: vi.fn() });
  });
};

const toggleSwitch = (toggle: ReactTestInstance, value: boolean) => {
  const onChange = toggle.props.onChange as ((value: boolean) => void) | undefined;
  if (!onChange) throw new Error('Toggle change handler not found');

  act(() => {
    onChange(value);
  });
};

const changeInput = (input: ReactTestInstance, value: string) => {
  const onChange = input.props.onChange as
    | ((event: { target: { value: string } }) => void)
    | undefined;
  if (!onChange) throw new Error('Input change handler not found');

  act(() => {
    onChange({ target: { value } });
  });
};

const blurInput = (input: ReactTestInstance) => {
  const onBlur = input.props.onBlur as (() => void) | undefined;
  if (!onBlur) throw new Error('Input blur handler not found');

  act(() => {
    onBlur();
  });
};

const keyDownInput = (input: ReactTestInstance, key: string) => {
  const onKeyDown = input.props.onKeyDown as
    | ((event: {
        key: string;
        preventDefault: () => void;
        currentTarget: { blur: () => void };
      }) => void)
    | undefined;
  const onBlur = input.props.onBlur as (() => void) | undefined;
  if (!onKeyDown || !onBlur) throw new Error('Input keyboard handlers not found');

  act(() => {
    onKeyDown({
      key,
      preventDefault: vi.fn(),
      currentTarget: {
        blur: onBlur,
      },
    });
  });
};

describe('ProviderTable', () => {
  const codexConfigs: ProviderKeyConfig[] = [
    { apiKey: 'low-key', baseUrl: 'https://low.example.com/v1', priority: 1 },
    {
      apiKey: 'disabled-key',
      baseUrl: 'https://disabled.example.com/v1',
      priority: 99,
      excludedModels: ['*'],
    },
    { apiKey: 'high-key', baseUrl: 'https://high.example.com/v1', priority: 9 },
    { apiKey: 'unset-key', baseUrl: 'https://unset.example.com/v1' },
  ];

  const renderTable = (
    rows: ProviderRow[],
    handlers: {
      onShowDetail?: (row: ProviderRow) => void;
      onEdit?: (row: ProviderRow) => void;
      onDelete?: (row: ProviderRow) => void;
      onToggle?: (row: ProviderRow, enabled: boolean) => void;
      onPriorityChange?: (row: ProviderRow, priority: number) => void;
    } = {},
    options: {
      actionsDisabled?: boolean;
      toggleDisabled?: boolean;
    } = {}
  ) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ProviderTable
          rows={rows}
          loading={false}
          actionsDisabled={options.actionsDisabled ?? false}
          toggleDisabled={options.toggleDisabled ?? false}
          resolvedTheme="light"
          emptyState={<div>empty</div>}
          onShowDetail={handlers.onShowDetail ?? (() => {})}
          onEdit={handlers.onEdit ?? (() => {})}
          onDelete={handlers.onDelete ?? (() => {})}
          onToggle={handlers.onToggle ?? (() => {})}
          onPriorityChange={handlers.onPriorityChange ?? (() => {})}
        />
      );
    });
    return renderer;
  };

  it('keeps sorted row actions mapped to original config indexes', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    const onShowDetail = vi.fn();

    const renderer = renderTable(rows, { onEdit, onToggle, onShowDetail });

    const renderedRows = getRows(renderer);
    expect(renderedRows).toHaveLength(4);

    // 默认按优先级降序：high-key(9) 在最前，停用行排最后
    expect(getText(renderedRows[0])).toContain('https://high.example.com/v1');
    expect(getText(renderedRows[renderedRows.length - 1])).toContain(
      'https://disabled.example.com/v1'
    );

    const editButton = renderedRows[0]
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'common.edit');
    expect(editButton).toBeTruthy();
    clickButton(editButton!);
    expect(onEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 })
    );

    toggleSwitch(renderedRows[0].findByType(ToggleSwitch), false);
    expect(onToggle).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      false
    );

    // 行点击打开详情
    act(() => {
      renderedRows[0].props.onClick();
    });
    expect(onShowDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 })
    );
  });

  it('marks disabled rows and renders disabled toggle state', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const renderer = renderTable(rows);

    const lastRow = getRows(renderer)[3];

    const lastToggle = lastRow.findByType(ToggleSwitch);
    expect(lastToggle.props.checked).toBe(false);
  });

  it('adjusts priority inline without opening row detail', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const onShowDetail = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange, onShowDetail });

    const firstRow = getRows(renderer)[0];
    const increaseButton = firstRow
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'ai_providers.priority_increase');
    expect(increaseButton).toBeTruthy();

    clickButton(increaseButton!);

    expect(onPriorityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      10
    );
    expect(onShowDetail).not.toHaveBeenCalled();
  });

  it('decreases priority inline without clamping existing priority semantics', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    const firstRow = getRows(renderer)[0];
    const decreaseButton = firstRow
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'ai_providers.priority_decrease');
    expect(decreaseButton).toBeTruthy();

    clickButton(decreaseButton!);

    expect(onPriorityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      8
    );
  });

  it('commits a direct priority edit on blur without opening row detail', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const onShowDetail = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange, onShowDetail });

    const firstRow = getRows(renderer)[0];
    const priorityInput = firstRow.findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    changeInput(priorityInput, '42');
    blurInput(priorityInput);

    expect(onPriorityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      42
    );
    expect(onShowDetail).not.toHaveBeenCalled();
  });

  it('commits a direct priority edit with Enter only once', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    const priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    changeInput(priorityInput, '12');
    keyDownInput(priorityInput, 'Enter');

    expect(onPriorityChange).toHaveBeenCalledTimes(1);
    expect(onPriorityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      12
    );
  });

  it('steps from an uncommitted direct priority draft without double submitting', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    const firstRow = getRows(renderer)[0];
    const priorityInput = firstRow.findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });
    const increaseButton = firstRow
      .findAllByType(Button)
      .find((button) => button.props['aria-label'] === 'ai_providers.priority_increase');
    expect(increaseButton).toBeTruthy();

    changeInput(priorityInput, '12');
    mouseDownButton(increaseButton!);
    blurInput(priorityInput);
    clickButton(increaseButton!);

    expect(onPriorityChange).toHaveBeenCalledTimes(1);
    expect(onPriorityChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'codex', originalIndex: 2 }),
      13
    );
  });

  it('cancels a direct priority edit with Escape without committing on blur', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    const priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    changeInput(priorityInput, '12');
    keyDownInput(priorityInput, 'Escape');

    const updatedInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });
    expect(updatedInput.props.value).toBe('9');
    expect(onPriorityChange).not.toHaveBeenCalled();
  });

  it('restores blank or invalid direct priority drafts without committing', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    let priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    changeInput(priorityInput, '');
    blurInput(priorityInput);
    priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });
    expect(priorityInput.props.value).toBe('9');

    changeInput(priorityInput, 'not-a-number');
    blurInput(priorityInput);
    priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });
    expect(priorityInput.props.value).toBe('9');
    expect(onPriorityChange).not.toHaveBeenCalled();
  });

  it('does not submit unchanged direct priority edits', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const onPriorityChange = vi.fn();
    const renderer = renderTable(rows, { onPriorityChange });

    const priorityInput = getRows(renderer)[0].findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    changeInput(priorityInput, '9');
    blurInput(priorityInput);

    expect(onPriorityChange).not.toHaveBeenCalled();
  });

  it('disables inline priority controls with the rest of row actions', () => {
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs })
    );
    const renderer = renderTable(rows, {}, { actionsDisabled: true });

    const firstRow = getRows(renderer)[0];
    const priorityButtons = firstRow
      .findAllByType(Button)
      .filter((button) =>
        ['ai_providers.priority_decrease', 'ai_providers.priority_increase'].includes(
          button.props['aria-label']
        )
      );
    const priorityInput = firstRow.findByProps({
      'aria-label': 'ai_providers.priority_edit',
    });

    expect(priorityButtons).toHaveLength(2);
    expect(priorityButtons.every((button) => button.props.disabled)).toBe(true);
    expect(priorityInput.props.disabled).toBe(true);
  });

  it('renders the provided empty state when there are no rows', () => {
    const renderer = renderTable([]);
    expect(getText(renderer.root as unknown as ReactTestInstance)).toContain('empty');
  });

  it('shows a placeholder instead of the status bar for zero-traffic rows', () => {
    const usageByProvider: ProviderRecentUsageMap = new Map([
      [
        'codex',
        new Map([
          [
            buildRecentRequestCompositeKey('https://high.example.com/v1', 'high-key'),
            { success: 82, failed: 6, recentRequests: [] },
          ],
        ]),
      ],
    ]);
    const rows = filterAndSortProviderRows(
      buildProviderRows({ ...emptyInput, codex: codexConfigs, usageByProvider })
    );
    const renderer = renderTable(rows);

    const renderedRows = getRows(renderer);
    // high-key 行有流量：渲染统计与状态条
    expect(getText(renderedRows[0])).toContain('82');
    expect(renderedRows[0].findAllByType(ProviderStatusBar)).toHaveLength(1);
    expect(getText(renderedRows[0])).not.toContain('status_bar.no_requests');

    // 其余零流量行：仅占位文本，不渲染状态条
    expect(getText(renderedRows[1])).toContain('status_bar.no_requests');
    expect(renderedRows[1].findAllByType(ProviderStatusBar)).toHaveLength(0);
  });
});
