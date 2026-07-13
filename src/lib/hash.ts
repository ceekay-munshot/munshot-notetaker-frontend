// Tiny, dependency-free, stable string hash → short base36 token. A client-side
// twin of the server's `hashKey` (server/feeds.ts) so the UI can derive
// deterministic things (e.g. a cover color for a search result) WITHOUT importing
// server-only modules into the browser bundle.
export function stableHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
