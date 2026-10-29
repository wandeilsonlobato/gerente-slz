-- Portal SLZ — extratos bancários (OFX) para a conciliação com as notas enviadas pelas síndicas.
-- Só os devs (Super Master) enviam e veem extratos e o resultado da conciliação.
-- Tudo fica guardado de forma organizada para a futura IA analisar (arquivo original no R2 + lançamentos aqui).

create table public.extratos (
  id uuid primary key default gen_random_uuid(),
  condominio_id uuid not null references public.condominios (id) on delete restrict,
  competencia text not null check (competencia ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  nome_arquivo text not null,
  chave text unique,                 -- caminho do arquivo OFX original no R2
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  tamanho bigint,
  arquivo_confirmado boolean not null default false,
  banco text, agencia text, conta text,
  periodo_inicio date, periodo_fim date,
  enviado_por uuid references public.perfis (id) on delete set null,
  enviado_em timestamptz not null default now(),
  unique (condominio_id, sha256)     -- o mesmo arquivo não entra duas vezes
);
create index extratos_condominio_competencia on public.extratos (condominio_id, competencia);

create table public.extrato_lancamentos (
  id uuid primary key default gen_random_uuid(),
  extrato_id uuid not null references public.extratos (id) on delete cascade,
  data date not null,
  valor numeric(14, 2) not null,      -- negativo = saída (pagamento); positivo = entrada
  descricao text,
  tipo text,                          -- TRNTYPE do OFX (DEBIT, CREDIT, PAYMENT...)
  id_banco text,                      -- FITID: identificador do lançamento no banco
  unique (extrato_id, id_banco)
);
create index extrato_lancamentos_extrato on public.extrato_lancamentos (extrato_id);

alter table public.extratos enable row level security;
alter table public.extrato_lancamentos enable row level security;
revoke all on public.extratos, public.extrato_lancamentos from anon;

create policy "só devs: extratos" on public.extratos
  for all to authenticated using (public.e_super()) with check (public.e_super());
create policy "só devs: lançamentos do extrato" on public.extrato_lancamentos
  for all to authenticated using (public.e_super()) with check (public.e_super());
