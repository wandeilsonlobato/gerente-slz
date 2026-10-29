-- Avisos no celular (Web Push) para os devs quando uma síndica envia documento.

-- Aparelhos que ativaram os avisos (um por navegador/celular).
create table public.push_inscricoes (
  endpoint text primary key,
  perfil_id uuid not null references public.perfis (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  aparelho text,
  criado_em timestamptz not null default now()
);
alter table public.push_inscricoes enable row level security;
create policy "ver os próprios aparelhos" on public.push_inscricoes for select using (perfil_id = auth.uid());

-- Só devs ativam, por enquanto. Se o aparelho já era de outra pessoa (celular emprestado), passa a ser de quem ativou.
create function public.registrar_push(p_endpoint text, p_p256dh text, p_auth text, p_aparelho text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not e_super() then raise exception 'Só os devs recebem avisos.' using errcode = 'PT403'; end if;
  insert into push_inscricoes (endpoint, perfil_id, p256dh, auth, aparelho)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_aparelho, 120))
  on conflict (endpoint) do update set perfil_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
    aparelho = excluded.aparelho, criado_em = now();
end $$;

create function public.remover_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_inscricoes where endpoint = p_endpoint and perfil_id = auth.uid();
$$;

revoke all on function public.registrar_push(text, text, text, text) from public, anon;
revoke all on function public.remover_push(text) from public, anon;
grant execute on function public.registrar_push(text, text, text, text) to authenticated;
grant execute on function public.remover_push(text) to authenticated;

-- Documentos que já geraram aviso (para nunca avisar duas vezes o mesmo).
create table public.avisos_enviados (
  documento_id uuid primary key references public.documentos (id) on delete cascade,
  em timestamptz not null default now()
);
alter table public.avisos_enviados enable row level security;   -- sem políticas: só o servidor mexe

-- Quando o primeiro arquivo de um documento termina de chegar no R2, chama a função "avisos".
create extension if not exists pg_net;

create function public.avisar_documento() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.confirmado and not coalesce(old.confirmado, false)
     and not exists (select 1 from avisos_enviados where documento_id = new.documento_id) then
    perform net.http_post(
      url := 'https://crnrsqkiwbqihmnufotk.supabase.co/functions/v1/avisos',
      body := jsonb_build_object('documento_id', new.documento_id),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;
  return new;
end $$;

create trigger documento_arquivo_confirmado
  after update of confirmado on public.documento_arquivos
  for each row execute function public.avisar_documento();
