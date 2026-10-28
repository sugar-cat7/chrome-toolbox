export const presets = ['web', 'api', 'desktop', 'fullstack', 'fullstack-desktop'] as const;
export type Preset = (typeof presets)[number];
export type Feature = 'd1' | 'kv' | 'r2' | 'services';
export const verificationCases: { key: string; preset: Preset; features: string }[] = [
  { key: 'web', preset: 'web', features: '' },
  { key: 'api', preset: 'api', features: '' },
  { key: 'desktop', preset: 'desktop', features: '' },
  { key: 'fullstack', preset: 'fullstack', features: 'd1,kv,r2' },
  { key: 'fullstack-desktop', preset: 'fullstack-desktop', features: 'd1,kv,r2' },
  { key: 'web-bindings', preset: 'web', features: 'd1,kv,r2' },
  { key: 'api-bindings', preset: 'api', features: 'd1,kv,r2' },
  ...(['web', 'api'] as const).flatMap((preset) =>
    ['d1', 'kv', 'r2'].map((feature) => ({
      key: `${preset}-${feature}`,
      preset,
      features: feature,
    })),
  ),
];
export type ProjectOptions = {
  name: string;
  scope: string;
  identifier: string;
  preset: Preset;
  features: Feature[];
};

const safeName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export function validateName(name: string): void {
  if (name.length > 40 || !safeName.test(name) || windowsReserved.test(name)) {
    throw new Error(
      'Name must be 1–40 lowercase letters, digits and hyphens, start with a letter, and not be an OS reserved name',
    );
  }
}

export function projectOptions(input: Record<string, string | boolean>): ProjectOptions {
  if (typeof input.name !== 'string' || typeof input.scope !== 'string') {
    throw new Error(
      'Non-interactive initialization requires --name and --scope; --preset defaults to web',
    );
  }
  validateName(input.name);
  if (!/^@[a-z][a-z0-9-]{0,39}$/u.test(input.scope))
    throw new Error('--scope must be @ followed by lowercase letters, digits or hyphens');
  const preset =
    input.preset === 'fullstack+desktop' ? 'fullstack-desktop' : (input.preset ?? 'web');
  if (!presets.includes(preset as Preset))
    throw new Error(`--preset must be ${presets.join(', ')}`);
  const identifier = input.identifier ?? `com.example.${input.name.replaceAll('-', '')}`;
  if (
    typeof identifier !== 'string' ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/u.test(identifier)
  ) {
    throw new Error('--identifier must be a reverse-DNS identifier with at least three segments');
  }
  const features =
    typeof input.features === 'string' && input.features !== '' ? input.features.split(',') : [];
  if (features.some((value) => !['d1', 'kv', 'r2', 'services'].includes(value)))
    throw new Error('--features accepts d1,kv,r2,services');
  if (preset === 'desktop' && features.length > 0)
    throw new Error('Cloudflare features are not valid for desktop-only');
  if (preset === 'fullstack' || preset === 'fullstack-desktop') features.push('services');
  if (features.includes('services') && preset !== 'fullstack' && preset !== 'fullstack-desktop')
    throw new Error('Service Bindings require a fullstack preset');
  return {
    name: input.name,
    scope: input.scope,
    identifier,
    preset: preset as Preset,
    features: [...new Set(features)].sort() as Feature[],
  };
}

export function selectedPackages(options: ProjectOptions): string[] {
  const applications =
    options.preset === 'fullstack-desktop'
      ? ['api', 'web', 'desktop']
      : options.preset === 'fullstack'
        ? ['api', 'web']
        : [options.preset];
  return [
    'contracts',
    'observability',
    ...(applications.some((name) => name !== 'api') ? ['ui'] : []),
    ...applications,
  ];
}

export function flags(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key in result) throw new Error(`Duplicate argument: --${key}`);
    if (
      [
        'dry-run',
        'reference',
        'check',
        'no-install',
        'smoke',
        'recover',
        'generate-only',
        'faults',
        'hooks',
        'lifecycle',
      ].includes(key)
    )
      result[key] = true;
    else {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
      result[key] = value;
      index += 1;
    }
  }
  return result;
}
