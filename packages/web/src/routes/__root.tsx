import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import '../styles.css';
import favicon from '../favicon.svg?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'super-starter' },
      {
        name: 'description',
        content: 'A small, accessible notes workspace with clear local storage and JSON export.',
      },
    ],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: favicon }],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only">
          Skip to content
        </a>
        <nav aria-label="Main" className="mx-auto flex max-w-2xl gap-4 py-6">
          <Link to="/">Notes</Link>
          <Link to="/about">About</Link>
        </nav>
        <main id="main">
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  ),
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <Link to="/">Return to notes</Link>
    </section>
  ),
  errorComponent: () => (
    <section role="alert">
      <h1>Something went wrong</h1>
      <p>Reload the page to try again.</p>
    </section>
  ),
});
