export function isBlockedInternalRoute(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return (
    normalizedPath === '/internal' ||
    normalizedPath.startsWith('/internal/') ||
    normalizedPath === '/api/users/internal' ||
    normalizedPath.startsWith('/api/users/internal/') ||
    /^\/api\/restaurants\/[^/]+\/ownership(?:\/|$)/.test(normalizedPath) ||
    // #211: the restaurant's contact phone is for delivery-service only (SYSTEM token).
    /^\/api\/restaurants\/[^/]+\/contact(?:\/|$)/.test(normalizedPath)
  );
}