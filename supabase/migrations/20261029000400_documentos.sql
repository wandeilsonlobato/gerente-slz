-- Portal SLZ — notas fiscais e comprovantes enviados pelas síndicas.
-- Os arquivos ficam no Cloudflare R2; aqui ficam os dados de cada documento e a lista de arquivos.
-- Fluxo: síndica envia (enviado) → escritório confere (conferido) ou pede correção (pendencia) → síndica corrige (volta a enviado).

create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  condominio_id uuid not null references public.condominios (id) on delete restrict,
  competencia text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- mês de referência, ex.: 2026-11
  tipo text not null check (tipo in ('nota_fiscal', 'recibo', 'comprovante', 'boleto', 'outro')),
  conta text,                                     -- conta do plano de contas do condomínio
  fornecedor text not null check (length(trim(fornecedor)) > 0),
  descricao text,
  valor numeric(12, 2) check (valor is null or valor >= 0),
  data_pagamento date,
  status text not null default 'enviado' check (status in ('enviado', 'pendencia', 'conferido')),
  comentario text,                                -- recado do escritório (ex.: "nota ilegível, reenviar")
  enviado_por uuid references public.perfis (id) on delete set null,
  enviado_em timestamptz not null default now(),
  conferido_por uuid references public.perfis (id) on delete set null,
  conferido_em timestamptz,
  atualizado_em timestamptz not null default now()
);
create index documentos_condominio_competencia on public.documentos (condominio_id, competencia);
create index documentos_status on public.documentos (status);

create table public.documento_arquivos (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null references public.documentos (id) on delete cascade,
  chave text not null unique,                     -- caminho do arquivo no R2
  nome_original text not null,
  tipo_mime text not null,
  tamanho bigint not null check (tamanho > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),  -- "impressão digital" para provar que o arquivo não mudou
  confirmado boolean not null default false,      -- vira true quando o upload chegou inteiro no R2
  criado_por uuid references public.perfis (id) on delete set null,
  criado_em timestamptz not null default now()
);
create index documento_arquivos_documento on public.documento_arquivos (documento_id);

-- quem pode enviar documentos para o condomínio: Super Master, ou Master com acesso a ele (equipe ou síndica)
create function public.pode_enviar(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.acessa_condominio(cid) and exists (
    select 1 from perfis where id = auth.uid() and ativo and papel in ('super_master', 'master'));
$$;

alter table public.documentos enable row level security;
alter table public.documento_arquivos enable row level security;
revoke all on public.documentos, public.documento_arquivos from anon;

create policy "ver documentos do condomínio" on public.documentos
  for select to authenticated using (public.acessa_condominio(condominio_id));
create policy "enviar documento" on public.documentos
  for insert to authenticated with check (public.pode_enviar(condominio_id) and enviado_por = auth.uid() and status = 'enviado');
create policy "alterar documento" on public.documentos
  for update to authenticated
  using (public.pode_enviar(condominio_id) and (public.pode_editar_escritorio() or status <> 'conferido'))
  with check (public.pode_enviar(condominio_id));
create policy "excluir documento" on public.documentos
  for delete to authenticated
  using (public.pode_editar_escritorio() or (public.pode_enviar(condominio_id) and status <> 'conferido'));

-- arquivos: a página só lê; quem grava é a função documentos-arquivos (que fala com o R2)
create policy "ver arquivos de documentos visíveis" on public.documento_arquivos
  for select to authenticated using (exists (select 1 from documentos d where d.id = documento_id));

-- quem não é da equipe (síndica) não confere nem comenta: corrigir um documento com pendência o devolve para "enviado"
create function public.documentos_regras() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.atualizado_em := now();
  if public.pode_editar_escritorio() then
    if new.status = 'conferido' and old.status is distinct from 'conferido' then
      new.conferido_por := auth.uid(); new.conferido_em := now();
    elsif new.status <> 'conferido' then
      new.conferido_por := null; new.conferido_em := null;
    end if;
  else
    new.status := case when old.status = 'pendencia' then 'enviado' else old.status end;
    new.comentario := old.comentario;
    new.conferido_por := old.conferido_por;
    new.conferido_em := old.conferido_em;
  end if;
  new.condominio_id := old.condominio_id;
  new.enviado_por := old.enviado_por;
  new.enviado_em := old.enviado_em;
  return new;
end;
$$;
create trigger documentos_regras before update on public.documentos
  for each row execute function public.documentos_regras();
