// Portal SLZ — arquivos das notas fiscais e comprovantes, guardados no Cloudflare R2.
// A página nunca fala direto com o R2 usando chave: esta função confere a permissão de quem pediu
// e devolve um link assinado que vale poucos minutos, só para aquele arquivo.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const BUCKET = Deno.env.get('R2_BUCKET') || 'portal-slz-documentos';
const R2_BASE = `https://${Deno.env.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${BUCKET}`;
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID') || '',
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY') || '',
  service: 's3',
  region: 'auto'
});

const TIPOS: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif'
};
const TAMANHO_MAX = 25 * 1024 * 1024;   // 25 MB por arquivo
const ARQUIVOS_MAX = 10;                // por documento

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const erro = (msg: string, status = 400) => resposta({ erro: msg }, status);

const urlObjeto = (chave: string) => `${R2_BASE}/${chave.split('/').map(encodeURIComponent).join('/')}`;
async function assinar(metodo: string, chave: string, segundos: number, extras: Record<string, string> = {}) {
  const u = new URL(urlObjeto(chave));
  u.searchParams.set('X-Amz-Expires', String(segundos));
  for (const [k, v] of Object.entries(extras)) u.searchParams.set(k, v);
  const req = await r2.sign(new Request(u, { method: metodo }), { aws: { signQuery: true } });
  return req.url;
}
const apagarObjeto = (chave: string) => r2.fetch(urlObjeto(chave), { method: 'DELETE' });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro('Use POST.', 405);
  if (!Deno.env.get('R2_SECRET_ACCESS_KEY')) return erro('Armazenamento de arquivos ainda não configurado.', 503);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: sessao } = await admin.auth.getUser(token);
  const eu = sessao?.user;
  if (!eu) return erro('Faça login novamente.', 401);
  // cliente com o login da pessoa: as regras do banco (RLS) decidem o que ela enxerga
  const usuario = createClient(SB_URL, SB_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  let corpo: Record<string, any>;
  try { corpo = await req.json(); } catch { return erro('Corpo inválido.'); }

  // documento visível para a pessoa + se ela pode mexer nos arquivos dele
  async function documentoEditavel(id: string) {
    const { data: doc } = await usuario.from('documentos').select('id, condominio_id, competencia, status').eq('id', id).maybeSingle();
    if (!doc) return { falha: erro('Documento não encontrado.', 404) };
    const [{ data: podeEnviar }, { data: equipe }] = await Promise.all([
      usuario.rpc('pode_enviar', { cid: doc.condominio_id }),
      usuario.rpc('pode_editar_escritorio')
    ]);
    if (!podeEnviar) return { falha: erro('Seu acesso não permite alterar este documento.', 403) };
    if (doc.status === 'conferido' && !equipe) return { falha: erro('Este documento já foi conferido pelo escritório.', 403) };
    return { doc };
  }

  try {
    switch (corpo.acao) {
      case 'upload_url': {
        const { documento_id, nome, tipo, tamanho, sha256 } = corpo;
        const ext = TIPOS[tipo];
        if (!ext) return erro('Envie PDF ou foto (JPG, PNG, WEBP ou HEIC).');
        if (!(tamanho > 0) || tamanho > TAMANHO_MAX) return erro('Cada arquivo pode ter no máximo 25 MB.');
        if (!/^[0-9a-f]{64}$/.test(sha256 || '')) return erro('Assinatura do arquivo inválida.');
        const { doc, falha } = await documentoEditavel(documento_id);
        if (falha) return falha;
        const { count } = await admin.from('documento_arquivos').select('id', { count: 'exact', head: true }).eq('documento_id', doc.id);
        if ((count || 0) >= ARQUIVOS_MAX) return erro(`Cada documento pode ter até ${ARQUIVOS_MAX} arquivos.`);
        const chave = `${doc.condominio_id}/${doc.competencia}/${doc.id}/${crypto.randomUUID()}.${ext}`;
        const { data: arq, error } = await admin.from('documento_arquivos').insert({
          documento_id: doc.id, chave, nome_original: String(nome || 'arquivo.' + ext).slice(0, 200),
          tipo_mime: tipo, tamanho, sha256, criado_por: eu.id
        }).select('id').single();
        if (error) return erro(error.message);
        return resposta({ arquivo_id: arq.id, url: await assinar('PUT', chave, 900) });
      }

      case 'confirmar': {
        // confere no R2 se o arquivo chegou inteiro (mesmo tamanho) antes de marcar como recebido
        const { data: arq } = await admin.from('documento_arquivos').select('*').eq('id', corpo.arquivo_id).maybeSingle();
        if (!arq || arq.criado_por !== eu.id) return erro('Arquivo não encontrado.', 404);
        const cab = await r2.fetch(urlObjeto(arq.chave), { method: 'HEAD' });
        if (!cab.ok || Number(cab.headers.get('content-length')) !== Number(arq.tamanho)) {
          await apagarObjeto(arq.chave);
          await admin.from('documento_arquivos').delete().eq('id', arq.id);
          return erro('O arquivo não chegou inteiro. Tente enviar de novo.');
        }
        await admin.from('documento_arquivos').update({ confirmado: true }).eq('id', arq.id);
        return resposta({ ok: true });
      }

      case 'download_url': {
        // a pessoa só consegue o link se as regras do banco deixarem ela ver o arquivo
        const { data: arq } = await usuario.from('documento_arquivos').select('chave, nome_original, tipo_mime, confirmado').eq('id', corpo.arquivo_id).maybeSingle();
        if (!arq || !arq.confirmado) return erro('Arquivo não encontrado.', 404);
        const modo = corpo.abrir ? 'inline' : 'attachment';
        const url = await assinar('GET', arq.chave, 600, {
          'response-content-disposition': `${modo}; filename*=UTF-8''${encodeURIComponent(arq.nome_original)}`,
          'response-content-type': arq.tipo_mime
        });
        return resposta({ url });
      }

      case 'excluir_arquivo': {
        const { data: arq } = await usuario.from('documento_arquivos').select('id, chave, documento_id').eq('id', corpo.arquivo_id).maybeSingle();
        if (!arq) return erro('Arquivo não encontrado.', 404);
        const { falha } = await documentoEditavel(arq.documento_id);
        if (falha) return falha;
        await apagarObjeto(arq.chave);
        await admin.from('documento_arquivos').delete().eq('id', arq.id);
        return resposta({ ok: true });
      }

      case 'excluir_documento': {
        const { data: arquivos } = await usuario.from('documento_arquivos').select('chave').eq('documento_id', corpo.documento_id);
        // quem decide se pode excluir é a regra do banco
        const { data: apagados, error } = await usuario.from('documentos').delete().eq('id', corpo.documento_id).select('id');
        if (error) return erro(error.message);
        if (!apagados || !apagados.length) return erro('Seu acesso não permite excluir este documento.', 403);
        await Promise.all((arquivos || []).map(a => apagarObjeto(a.chave)));
        return resposta({ ok: true });
      }

      // ---------- extratos OFX (só devs) ----------
      case 'extrato_upload_url':
      case 'extrato_confirmar':
      case 'extrato_download_url':
      case 'extrato_excluir': {
        const { data: ehSuper } = await usuario.rpc('e_super');
        if (!ehSuper) return erro('Apenas os devs mexem nos extratos.', 403);
        const { data: ext } = await usuario.from('extratos').select('id, condominio_id, competencia, chave, tamanho, nome_arquivo').eq('id', corpo.extrato_id).maybeSingle();
        if (!ext) return erro('Extrato não encontrado.', 404);

        if (corpo.acao === 'extrato_upload_url') {
          if (!(corpo.tamanho > 0) || corpo.tamanho > 10 * 1024 * 1024) return erro('O OFX pode ter no máximo 10 MB.');
          const chave = `extratos/${ext.condominio_id}/${ext.competencia}/${ext.id}.ofx`;
          await admin.from('extratos').update({ chave, tamanho: corpo.tamanho }).eq('id', ext.id);
          return resposta({ url: await assinar('PUT', chave, 900) });
        }
        if (corpo.acao === 'extrato_confirmar') {
          const cab = ext.chave ? await r2.fetch(urlObjeto(ext.chave), { method: 'HEAD' }) : null;
          if (!cab || !cab.ok || Number(cab.headers.get('content-length')) !== Number(ext.tamanho)) return erro('O arquivo do extrato não chegou inteiro.');
          await admin.from('extratos').update({ arquivo_confirmado: true }).eq('id', ext.id);
          return resposta({ ok: true });
        }
        if (corpo.acao === 'extrato_download_url') {
          if (!ext.chave) return erro('O arquivo original deste extrato não foi guardado.', 404);
          return resposta({ url: await assinar('GET', ext.chave, 600, {
            'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(ext.nome_arquivo)}`
          }) });
        }
        // excluir: apaga os lançamentos (cascata), o registro e o arquivo
        if (ext.chave) await apagarObjeto(ext.chave);
        await admin.from('extratos').delete().eq('id', ext.id);
        return resposta({ ok: true });
      }

      default:
        return erro('Ação desconhecida.');
    }
  } catch (e) {
    return erro(String(e instanceof Error ? e.message : e), 500);
  }
});
