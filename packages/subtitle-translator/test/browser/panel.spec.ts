import { defaultResponder, withoutAudio } from '@chrome-toolbox/extension-core/testing';
import { expect, test, setServer } from './server.ts';

const AUDIO_MISSING =
  '音声入力が使えません。llama.cpp のプリセットで mmproj を有効にして、サーバーを再起動してください（docs/llama-server.md）';

test('side panel asks only the server it points at whether it takes audio input', async ({
  sidePanel,
  serviceWorker,
  llama,
}) => {
  // Opened against an address where nothing listens: the panel cannot tell.
  await expect(sidePanel.getByText('音声入力: 確認できません', { exact: false })).toBeVisible();
  expect(llama.requests).toEqual([]);

  await setServer(serviceWorker, llama.origin);
  await sidePanel.reload();
  await expect(sidePanel.getByText('音声入力: 使えます')).toBeVisible();
  expect(llama.requests.toSorted()).toEqual(['GET /props?model=gemma4-e4b', 'GET /v1/models']);

  // Without a projector, 更新 asks again and the panel says how to add one.
  llama.respond = withoutAudio(defaultResponder);
  await sidePanel
    .getByRole('region', { name: '状態' })
    .getByRole('button', { name: '更新' })
    .click();
  await expect(sidePanel.getByText(AUDIO_MISSING)).toBeVisible();
  await expect(sidePanel.getByText('ツールバーのアイコンか Alt+Shift+S で開始')).toBeVisible();
});
