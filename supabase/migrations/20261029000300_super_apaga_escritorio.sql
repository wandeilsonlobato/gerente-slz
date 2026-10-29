-- Super Master pode zerar o controle de gastos do escritório (ex.: limpar dados de teste).
create policy "super master apaga gastos do escritório" on public.escritorio_estado
  for delete to authenticated using (public.e_super());

delete from public.escritorio_estado;
