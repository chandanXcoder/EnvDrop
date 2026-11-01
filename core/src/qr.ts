import { encode, renderUnicodeCompact } from 'uqr';

/** QR modules as a boolean matrix (true = dark), for rendering with DOM/SVG rects. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 2 }).data;
}

/** Compact QR using Unicode half blocks, for terminals. */
export function qrTerminal(text: string): string {
  return renderUnicodeCompact(text, { ecc: 'L', border: 2 });
}
