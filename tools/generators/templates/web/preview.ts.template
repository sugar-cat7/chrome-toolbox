import { convertToWranglerConfig, InputConfigSchema } from '@cloudflare/config';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { preview } from '../../tools/cloudflare/preview.ts';

await preview(
  (input) => convertToWranglerConfig(InputConfigSchema.parse(input)),
  await readBuildOutput(process.cwd()),
);
