import { describe, expect, it, vi } from 'vitest';
import {
  isOpenSettingsMessage,
  OPEN_SETTINGS,
  type OpenSettingsDeps,
  openSettingsFor,
} from '~/lib/open-settings';

function deps(overrides: Partial<OpenSettingsDeps> = {}): OpenSettingsDeps {
  return {
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    options: { openOptionsPage: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('isOpenSettingsMessage', () => {
  it('accepts the reader request', () => {
    expect(isOpenSettingsMessage({ type: OPEN_SETTINGS })).toBe(true);
  });

  it('rejects engine traffic and junk', () => {
    expect(isOpenSettingsMessage({ type: 'load' })).toBe(false);
    expect(isOpenSettingsMessage({ type: 'status' })).toBe(false);
    expect(isOpenSettingsMessage(null)).toBe(false);
    expect(isOpenSettingsMessage('sayloud:open-settings')).toBe(false);
    expect(isOpenSettingsMessage({})).toBe(false);
  });
});

describe('openSettingsFor', () => {
  it('opens the panel for the tab the click came from', () => {
    const d = deps();

    openSettingsFor(42, d);

    expect(d.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(d.options.openOptionsPage).not.toHaveBeenCalled();
  });

  it('calls sidePanel.open synchronously', () => {
    // The whole reason this module exists: `sidePanel.open()` consumes the
    // click's transient activation, and Chrome's window for it is about five
    // seconds. An `await` before the call spends it, so the call has to have
    // happened by the time this function returns.
    const d = deps();

    openSettingsFor(7, d);

    expect(d.sidePanel.open).toHaveBeenCalledTimes(1);
  });

  it('falls back to the options page when the gesture has expired', async () => {
    const open = vi
      .fn()
      .mockRejectedValue(new Error('may only be called in response to a gesture'));
    const d = deps({ sidePanel: { open } });

    openSettingsFor(1, d);
    await vi.waitFor(() => expect(d.options.openOptionsPage).toHaveBeenCalledTimes(1));
  });

  it('does not reject when the fallback fails too', async () => {
    // Neither entry point being reachable must not surface as an unhandled
    // rejection in the worker.
    const open = vi.fn().mockRejectedValue(new Error('no gesture'));
    const openOptionsPage = vi.fn().mockRejectedValue(new Error('no options page'));
    const d = deps({ sidePanel: { open }, options: { openOptionsPage } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    openSettingsFor(1, d);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());

    logged.mockRestore();
  });
});
