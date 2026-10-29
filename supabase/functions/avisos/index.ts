// Portal SLZ — aviso no celular dos devs quando uma síndica envia documento.
// Quem chama é o próprio banco (gatilho em documento_arquivos), assim que o primeiro arquivo chega no R2.
// Não precisa de login: a função só avisa uma vez por documento, e só documento recente com arquivo recebido.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import * as webpush from 'jsr:@negrel/webpush@0.5.0';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const TIPOS: Record<string, string> = { nota_fiscal: 'Nota fiscal', comprovante: 'Comprovante', recibo: 'Recibo', boleto: 'Boleto', outro: 'Documento' };
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

let servidor: webpush.ApplicationServer | null = null;
async function appServer() {
  if (!servidor) {
    const chaves = await webpush.importVapidKeys(JSON.parse(Deno.env.get('VAPID_KEYS')!), { extractable: false });
    servidor = await webpush.ApplicationServer.new({ contactInformation: 'https://gerente-slz.vercel.app', vapidKeys: chaves });
  }
  return servidor;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return resposta({ erro: 'Use POST.' }, 405);
  if (!Deno.env.get('VAPID_KEYS')) return resposta({ erro: 'Avisos ainda não configurados.' }, 503);
  const { documento_id } = await req.json().catch(() => ({}));
  if (typeof documento_id !== 'string') return resposta({ erro: 'documento_id faltando.' }, 400);

  const { data: doc } = await admin.from('documentos')
    .select('id, condominio_id, competencia, tipo, fornecedor, valor, enviado_em, enviado_por, condominio:condominios(nome), enviado:perfis!enviado_por(nome, papel)')
    .eq('id', documento_id).maybeSingle();
  if (!doc) return resposta({ ok: false, motivo: 'documento não existe' });
  if (Date.now() - new Date(doc.enviado_em).getTime() > 24 * 3600e3) return resposta({ ok: false, motivo: 'documento antigo' });
  const { count } = await admin.from('documento_arquivos').select('id', { count: 'exact', head: true }).eq('documento_id', doc.id).eq('confirmado', true);
  if (!count) return resposta({ ok: false, motivo: 'sem arquivo recebido' });
  // marca antes de mandar: se a função for chamada duas vezes, só a primeira avisa
  const { error: jaAvisado } = await admin.from('avisos_enviados').insert({ documento_id: doc.id });
  if (jaAvisado) return resposta({ ok: false, motivo: 'já avisado' });

  // devs ativos, menos quem enviou
  const { data: devs } = await admin.from('perfis').select('id').eq('papel', 'super_master').eq('ativo', true).neq('id', doc.enviado_por ?? '');
  const ids = (devs || []).map(d => d.id);
  if (!ids.length) return resposta({ ok: true, enviados: 0 });
  const { data: aparelhos } = await admin.from('push_inscricoes').select('endpoint, p256dh, auth').in('perfil_id', ids);

  // deno-lint-ignore no-explicit-any
  const condo = (doc as any).condominio?.nome || 'Condomínio';
  // deno-lint-ignore no-explicit-any
  const quem = (doc as any).enviado?.nome;
  const corpo = [TIPOS[doc.tipo] || 'Documento', doc.fornecedor, doc.valor != null ? brl(Number(doc.valor)) : ''].filter(Boolean).join(' · ');
  const aviso = JSON.stringify({
    titulo: condo,
    corpo: corpo + (quem ? `\nEnviado por ${quem}` : ''),
    condominio_id: doc.condominio_id,
    competencia: doc.competencia,
    documento_id: doc.id
  });

  const app = await appServer();
  let enviados = 0;
  await Promise.all((aparelhos || []).map(async a => {
    try {
      await app.subscribe({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } })
        .pushTextMessage(aviso, { ttl: 3 * 24 * 3600, urgency: webpush.Urgency.High });
      enviados++;
    } catch (e) {
      // aparelho desativou os avisos ou desinstalou: tira da lista
      const st = e instanceof webpush.PushMessageError ? e.response.status : 0;
      if (st === 404 || st === 410) await admin.from('push_inscricoes').delete().eq('endpoint', a.endpoint);
      else console.error('falha ao avisar', st, String(e));
    }
  }));
  return resposta({ ok: true, enviados, aparelhos: (aparelhos || []).length });
});
