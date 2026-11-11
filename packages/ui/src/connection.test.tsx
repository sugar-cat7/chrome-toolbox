import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { ConnectionPanel, type ConnectionAdapter } from './connection.tsx';

afterEach(cleanup);
const adapter = (check: Result<{ models: readonly string[] }>): ConnectionAdapter => ({
  load: vi.fn<ConnectionAdapter['load']>().mockResolvedValue(Ok('http://127.0.0.1:18083')),
  check: vi.fn<ConnectionAdapter['check']>().mockResolvedValue(check),
});

describe('llama.cpp connection panel', () => {
  it.each([
    {
      result: Ok({ models: ['qwen-4b'] }),
      status: 'connected',
      text: '接続済み（モデル: qwen-4b）',
    },
    { result: Ok({ models: [] }), status: 'connected', text: '接続済み（モデル: なし）' },
    {
      result: Err(failure('network_failed')),
      status: 'failed',
      text: 'llama.cpp に接続できません',
    },
    { result: Err(failure('host_permission_denied')), status: 'failed', text: 'アクセスが許可' },
    {
      result: Err(failure('unexpected_failure')),
      status: 'failed',
      text: '接続確認に失敗しました',
    },
  ])('shows $status for the checked URL', async ({ result, status, text }) => {
    const actions = adapter(result);
    render(<ConnectionPanel title="字幕翻訳" adapter={actions} />);
    const input = screen.getByLabelText('llama.cpp の接続先');
    expect(await screen.findByDisplayValue('http://127.0.0.1:18083')).toBe(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'http://192.0.2.20:8080');
    await userEvent.click(screen.getByRole('button', { name: '接続を確認' }));
    const output = await screen.findByText(new RegExp(text));
    expect(output.getAttribute('data-status')).toBe(status);
    expect(actions.check).toHaveBeenCalledWith('http://192.0.2.20:8080');
  });

  it('keeps a URL typed before the stored one loads, and checks that URL', async () => {
    const actions = adapter(Ok({ models: ['stub-model'] }));
    let loaded: (value: Result<string>) => void = () => undefined;
    vi.mocked(actions.load).mockReturnValue(
      new Promise((resolve) => {
        loaded = resolve;
      }),
    );
    render(<ConnectionPanel title="コメント" adapter={actions} />);
    const input = screen.getByLabelText('llama.cpp の接続先');
    await userEvent.type(input, 'http://127.0.0.1:65000');
    await act(async () => {
      loaded(Ok('http://127.0.0.1:18083'));
      await Promise.resolve();
    });
    expect(input).toHaveProperty('value', 'http://127.0.0.1:65000');
    await userEvent.click(screen.getByRole('button', { name: '接続を確認' }));
    expect(await screen.findByText('接続済み（モデル: stub-model）')).toBeTruthy();
    expect(actions.check).toHaveBeenCalledWith('http://127.0.0.1:65000');
  });

  it('explains a stored-settings failure without losing the form', async () => {
    const actions = adapter(Ok({ models: [] }));
    vi.mocked(actions.load).mockResolvedValue(Err(failure('storage_failed')));
    render(<ConnectionPanel title="コメント" adapter={actions} />);
    expect(await screen.findByText('設定を保存できませんでした。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '接続を確認' })).toBeTruthy();
  });
});
