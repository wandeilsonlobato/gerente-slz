export function mimeConfere(tipo: string, bytes: Uint8Array) {
  const ascii = (inicio: number, fim: number) => String.fromCharCode(...bytes.slice(inicio, fim));
  if (tipo === 'application/pdf') return ascii(0, 5) === '%PDF-';
  if (tipo === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (tipo === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
  if (tipo === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (tipo === 'image/heic' || tipo === 'image/heif') {
    return /^ftyp(?:heic|heix|hevc|hevx|mif1|msf1)/.test(ascii(4, Math.min(bytes.length, 64)));
  }
  return false;
}
