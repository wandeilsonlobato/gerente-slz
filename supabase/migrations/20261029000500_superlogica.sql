-- Portal SLZ — ligação com o Superlógica (somente leitura).
-- Cada condomínio do Portal aponta para o condomínio do Superlógica,
-- e cada documento enviado pode apontar para a parcela de despesa do Superlógica que ele comprova.

alter table public.condominios add column id_superlogica int unique;

alter table public.documentos add column sl_id_despesa text;
alter table public.documentos add column sl_id_parcela text;
create index documentos_sl_parcela on public.documentos (condominio_id, sl_id_parcela);
