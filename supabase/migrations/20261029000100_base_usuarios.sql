-- Portal SLZ — base: usuários, níveis de acesso, condomínios e controle de gastos do escritório.
--
-- Níveis:
--   super_master  devs; fazem tudo e são os únicos que cadastram usuários
--   master        altera e adiciona dados (equipe SLZ: escritório + todos os condomínios; síndica: só o condomínio dela)
--   padrao        só visualiza e baixa
-- "equipe_slz" diz se a pessoa é da equipe do escritório (vê o controle de gastos e todos os condomínios).
-- As regras ficam no banco (RLS): mesmo mexendo na página, ninguém passa do próprio nível.

create type public.papel as enum ('super_master', 'master', 'padrao');

create table public.condominios (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique check (length(trim(nome)) > 0),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table public.perfis (
  id uuid primary key references auth.users (id) on delete cascade,
  usuario text not null unique check (usuario ~ '^[a-z0-9._-]{3,40}$'),
  nome text not null check (length(trim(nome)) > 0),
  papel public.papel not null default 'padrao',
  equipe_slz boolean not null default false,
  ativo boolean not null default true,
  trocar_senha boolean not null default true,
  criado_em timestamptz not null default now()
);

create table public.perfil_condominios (
  perfil_id uuid not null references public.perfis (id) on delete cascade,
  condominio_id uuid not null references public.condominios (id) on delete cascade,
  primary key (perfil_id, condominio_id)
);

-- Controle de gastos do escritório: um documento único com versão,
-- para que uma pessoa não sobrescreva sem querer o que outra acabou de salvar.
create table public.escritorio_estado (
  id int primary key default 1 check (id = 1),
  dados jsonb not null,
  versao int not null default 1,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.perfis (id) on delete set null
);

-- ---------- funções de permissão (security definer evita recursão nas políticas) ----------
create function public.e_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo and papel = 'super_master');
$$;

create function public.e_equipe() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo and (papel = 'super_master' or equipe_slz));
$$;

create function public.pode_editar_escritorio() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo
                 and (papel = 'super_master' or (papel = 'master' and equipe_slz)));
$$;

create function public.acessa_condominio(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.e_equipe() or exists (
    select 1 from perfil_condominios pc join perfis p on p.id = pc.perfil_id
    where pc.perfil_id = auth.uid() and pc.condominio_id = cid and p.ativo);
$$;

-- ---------- RLS ----------
alter table public.condominios enable row level security;
alter table public.perfis enable row level security;
alter table public.perfil_condominios enable row level security;
alter table public.escritorio_estado enable row level security;

-- quem não fez login não enxerga nada
revoke all on public.condominios, public.perfis, public.perfil_condominios, public.escritorio_estado from anon;

create policy "ver condomínios permitidos" on public.condominios
  for select to authenticated using (public.acessa_condominio(id));
create policy "super master gerencia condomínios" on public.condominios
  for all to authenticated using (public.e_super()) with check (public.e_super());

-- cada um vê o próprio perfil; a equipe vê todos (para saber quem lançou o quê)
create policy "ver perfis" on public.perfis
  for select to authenticated using (id = auth.uid() or public.e_equipe());
-- criar/alterar/excluir usuários só pela função admin-usuarios (chave de serviço), nunca pela página

create policy "ver vínculos" on public.perfil_condominios
  for select to authenticated using (perfil_id = auth.uid() or public.e_super());

create policy "equipe vê gastos do escritório" on public.escritorio_estado
  for select to authenticated using (public.e_equipe());
-- gravação só pela função salvar_escritorio (controle de versão)

-- ---------- funções chamadas pela página ----------
-- grava o controle de gastos; falha com "conflito" se outra pessoa salvou antes
create function public.salvar_escritorio(novos_dados jsonb, versao_esperada int)
returns int language plpgsql security definer set search_path = public as $$
declare nova int;
begin
  if not public.pode_editar_escritorio() then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if versao_esperada = 0 then
    insert into escritorio_estado (id, dados, versao, atualizado_por)
    values (1, novos_dados, 1, auth.uid())
    on conflict (id) do nothing
    returning versao into nova;
  else
    update escritorio_estado
       set dados = novos_dados, versao = versao + 1, atualizado_em = now(), atualizado_por = auth.uid()
     where id = 1 and versao = versao_esperada
    returning versao into nova;
  end if;
  if nova is null then
    raise exception 'conflito' using errcode = '40001';
  end if;
  return nova;
end;
$$;

-- depois que a pessoa troca a senha temporária
create function public.senha_trocada() returns void
language sql security definer set search_path = public as $$
  update perfis set trocar_senha = false where id = auth.uid();
$$;

revoke execute on function public.salvar_escritorio(jsonb, int) from public, anon;
revoke execute on function public.senha_trocada() from public, anon;
grant execute on function public.salvar_escritorio(jsonb, int) to authenticated;
grant execute on function public.senha_trocada() to authenticated;
