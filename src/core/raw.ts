/** Decode Maestri-style raw escapes: \n \t \r \e (ESC) \xNN (byte). */
export function decodeRawEscapes(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\e/g, '\x1b')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
}
