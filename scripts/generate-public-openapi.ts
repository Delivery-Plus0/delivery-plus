import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERVICE_PREFIXES,
  generateAdminOpenApiDocument,
  generatePublicOpenApiDocument,
} from '../services/api-gateway/src/public-openapi';

export * from '../services/api-gateway/src/public-openapi';

if (require.main === module) {
  const outputDir = join(process.cwd(), 'docs', 'openapi');

  const publicPath = join(outputDir, 'delivery-plus-public.json');
  const publicDoc = generatePublicOpenApiDocument();
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(publicPath, `${JSON.stringify(publicDoc, null, 2)}\n`, 'utf8');
  console.log(`Generated public OpenAPI contract at ${publicPath}`);
  console.log(`Service prefixes covered: ${SERVICE_PREFIXES.join(', ')}`);

  // #212: the admin contract lives beside the public one and never shares a path with it.
  const adminPath = join(outputDir, 'admin.json');
  const adminDoc = generateAdminOpenApiDocument();
  writeFileSync(adminPath, `${JSON.stringify(adminDoc, null, 2)}\n`, 'utf8');
  console.log(`Generated admin OpenAPI contract at ${adminPath}`);
}
