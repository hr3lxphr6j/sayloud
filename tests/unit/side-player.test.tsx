import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderState } from '~/entrypoints/reader.content/ReaderController';
import { ReaderPanel } from '~/entrypoints/reader.content/ReaderPanel';
import {
  HINTS,
  nextRate,
  RATE_STEPS,
  SidePlayer,
  type SidePlayerProps,
} from '~/entrypoints/reader.content/SidePlayer';
import type { LocalStorageArea } from '~/lib/config-store';
import { formatRate } from '~/lib/format-rate';
import { I18nProvider } from '~/lib/i18n';
import { en } from '~/lib/i18n/messages.en';
import type { EngineCommand, EngineStatus } from '~/lib/protocol';
import { SETTINGS_KEY, SettingsStore, type StorageChangeApi } from '~/lib/settings-store';

function statusOf(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    phase: 'playing',
    index: 0,
    total: 3,
    rate: 1,
    voice: 'Test',
    charsRead: 0,
    charsTotal: 300,
    charsPerSec: 0,
    ...overrides,
  };
}

function stateOf(overrides: Partial<ReaderState> = {}): ReaderState {
  return {
    status: statusOf(),
    hasContent: true,
    error: null,
    scrolledAway: false,
    ...overrides,
  };
}

/** A stand-in for ReaderController that records commands and can push state. */
function fakeController(initial: ReaderState) {
  const commands: EngineCommand[] = [];
  const returnToPosition = vi.fn();
  let current = initial;
  let listener: ((state: ReaderState) => void) | null = null;

  const controller: SidePlayerProps['controller'] = {
    getState: () => current,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    sendCommand: (command) => {
      commands.push(command);
    },
    returnToPosition,
  };

  return {
    controller,
    commands,
    returnToPosition,
    push: (state: ReaderState) => {
      current = state;
      // Preact batches renders, so a pushed state needs act() to reach the DOM.
      act(() => listener?.(state));
    },
  };
}

function renderPlayer(state: ReaderState = stateOf()) {
  const fake = fakeController(state);
  const onOpenSettings = vi.fn();
  const result = render(
    <SidePlayer controller={fake.controller} onOpenSettings={onOpenSettings} />
  );
  return { ...fake, ...result, onOpenSettings };
}

describe('nextRate', () => {
  it('steps up through the preset speeds', () => {
    expect(nextRate(1)).toBe(1.25);
    expect(nextRate(1.25)).toBe(1.5);
  });

  it('wraps around at the top of the range', () => {
    const last = RATE_STEPS[RATE_STEPS.length - 1];
    expect(last).toBeDefined();
    expect(nextRate(last as number)).toBe(RATE_STEPS[0]);
  });

  it('restarts the cycle for a rate it does not know', () => {
    expect(nextRate(7)).toBe(RATE_STEPS[0]);
  });
});

describe('formatRate', () => {
  it('drops the trailing zeros', () => {
    expect(formatRate(1)).toBe('1×');
    expect(formatRate(1.5)).toBe('1.5×');
    expect(formatRate(0.75)).toBe('0.75×');
  });
});

function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: LocalStorageArea = {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
  return { area };
}

/** A `storage.onChanged` a test can fire, standing in for the panel's write. */
function fakeChanges() {
  const listeners = new Set<(changes: Record<string, unknown>, areaName: string) => void>();
  const api: StorageChangeApi = {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
  return {
    api,
    fire: (settings: unknown): void => {
      for (const listener of [...listeners]) {
        listener({ [SETTINGS_KEY]: { newValue: settings } }, 'local');
      }
    },
  };
}

describe('ReaderPanel', () => {
  /** A stand-in for the shadow host the player is mounted in. */
  function fakeHost(): HTMLDivElement {
    const host = document.createElement('div');
    document.body.append(host);
    return host;
  }

  it('renders the bar in the saved language', async () => {
    const settings = new SettingsStore(fakeArea({ [SETTINGS_KEY]: { uiLang: 'zh-CN' } }).area);
    const fake = fakeController(stateOf());
    const host = fakeHost();

    render(
      <ReaderPanel
        controller={fake.controller}
        settings={settings}
        host={host}
        onOpenSettings={() => {}}
      />
    );

    expect(await screen.findByRole('button', { name: '暂停' })).toBeDefined();
    expect(screen.getByRole('button', { name: '上一句' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    // The page being read keeps its own language; only our host is tagged.
    // Effects are deferred here: the update came from a storage read rather
    // than from inside `act`, so the DOM renders a tick before the effect runs.
    await waitFor(() => expect(host.lang).toBe('zh-CN'));
    expect(document.documentElement.lang).not.toBe('zh-CN');

    host.remove();
  });

  it('switches language when the setting changes elsewhere', async () => {
    const changes = fakeChanges();
    const settings = new SettingsStore(fakeArea().area, changes.api);
    const fake = fakeController(stateOf());
    const host = fakeHost();
    render(
      <ReaderPanel
        controller={fake.controller}
        settings={settings}
        host={host}
        onOpenSettings={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDefined();

    act(() => changes.fire({ uiLang: 'zh-CN' }));

    expect(await screen.findByRole('button', { name: '暂停' })).toBeDefined();
    host.remove();
  });
});

describe('SidePlayer', () => {
  it('renders the bar with a control for each action', () => {
    renderPlayer(stateOf({ status: statusOf({ index: 1 }) }));

    expect(screen.getByRole('toolbar', { name: 'SayLoud' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Previous sentence' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Next sentence' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Playback speed 1×' })).toBeDefined();
  });

  it('shows pause while reading and play while paused', () => {
    const { push } = renderPlayer();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDefined();

    push(stateOf({ status: statusOf({ phase: 'paused' }) }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeDefined();
  });

  it('sends toggle when play/pause is clicked', () => {
    const { commands } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(commands).toEqual([{ type: 'toggle' }]);
  });

  it('disables the sentence controls at the ends of the document', () => {
    const { push } = renderPlayer(stateOf({ status: statusOf({ index: 0 }) }));

    const prev = screen.getByRole('button', { name: 'Previous sentence' });
    expect(prev.hasAttribute('disabled')).toBe(true);

    push(stateOf({ status: statusOf({ index: 2 }) }));
    const next = screen.getByRole('button', { name: 'Next sentence' });
    expect(next.hasAttribute('disabled')).toBe(true);
  });

  it('enables both sentence controls in the middle of the document', () => {
    renderPlayer(stateOf({ status: statusOf({ index: 1 }) }));

    expect(screen.getByRole('button', { name: 'Previous sentence' }).hasAttribute('disabled')).toBe(
      false
    );
    expect(screen.getByRole('button', { name: 'Next sentence' }).hasAttribute('disabled')).toBe(
      false
    );
  });

  it('steps the speed when the rate control is clicked', () => {
    const { commands } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed 1×' }));
    expect(commands).toEqual([{ type: 'setRate', rate: 1.25 }]);
  });

  it('reports the progress ring for screen readers', () => {
    renderPlayer(stateOf({ status: statusOf({ charsRead: 150, charsTotal: 300 }) }));

    const ring = screen.getByRole('button', { name: /Reading progress 50 percent/ });
    expect(ring).toBeDefined();
  });

  it('replaces the ring with an error marker and explains it in a card', () => {
    renderPlayer(
      stateOf({ status: statusOf({ phase: 'error', error: 'no-voice' }), error: 'no-voice' })
    );

    expect(screen.getByRole('img', { name: /Reading progress/ })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(en[HINTS['no-voice'].titleKey]);
    expect(screen.getByRole('status').textContent).toContain(en[HINTS['no-voice'].messageKey]);
  });

  it('explains an unreadable page even before the engine answers', () => {
    renderPlayer(stateOf({ status: null, hasContent: false, error: 'no-content' }));

    expect(screen.getByRole('status').textContent).toContain(en[HINTS['no-content'].messageKey]);
    // Nothing is playing, so the control offers to start rather than pause.
    expect(screen.getByRole('button', { name: 'Play' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers a way back once the reader has scrolled away', () => {
    const { returnToPosition } = renderPlayer(stateOf({ scrolledAway: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Back to position' }));
    expect(returnToPosition).toHaveBeenCalledOnce();
  });

  it('shows the remaining time while the pointer is over the bar', () => {
    renderPlayer(
      stateOf({
        status: statusOf({ charsRead: 0, charsTotal: 9_000, charsPerSec: 12 }),
      })
    );

    fireEvent.mouseEnter(screen.getByRole('toolbar'));
    expect(screen.getByRole('status').textContent).toContain('12:30 left');
  });

  it('maps the arrow keys and space to playback commands', () => {
    const { commands } = renderPlayer(stateOf({ status: statusOf({ index: 1 }) }));
    const toolbar = screen.getByRole('toolbar');

    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    fireEvent.keyDown(toolbar, { key: ' ' });

    expect(commands).toEqual([{ type: 'next' }, { type: 'prev' }, { type: 'toggle' }]);
  });

  it('leaves space to the button when a button has focus', () => {
    const { commands } = renderPlayer(stateOf({ status: statusOf({ index: 1 }) }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Next sentence' }), { key: ' ' });
    expect(commands).toEqual([]);
  });

  it('shows a spinner instead of the play icon while the sentence loads', () => {
    const { container } = renderPlayer(stateOf({ status: statusOf({ phase: 'loading' }) }));

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDefined();
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('asks for the settings panel when the gear is clicked', () => {
    const { onOpenSettings } = renderPlayer();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('offers the gear even when the document has nothing to read', () => {
    // Settings are how a user fixes a broken provider, so the gear must not be
    // gated on there being sentences to play.
    renderPlayer(stateOf({ status: statusOf({ total: 0 }) }));

    expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
  });

  it('renders its controls and hints in the reader’s language', () => {
    const fake = fakeController(stateOf({ status: null, error: 'no-content' }));
    render(
      <I18nProvider lang="zh-CN">
        <SidePlayer controller={fake.controller} onOpenSettings={() => {}} />
      </I18nProvider>
    );

    expect(screen.getByRole('button', { name: '设置' })).toBeDefined();
    expect(screen.getByRole('button', { name: '播放' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('没有可读内容');
  });
});
