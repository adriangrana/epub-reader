// epubjs 0.3.93 has an incorrect declaration for Rendition#getContents:
// the runtime API returns an array of Contents, but the bundled .d.ts declares
// a single Contents instance. Mark Contents as iterable so TypeScript matches
// the actual runtime shape used by Rendition#getContents without weakening
// type checking in the reader.

import 'epubjs/types/contents';

declare module 'epubjs/types/contents' {
  export default interface Contents {
    [Symbol.iterator](): IterableIterator<Contents>;
  }
}

export {};
