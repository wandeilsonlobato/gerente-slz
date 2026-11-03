-- Trilhas de auditoria e pontos de recuperação para o estado financeiro do escritório.
create table public.auditoria (
  id bigint generated always as identity primary key,
  ocorrido_em timestamptz not null default now(),
  ator uuid references public.perfis (id) on delete set null,
  tabela text not null,
  acao text not null,
  entidade_id text,
  antes jsonb,
  depois jsonb
);
create index auditoria_ocorrido_em on public.auditoria (ocorrido_em desc);
create index auditoria_entidade on public.auditoria (tabela, entidade_id, ocorrido_em desc);
alter table public.auditoria enable row level security;
revoke all on public.auditoria from anon;
create policy "super master consulta auditoria" on public.auditoria
  for select to authenticated using (public.e_super());

create table public.escritorio_backups (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  versao int not null,
  criado_por uuid references public.perfis (id) on delete set null,
  dados jsonb not null
);
create index escritorio_backups_criado_em on public.escritorio_backups (criado_em desc);
alter table public.escritorio_backups enable row level security;
revoke all on public.escritorio_backups from anon;
create policy "super master consulta backups" on public.escritorio_backups
  for select to authenticated using (public.e_super());

create function public.registrar_auditoria() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  j_antes jsonb;
  j_depois jsonb;
  id_entidade text;
  id_auditoria bigint;
begin
  if tg_op <> 'INSERT' then j_antes := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then j_depois := to_jsonb(new); end if;
  -- O JSON financeiro inteiro fica só no snapshot com retenção limitada, não duplicado na auditoria.
  if tg_table_name = 'escritorio_estado' then
    j_antes := j_antes - 'dados';
    j_depois := j_depois - 'dados';
  end if;
  id_entidade := coalesce(j_depois->>'id', j_depois->>'documento_id', j_depois->>'extrato_id',
                          j_depois->>'perfil_id', j_depois->>'condominio_id', j_antes->>'id',
                          j_antes->>'documento_id', j_antes->>'extrato_id', j_antes->>'perfil_id',
                          j_antes->>'condominio_id');
  insert into public.auditoria (ator, tabela, acao, entidade_id, antes, depois)
  values (auth.uid(), tg_table_name, tg_op, id_entidade, j_antes, j_depois)
  returning id into id_auditoria;
  if id_auditoria % 100 = 0 then
    delete from public.auditoria where ocorrido_em < now() - interval '1 year';
    delete from public.auditoria where id in (select id from public.auditoria order by id desc offset 50000);
  end if;

  if tg_table_name = 'escritorio_estado' and tg_op in ('UPDATE', 'DELETE') then
    insert into public.escritorio_backups (versao, criado_por, dados)
    values (old.versao, old.atualizado_por, old.dados);
    delete from public.escritorio_backups
     where id in (select id from public.escritorio_backups order by id desc offset 200);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger auditoria_documentos after insert or update or delete on public.documentos
  for each row execute function public.registrar_auditoria();
create trigger auditoria_arquivos after insert or update or delete on public.documento_arquivos
  for each row execute function public.registrar_auditoria();
create trigger auditoria_escritorio after insert or update or delete on public.escritorio_estado
  for each row execute function public.registrar_auditoria();
create trigger auditoria_perfis after insert or update or delete on public.perfis
  for each row execute function public.registrar_auditoria();
create trigger auditoria_condominios after insert or update or delete on public.condominios
  for each row execute function public.registrar_auditoria();
create trigger auditoria_vinculos after insert or update or delete on public.perfil_condominios
  for each row execute function public.registrar_auditoria();
create trigger auditoria_extratos after insert or update or delete on public.extratos
  for each row execute function public.registrar_auditoria();

-- Limites atômicos por usuário para operações caras nas Edge Functions.
create table public.limites_edge (
  escopo text not null,
  ator text not null,
  inicio_janela timestamptz not null,
  tentativas int not null default 1,
  primary key (escopo, ator, inicio_janela)
);
alter table public.limites_edge enable row level security;
revoke all on public.limites_edge from anon, authenticated;

create function public.registrar_limite_edge(p_escopo text, p_ator text, p_limite int, p_janela_seg int)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  janela timestamptz;
  total int;
begin
  if p_escopo is null or length(p_escopo) > 80 or p_ator is null or length(p_ator) > 120
     or p_limite < 1 or p_janela_seg < 1 then
    raise exception 'Parâmetros inválidos.' using errcode = '22023';
  end if;
  janela := to_timestamp(floor(extract(epoch from now()) / p_janela_seg) * p_janela_seg);
  insert into public.limites_edge (escopo, ator, inicio_janela, tentativas)
  values (p_escopo, p_ator, janela, 1)
  on conflict (escopo, ator, inicio_janela)
  do update set tentativas = limites_edge.tentativas + 1
  returning tentativas into total;
  delete from public.limites_edge where inicio_janela < now() - interval '1 day';
  return total <= p_limite;
end;
$$;
revoke all on function public.registrar_limite_edge(text, text, int, int) from public, anon, authenticated;
grant execute on function public.registrar_limite_edge(text, text, int, int) to service_role;

-- Cria o extrato e todas as linhas numa transação: nenhuma importação parcial fica gravada.
create function public.criar_extrato_com_lancamentos(p_extrato jsonb, p_lancamentos jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  novo_id uuid;
begin
  if not public.e_super() then raise exception 'sem_permissao' using errcode = 'PT403'; end if;
  if jsonb_typeof(p_extrato) <> 'object' or jsonb_typeof(p_lancamentos) <> 'array'
     or jsonb_array_length(p_lancamentos) > 50000
     or coalesce(p_extrato->>'competencia', '') !~ '^\d{4}-(0[1-9]|1[0-2])$'
     or coalesce(p_extrato->>'sha256', '') !~ '^[0-9a-f]{64}$'
     or length(coalesce(p_extrato->>'nome_arquivo', '')) not between 1 and 255
     or coalesce((p_extrato->>'tamanho')::bigint, 0) not between 1 and 10485760 then
    raise exception 'Dados do extrato inválidos.' using errcode = '22023';
  end if;

  insert into public.extratos (condominio_id, competencia, nome_arquivo, sha256, tamanho,
    banco, agencia, conta, periodo_inicio, periodo_fim, enviado_por)
  values ((p_extrato->>'condominio_id')::uuid, p_extrato->>'competencia', p_extrato->>'nome_arquivo',
    p_extrato->>'sha256', (p_extrato->>'tamanho')::bigint,
    nullif(p_extrato->>'banco', ''), nullif(p_extrato->>'agencia', ''), nullif(p_extrato->>'conta', ''),
    nullif(p_extrato->>'periodo_inicio', '')::date, nullif(p_extrato->>'periodo_fim', '')::date, auth.uid())
  returning id into novo_id;

  insert into public.extrato_lancamentos (extrato_id, data, valor, descricao, tipo, id_banco)
  select novo_id, x.data, x.valor, x.descricao, x.tipo, nullif(x.id_banco, '')
  from jsonb_to_recordset(p_lancamentos) as x(data date, valor numeric, descricao text, tipo text, id_banco text);
  return novo_id;
end;
$$;
revoke all on function public.criar_extrato_com_lancamentos(jsonb, jsonb) from public, anon;
grant execute on function public.criar_extrato_com_lancamentos(jsonb, jsonb) to authenticated;
