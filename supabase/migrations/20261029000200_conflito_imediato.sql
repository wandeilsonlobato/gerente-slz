-- O código 40001 faz o servidor da API repetir a chamada sem parar (dava tempo esgotado).
-- Os códigos PTxxx viram direto a resposta HTTP xxx: 409 = conflito, 403 = sem permissão.
create or replace function public.salvar_escritorio(novos_dados jsonb, versao_esperada int)
returns int language plpgsql security definer set search_path = public as $$
declare nova int;
begin
  if not public.pode_editar_escritorio() then
    raise exception 'sem_permissao' using errcode = 'PT403';
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
    raise exception 'conflito' using errcode = 'PT409';
  end if;
  return nova;
end;
$$;

-- remove o registro deixado pelos testes de segurança (ainda não há dados reais)
delete from public.escritorio_estado;
