import { createFileRoute } from '@tanstack/react-router';

// Remove this marker when adding controls that need client-side interaction.
export const Route = createFileRoute('/about')({
  head: () => ({ meta: [{ name: 'app-client', content: 'static' }] }),
  component: () => (
    <section className="mx-auto max-w-2xl rounded-xl border p-6">
      <h1 className="text-3xl font-semibold">About this sample</h1>
      <p className="my-3">
        This small app demonstrates server rendering, browser hydration and a local notes API.
        Deployment disables unauthenticated writes.
      </p>
    </section>
  ),
});
