export function isBlockedInternalRoute(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return (
    normalizedPath === '/internal' ||
    normalizedPath.startsWith('/internal/') ||
    normalizedPath === '/api/users/internal' ||
    normalizedPath.startsWith('/api/users/internal/') ||
    /^\/api\/restaurants\/[^/]+\/ownership(?:\/|$)/.test(normalizedPath)
  );
}