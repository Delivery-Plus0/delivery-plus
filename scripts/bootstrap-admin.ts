/**
 * Creates the first super admin from a workstation (#202, moved from #234). Same code as the
 * auth-service image's `node dist/bootstrap/cli.js`; see docs/runbooks/bootstrap-admin.md.
 *
 *   DATABASE_URL=postgres://…/auth_service BOOTSTRAP_ADMIN_EMAIL=ops@example.com npm run bootstrap:admin
 */
import { main } from '../services/auth-service/src/bootstrap/cli';

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Bootstrap failed:', error instanceof Error ? error.message.split('\n')[0] : 'unknown error');
    process.exit(1);
  });
