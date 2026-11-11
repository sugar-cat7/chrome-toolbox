'use strict';
const comments = document.getElementById('comments');
const attribution = document.getElementById('attribution');
let config = { display: 'translated', maxItems: 20, translate: true };
let session = '';
const source = new EventSource(location.pathname.replace('/overlay/', '/events/'));
source.addEventListener('relay.reset.v1', (event) => {
  const data = JSON.parse(event.data);
  session = data.sessionId;
  comments.replaceChildren();
});
source.addEventListener('relay.config.v1', (event) => {
  config = JSON.parse(event.data);
  attribution.textContent = config.translate ? 'Built with PLaMo · 翻訳: PLaMo' : '';
  while (comments.children.length > config.maxItems) comments.firstElementChild.remove();
});
source.addEventListener('relay.comment.v1', (event) => {
  const data = JSON.parse(event.data);
  if (data.sessionId !== session) return;
  const row = document.createElement('li');
  const translation = data.translation ?? data.original;
  const text =
    config.display === 'original'
      ? data.original
      : config.display === 'both' && data.translation
        ? data.original + '\n' + data.translation
        : translation;
  row.textContent = data.author + ': ' + text;
  comments.append(row);
  while (comments.children.length > Math.min(100, config.maxItems))
    comments.firstElementChild.remove();
});
window.addEventListener('pagehide', () => source.close(), { once: true });
