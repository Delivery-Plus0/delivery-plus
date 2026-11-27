export function isBlockedInternalRoute(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return (
    normalizedPath === '/internal' ||
    normalizedPath.startsWith('/internal/') ||
    normalizedPath === '/api/users/internal' ||
    // #212: /api/menus rewrites to the menu-service root, so /api/menus/admin/... would be a
    // second way into menu-service's /admin routes. Staff use /api/admin/menus only.
    normalizedPath === '/api/menus/admin' ||
    normalizedPath.startsWith('/api/menus/admin/') ||
    normalizedPath.startsWith('/api/users/internal/') ||
    /^\/api\/restaurants\/[^/]+\/ownership(?:\/|$)/.test(normalizedPath) ||
    // #211: the restaurant's contact phone is for delivery-service only (SYSTEM token).
    /^\/api\/restaurants\/[^/]+\/contact(?:\/|$)/.test(normalizedPath)
  );
}