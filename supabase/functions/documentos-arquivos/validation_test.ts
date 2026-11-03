import { mimeConfere } from './validation.ts';

Deno.test('confere assinaturas de tipos aceitos', () => {
  const bytes = (texto: string) => new TextEncoder().encode(texto);
  if (!mimeConfere('application/pdf', bytes('%PDF-1.7'))) throw new Error('PDF válido rejeitado');
  if (!mimeConfere('image/webp', bytes('RIFF0000WEBP'))) throw new Error('WEBP válido rejeitado');
  if (!mimeConfere('image/heic', bytes('0000ftypheic'))) throw new Error('HEIC válido rejeitado');
  if (!mimeConfere('image/heif', bytes('0000ftypmif1'))) throw new Error('HEIF válido rejeitado');
  if (!mimeConfere('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0x00]))) throw new Error('JPEG válido rejeitado');
  if (!mimeConfere('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('PNG válido rejeitado');
});

Deno.test('rejeita tipo declarado que não corresponde aos bytes', () => {
  const texto = new TextEncoder().encode('<html>conteúdo executável</html>');
  for (const tipo of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    if (mimeConfere(tipo, texto)) throw new Error(`Conteúdo HTML aceito como ${tipo}`);
  }
  if (mimeConfere('application/octet-stream', texto)) throw new Error('Tipo não permitido aceito');
});
