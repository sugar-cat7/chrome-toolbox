// A made-up feed that keeps growing: every second the page's own script adds `FEED_RATE` posts at
// the bottom and removes the oldest ones past `FEED_KEEP`, as an endless timeline does. A test may
// add a backlog at once (`window.fixturePost(count)`).

export const FEED_URL = 'https://feed.fixture.test/home';
/** Posts added a second, and the most the page keeps. */
export const FEED_RATE = 5;
export const FEED_KEEP = 200;

/**
 * The page's own script: `window.fixturePosted` is the number of the newest post, and
 * `window.fixturePost(count)` adds `count` posts now.
 */
function feedScript(rate: number, keep: number): void {
  const endings = [
    'the ferry left on time for once.',
    'someone painted the old pier blue overnight.',
    'the bakery on the corner ran out of rye bread before noon.',
    'a lost kite was found on the lighthouse roof.',
    'the market moved one street closer to the water.',
    'rain is expected after midnight, then a clear morning.',
    'the choir practised in the boathouse again.',
  ];
  const feed = document.getElementById('feed');
  if (feed === null) return;
  let posted = 0;
  const post = (): void => {
    posted += 1;
    const item = document.createElement('article');
    item.className = 'post';
    const text = document.createElement('p');
    const ending = endings[posted % endings.length] ?? '';
    // Every fourth post links to a tag, as feeds do.
    if (posted % 4 === 0) {
      text.append(`Post ${posted}: near the `);
      const tag = document.createElement('a');
      tag.href = `/tags/harbor-${posted}`;
      tag.textContent = 'harbor';
      text.append(tag, `, ${ending}`);
    } else text.textContent = `Post ${posted}: ${ending}`;
    item.append(text);
    feed.append(item);
    while (feed.childElementCount > keep) feed.firstElementChild?.remove();
    Object.assign(window, { fixturePosted: posted });
  };
  const postMany = (count: number): void => {
    for (let i = 0; i < count; i += 1) post();
  };
  Object.assign(window, { fixturePost: postMany });
  postMany(20);
  setInterval(() => postMany(rate), 1000);
}

export const feedHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Harbor town feed</title>
    <style>
      body { margin: 0; font: 16px/22px sans-serif; }
      .post { margin: 0 16px; padding: 12px 0; border-bottom: 1px solid #ddd; }
      .post p { margin: 0; }
    </style>
  </head>
  <body>
    <main id="feed"></main>
    <script>(${feedScript.toString()})(${FEED_RATE}, ${FEED_KEEP});</script>
  </body>
</html>`;
