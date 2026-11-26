import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERVICE_PREFIXES,
  validateAdminOpenApiDocument,
  validatePublicOpenApiDocument,
} from '../services/api-gateway/src/public-openapi';

export { SERVICE_PREFIXES, validateAdminOpenApiDocument, validatePublicOpenApiDocument } from '../services/api-gateway/src/public-openapi';

if (require.main === module) {
  const publicPath = join(process.cwd(), 'docs', 'openapi', 'delivery-plus-public.json');
  const publicDoc = JSON.parse(readFileSync(publicPath, 'utf8')) as Record<string, any>;
  validatePublicOpenApiDocument(publicDoc);
  console.log(`Validated public OpenAPI contract at ${publicPath}`);
  console.log(`Paths checked: ${Object.keys(publicDoc.paths).length}`);
  console.log(`Service prefixes covered: ${SERVICE_PREFIXES.join(', ')}`);

  // #212: the admin contract gets the same CI treatment as the public one.
  const adminPath = join(process.cwd(), 'docs', 'openapi', 'admin.json');
  const adminDoc = JSON.parse(readFileSync(adminPath, 'utf8')) as Record<string, any>;
  validateAdminOpenApiDocument(adminDoc);
  console.log(`Validated admin OpenAPI contract at ${adminPath}`);
  console.log(`Paths checked: ${Object.keys(adminDoc.paths).length}`);
}
