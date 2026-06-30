// Development environment. Used by `ng serve` / the `development` build
// configuration. Points at the locally running NestJS backend (see
// backend/.env). Angular swaps this file for `environment.prod.ts` in
// production builds via the `fileReplacements` rule in angular.json.
export const environment = {
  production: false,
  // Base URL of the REST API, including the backend's global `/api` prefix.
  apiUrl: 'http://localhost:3000/api',
  // Origin the Socket.IO client connects to for live presence updates.
  socketUrl: 'http://localhost:3000/api',
};
