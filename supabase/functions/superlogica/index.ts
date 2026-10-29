// Portal SLZ — leitura do Superlógica (API v2/condor).
// Regra herdada do projeto "slz automatização financeira": SOMENTE LEITURA.
// Esta função só faz GET no Superlógica; não existe nenhum caminho que altere dados lá.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const SL_BASE = (Deno.env.get('SUPERLOGICA_BASE_URL') || 'https://api.superlogica.net/v2/condor').replace(/\/+$/, '');
const SL_CABECALHOS = {
  app_token: Deno.env.get('SUPERLOGICA_APP_TOKEN') || '',
  access_token: Deno.env.get('SUPERLOGICA_ACCESS_TOKEN') || ''
};
// fora da carteira SLZ: testes (4, 8), não administrados (6, 7, 9, 10) e a própria administradora (13)
const EXCLUIR = new Set((Deno.env.get('SUPERLOGICA_EXCLUIR') || '4,6,7,8,9,10,13').split(',').map(x => Number(x.trim())).filter(Boolean));

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const erro = (msg: string, status = 400) => resposta({ erro: msg }, status);

// ---------- cliente somente leitura ----------
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));
async function slGet(caminho: string, params: Record<string, string | number>) {
  const u = new URL(`${SL_BASE}/${caminho}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const r = await fetch(u, { method: 'GET', headers: SL_CABECALHOS });
      if ([429, 502, 503, 504].includes(r.status) && tentativa < 4) { await espera(1000 * 2 ** tentativa); continue; }
      if (!r.ok) throw new Error(`Superlógica respondeu ${r.status} em ${caminho}`);
      return await r.json();
    } catch (e) {
      if (tentativa === 4) throw e;
      await espera(1000 * 2 ** tentativa);
    }
  }
}
async function slPaginado(caminho: string, params: Record<string, string | number>) {
  const todos: any[] = [];
  let anterior = '';
  for (let pagina = 1; pagina <= 200; pagina++) {
    const lote = await slGet(caminho, { ...params, pagina, itensPorPagina: 50 });
    const marca = JSON.stringify(lote);
    if (!Array.isArray(lote) || !lote.length || marca === anterior) break;   // fim, ou a API repetindo a página
    anterior = marca;
    todos.push(...lote);
    if (lote.length < 50) break;
  }
  return todos;
}
// a API do Superlógica usa datas no formato MM/DD/AAAA
const dataSL = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
function dataISO(s?: string) {
  if (!s) return null;
  const [m, d, a] = s.trim().split(' ')[0].split('/');
  return a && m && d ? `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}
const numero = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const nomeCondominio = (c: any) => (c.st_fantasia_cond || c.st_nome_cond || String(c.id_condominio_cond)).trim();

function despesa(r: any) {
  const aprop = r.apropriacao || [];
  return {
    id_despesa: String(r.id_despesa_des ?? ''),
    id_parcela: String(r.id_parcela_pdes ?? ''),
    favorecido: (r.st_nome_con || r.st_nomerecebedor_fav || '').trim(),
    // conta do plano de contas do condomínio, como aparece no Superlógica
    categoria: aprop.map((a: any) => `${a.st_conta_cont || ''} ${(a.st_descricao_cont || '').trim()}`.trim()).filter(Boolean).join('; '),
    grupo: [...new Set(aprop.map((a: any) => a.st_nomegruposaldo_gs || '').filter(Boolean))].join('; '),
    parcela: r.st_complemento_pdes || '',
    vencimento: dataISO(r.dt_vencimento_pdes),
    liquidacao: dataISO(r.dt_liquidacao_pdes),
    valor: Math.round(numero(r.vl_valor_pdes) * 100) / 100,
    documento: r.st_documento_des || '',
    conta_bancaria: (r.st_descricao_cb || '').trim(),
    observacao: r.st_observacao_des || '',
    anexos_superlogica: (r.arquivos || []).length
  };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro('Use POST.', 405);
  if (!SL_CABECALHOS.app_token || !SL_CABECALHOS.access_token) return erro('Ligação com o Superlógica ainda não configurada.', 503);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: sessao } = await admin.auth.getUser(token);
  const eu = sessao?.user;
  if (!eu) return erro('Faça login novamente.', 401);
  const usuario = createClient(SB_URL, SB_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  let corpo: Record<string, any>;
  try { corpo = await req.json(); } catch { return erro('Corpo inválido.'); }

  try {
    switch (corpo.acao) {
      // lista os condomínios da carteira no Superlógica (só Super Master)
      case 'condominios':
      case 'importar_condominios': {
        const { data: ehSuper } = await usuario.rpc('e_super');
        if (!ehSuper) return erro('Apenas Super Master.', 403);
        const lista = (await slPaginado('condominios/get', { id: -1 }))
          .filter(c => !EXCLUIR.has(Number(c.id_condominio_cond)))
          .map(c => ({ id_superlogica: Number(c.id_condominio_cond), nome: nomeCondominio(c) }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        if (corpo.acao === 'condominios') return resposta({ condominios: lista });

        // importa: liga pelo id do Superlógica; se já existe um condomínio com o mesmo nome, só faz a ligação
        const { data: atuais } = await admin.from('condominios').select('id, nome, id_superlogica');
        const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        let criados = 0, ligados = 0;
        for (const c of lista) {
          if ((atuais || []).some(a => a.id_superlogica === c.id_superlogica)) continue;
          const mesmoNome = (atuais || []).find(a => !a.id_superlogica && normal(a.nome) === normal(c.nome));
          if (mesmoNome) { await admin.from('condominios').update({ id_superlogica: c.id_superlogica }).eq('id', mesmoNome.id); ligados++; }
          else { const { error } = await admin.from('condominios').insert({ nome: c.nome, id_superlogica: c.id_superlogica }); if (!error) criados++; }
        }
        return resposta({ ok: true, total: lista.length, criados, ligados });
      }

      // despesas do mês de um condomínio: pagas no mês + pendentes que vencem no mês
      case 'despesas': {
        const { condominio_id, competencia } = corpo;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || '')) return erro('Mês inválido.');
        // as regras do banco garantem que a pessoa só enxerga os condomínios dela
        const { data: condo } = await usuario.from('condominios').select('id, id_superlogica').eq('id', condominio_id).maybeSingle();
        if (!condo) return erro('Condomínio não encontrado.', 404);
        if (!condo.id_superlogica) return resposta({ despesas: [], sem_ligacao: true });
        const [a, m] = competencia.split('-').map(Number);
        const inicio = new Date(Date.UTC(a, m - 1, 1)), fim = new Date(Date.UTC(a, m, 0));
        const base = { idCondominio: condo.id_superlogica, dtInicio: dataSL(inicio), dtFim: dataSL(fim) };
        const [pagas, pendentes] = await Promise.all([
          slPaginado('despesas/index', { ...base, comStatus: 'liquidadas', filtrarpor: 'liquidacao' }),
          slPaginado('despesas/index', { ...base, comStatus: 'pendentes' })
        ]);
        const vistas = new Set<string>();
        const despesas = [...pagas.map(r => ({ ...despesa(r), situacao: 'paga' })), ...pendentes.map(r => ({ ...despesa(r), situacao: 'a_pagar' }))]
          .filter(d => d.id_parcela && !vistas.has(d.id_parcela) && vistas.add(d.id_parcela))
          .sort((x, y) => (x.liquidacao || x.vencimento || '').localeCompare(y.liquidacao || y.vencimento || ''));
        return resposta({ despesas });
      }

      // para a conciliação bancária (só devs): despesas pagas no período do extrato (com folga de 5 dias)
      // e as que ainda estão em aberto, para mostrar o que cada saída do extrato é no Superlógica
      case 'conciliacao': {
        const { data: ehSuper } = await usuario.rpc('e_super');
        if (!ehSuper) return erro('Apenas os devs.', 403);
        const { condominio_id, inicio, fim } = corpo;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(fim || '')) return erro('Período inválido.');
        const { data: condo } = await usuario.from('condominios').select('id_superlogica').eq('id', condominio_id).maybeSingle();
        if (!condo) return erro('Condomínio não encontrado.', 404);
        if (!condo.id_superlogica) return resposta({ pagas: [], em_aberto: [], sem_ligacao: true });
        const dia = 86400000, d0 = new Date(inicio + 'T00:00:00Z'), d1 = new Date(fim + 'T00:00:00Z');
        const [pagas, emAberto] = await Promise.all([
          slPaginado('despesas/index', { idCondominio: condo.id_superlogica, comStatus: 'liquidadas', filtrarpor: 'liquidacao',
            dtInicio: dataSL(new Date(d0.getTime() - 5 * dia)), dtFim: dataSL(new Date(d1.getTime() + 5 * dia)) }),
          slPaginado('despesas/index', { idCondominio: condo.id_superlogica, comStatus: 'pendentes',
            dtInicio: dataSL(new Date(d0.getTime() - 60 * dia)), dtFim: dataSL(new Date(d1.getTime() + 5 * dia)) })
        ]);
        return resposta({ pagas: pagas.map(despesa), em_aberto: emAberto.map(despesa) });
      }

      default:
        return erro('Ação desconhecida.');
    }
  } catch (e) {
    return erro('Não foi possível consultar o Superlógica: ' + String(e instanceof Error ? e.message : e), 502);
  }
});
