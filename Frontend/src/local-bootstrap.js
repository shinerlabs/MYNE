import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
await import('./local-viewer.js');
