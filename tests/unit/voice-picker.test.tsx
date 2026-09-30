import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { VoicePicker, type VoicePickerProps } from '~/entrypoints/sidepanel/VoicePicker';
import type { ConfigStore } from '~/lib/config-store';
import { PROVIDER_SCHEMAS } from '~/lib/providers/config-schema';
import type { Provider, Voice } from '~/lib/providers/types';

const VOICES: Voice[] = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', lang: 'zh-CN', gender: 'female' },
  { id: 'zh_male_yunzhou_uranus_bigtts', name: '云舟 2.0', lang: 'zh-CN', gender: 'male' },
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim', lang: 'en-US', gender: 'male' },
];

function setup(overrides: Partial<VoicePickerProps> = {}) {
  const saved: string[] = [];
  const store = {
    getSelectedVoice: vi.fn(() => Promise.resolve(null)),
    saveSelectedVoice: vi.fn((_provider: string, voiceId: string) => {
      saved.push(voiceId);
      return Promise.resolve();
    }),
  } as unknown as ConfigStore;
  const provider = {
    listVoices: vi.fn(() => Promise.resolve(VOICES)),
  } as unknown as Provider;

  render(
    <VoicePicker
      schema={PROVIDER_SCHEMAS.volcengine}
      provider={provider}
      config={{ provider: 'volcengine', apiKey: 'k' }}
      store={store}
      disabled={false}
      onAttempt={() => {}}
      showFormErrors={false}
      {...overrides}
    />
  );
  return { saved, store };
}

async function loadVoices(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Load Voices' }));
  await screen.findByText('3 voices.');
}

describe('VoicePicker', () => {
  it('filters the list by name, id or language', async () => {
    setup();
    await loadVoices();

    const filter = screen.getByRole('searchbox', { name: 'Filter voices' });

    fireEvent.input(filter, { target: { value: '云舟' } });
    expect(screen.getAllByRole('radio')).toHaveLength(1);

    fireEvent.input(filter, { target: { value: 'en-us' } });
    expect(screen.getByText('Tim')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(1);

    fireEvent.input(filter, { target: { value: 'VV_URANUS' } });
    expect(screen.getByText('Vivi 2.0')).toBeTruthy();

    fireEvent.input(filter, { target: { value: 'nothing-matches' } });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText('No voice matches “nothing-matches”.')).toBeTruthy();
  });

  it('saves a voice id typed by hand, without loading the list', async () => {
    const { saved } = setup();

    fireEvent.input(screen.getByRole('textbox', { name: 'Voice id' }), {
      target: { value: '  S_my_cloned_voice  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this id' }));

    await waitFor(() => expect(saved).toEqual(['S_my_cloned_voice']));
    expect(await screen.findByText('Voice saved: S_my_cloned_voice')).toBeTruthy();
  });

  it('does not save an empty id', () => {
    const { saved } = setup();

    fireEvent.input(screen.getByRole('textbox', { name: 'Voice id' }), {
      target: { value: '   ' },
    });

    expect(
      (screen.getByRole('button', { name: 'Use this id' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(saved).toEqual([]);
  });

  it('checks the listed voice a typed id names', async () => {
    setup();
    await loadVoices();

    fireEvent.input(screen.getByRole('textbox', { name: 'Voice id' }), {
      target: { value: 'zh_male_yunzhou_uranus_bigtts' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this id' }));

    await waitFor(() => {
      const checked = screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked);
      expect(checked).toHaveLength(1);
    });
  });
});
