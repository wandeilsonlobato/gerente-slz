// Portal SLZ — gestão de usuários (só Super Master).
// Roda no servidor do Supabase com a chave de serviço; a página nunca vê essa chave.
// Login é por usuário + senha: por trás, cada usuário vira um e-mail interno que ninguém usa.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const DOMINIO = 'usuarios.portal-slz.invalid';
const USUARIO_OK = /^[a-z0-9._-]{3,40}$/;
const PAPEIS = ['super_master', 'master', 'padrao'];
const BLOQUEIO = '876000h'; // ~100 anos

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const erro = (msg: string, status = 400) => resposta({ erro: msg }, status);
const emailDe = (usuario: string) => `${usuario}@${DOMINIO}`;
const senhaOk = (s: unknown) => typeof s === 'string' && s.length >= 8 && /[a-zA-Z]/.test(s) && /\d/.test(s);

type Dados = {
  id?: string; usuario?: string; nome?: string; senha?: string; papel?: string;
  equipe_slz?: boolean; ativo?: boolean; condominios?: string[];
};

async function gravarVinculos(id: string, condominios: string[] = []) {
  await admin.from('perfil_condominios').delete().eq('perfil_id', id);
  if (condominios.length) {
    const { error } = await admin.from('perfil_condominios')
      .insert(condominios.map(c => ({ perfil_id: id, condominio_id: c })));
    if (error) throw error;
  }
}

async function criar(d: Dados) {
  const usuario = String(d.usuario || '').trim().toLowerCase();
  const nome = String(d.nome || '').trim();
  if (!USUARIO_OK.test(usuario)) return erro('Usuário deve ter 3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
  if (!nome) return erro('Informe o nome.');
  if (!senhaOk(d.senha)) return erro('A senha precisa de pelo menos 8 caracteres, com letras e números.');
  if (!PAPEIS.includes(d.papel || '')) return erro('Nível de acesso inválido.');

  const { data, error } = await admin.auth.admin.createUser({
    email: emailDe(usuario), password: d.senha, email_confirm: true, user_metadata: { usuario, nome }
  });
  if (error) return erro(error.message.includes('already') ? 'Esse usuário já existe.' : error.message);
  const id = data.user.id;
  const { error: e2 } = await admin.from('perfis').insert({
    id, usuario, nome, papel: d.papel, equipe_slz: d.papel === 'super_master' || !!d.equipe_slz, trocar_senha: true
  });
  if (e2) { await admin.auth.admin.deleteUser(id); return erro(e2.message); }
  try { await gravarVinculos(id, d.condominios); }
  catch (e) { await admin.auth.admin.deleteUser(id); return erro(String(e)); }
  return resposta({ ok: true, id });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return erro('Use POST.', 405);
  let corpo: Dados & { acao?: string; codigo?: string };
  try { corpo = await req.json(); } catch { return erro('Corpo inválido.'); }

  // Primeiro acesso do sistema: cria o primeiro Super Master, só enquanto não existir nenhum.
  if (corpo.acao === 'bootstrap') {
    const codigo = Deno.env.get('BOOTSTRAP_CODIGO');
    if (!codigo || corpo.codigo !== codigo) return erro('Não autorizado.', 403);
    const { count } = await admin.from('perfis').select('id', { count: 'exact', head: true }).eq('papel', 'super_master');
    if (count) return erro('Já existe um Super Master.', 409);
    return criar({ ...corpo, papel: 'super_master', equipe_slz: true });
  }

  // Todas as outras ações: só um Super Master logado e ativo.
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: sessao } = await admin.auth.getUser(token);
  const eu = sessao?.user;
  if (!eu) return erro('Faça login novamente.', 401);
  const { data: meuPerfil } = await admin.from('perfis').select('papel, ativo').eq('id', eu.id).single();
  if (!meuPerfil || !meuPerfil.ativo || meuPerfil.papel !== 'super_master') return erro('Apenas Super Master pode gerenciar usuários.', 403);

  try {
    switch (corpo.acao) {
      case 'listar': {
        const [perfis, vinculos, condominios] = await Promise.all([
          admin.from('perfis').select('id, usuario, nome, papel, equipe_slz, ativo, trocar_senha, criado_em').order('nome'),
          admin.from('perfil_condominios').select('perfil_id, condominio_id'),
          admin.from('condominios').select('id, nome, ativo, id_superlogica').order('nome')
        ]);
        const porPerfil: Record<string, string[]> = {};
        (vinculos.data || []).forEach(v => (porPerfil[v.perfil_id] ||= []).push(v.condominio_id));
        return resposta({
          usuarios: (perfis.data || []).map(p => ({ ...p, condominios: porPerfil[p.id] || [] })),
          condominios: condominios.data || []
        });
      }
      case 'criar':
        return await criar(corpo);
      case 'atualizar': {
        const id = corpo.id!;
        if (!id) return erro('Informe o usuário.');
        if (corpo.papel && !PAPEIS.includes(corpo.papel)) return erro('Nível de acesso inválido.');
        if (id === eu.id && ((corpo.papel && corpo.papel !== 'super_master') || corpo.ativo === false))
          return erro('Você não pode tirar o seu próprio acesso de Super Master.');
        const mudancas: Record<string, unknown> = {};
        if (corpo.nome !== undefined) {
          if (!String(corpo.nome).trim()) return erro('Informe o nome.');
          mudancas.nome = String(corpo.nome).trim();
        }
        if (corpo.papel !== undefined) mudancas.papel = corpo.papel;
        if (corpo.equipe_slz !== undefined || corpo.papel === 'super_master')
          mudancas.equipe_slz = corpo.papel === 'super_master' || !!corpo.equipe_slz;
        if (corpo.ativo !== undefined) mudancas.ativo = corpo.ativo;
        if (Object.keys(mudancas).length) {
          const { error } = await admin.from('perfis').update(mudancas).eq('id', id);
          if (error) return erro(error.message);
        }
        // bloqueado não consegue mais fazer login
        if (corpo.ativo !== undefined)
          await admin.auth.admin.updateUserById(id, { ban_duration: corpo.ativo ? 'none' : BLOQUEIO });
        if (corpo.condominios) await gravarVinculos(id, corpo.condominios);
        return resposta({ ok: true });
      }
      case 'redefinir_senha': {
        if (!corpo.id) return erro('Informe o usuário.');
        if (!senhaOk(corpo.senha)) return erro('A senha precisa de pelo menos 8 caracteres, com letras e números.');
        const { error } = await admin.auth.admin.updateUserById(corpo.id, { password: corpo.senha });
        if (error) return erro(error.message);
        // obriga a pessoa a trocar a senha no próximo acesso
        await admin.from('perfis').update({ trocar_senha: true }).eq('id', corpo.id);
        return resposta({ ok: true });
      }
      case 'excluir': {
        if (!corpo.id) return erro('Informe o usuário.');
        if (corpo.id === eu.id) return erro('Você não pode excluir o seu próprio usuário.');
        const { error } = await admin.auth.admin.deleteUser(corpo.id);
        if (error) return erro(error.message);
        return resposta({ ok: true });
      }
      default:
        return erro('Ação desconhecida.');
    }
  } catch (e) {
    return erro(String(e instanceof Error ? e.message : e), 500);
  }
});
