-- O gatilho envia um segredo guardado no Supabase Vault; a função Edge valida o mesmo segredo.
-- Cadastre no Vault um segredo chamado portal_slz_avisos_webhook e configure
-- AVISOS_WEBHOOK_SECRET com o mesmo valor nos secrets das Edge Functions.
create extension if not exists supabase_vault with schema vault;

create or replace function public.avisar_documento() returns trigger
language plpgsql security definer set search_path = public, vault as $$
declare segredo text;
begin
  if new.confirmado and not coalesce(old.confirmado, false)
     and not exists (select 1 from avisos_enviados where documento_id = new.documento_id) then
    select decrypted_secret into segredo
      from vault.decrypted_secrets
     where name = 'portal_slz_avisos_webhook';

    -- Sem configuração, deixa o documento confirmar sem chamar um endpoint desprotegido.
    if segredo is not null and length(segredo) >= 32 then
      perform net.http_post(
        url := 'https://crnrsqkiwbqihmnufotk.supabase.co/functions/v1/avisos',
        body := jsonb_build_object('documento_id', new.documento_id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-portal-secret', segredo)
      );
    end if;
  end if;
  return new;
end $$;
