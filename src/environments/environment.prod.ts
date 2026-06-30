// Production environment. Substituted in for `environment.ts` during a
// production build (see `fileReplacements` in angular.json). The defaults below
// are relative/same-origin: the app expects the API and Socket.IO server to be
// served from the same domain as the frontend (e.g. behind a reverse proxy).
// Override these with absolute URLs if the backend lives on a different host.
export const environment = {
  production: true,
  // Same-origin `/api`; the global `/api` prefix is set by the backend.
  apiUrl: '/api',
  // Empty string makes the Socket.IO client connect to the page's own origin.
  // Routing to the backend is handled by the client's `path` (/api/socket.io),
  // not by this URL — see presence.service.ts.
  socketUrl: '',
};
