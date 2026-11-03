# Portal SLZ

Aplicação web da SLZ Administradora de Condomínios para controle de gastos do escritório e prestação de contas dos condomínios.

## Recursos

- Controle mensal de contas fixas e despesas, balancete, impressão e exportação CSV.
- Envio e conferência de notas fiscais e comprovantes, com arquivos guardados no Cloudflare R2.
- Consulta de despesas do Superlógica e conciliação de extratos OFX.
- Gestão de usuários e permissões por perfil e condomínio.
- Backup e restauração dos dados do escritório em JSON.
- Snapshots automáticos e trilha de auditoria para alterações financeiras e administrativas.
- Interface instalável como PWA; alguns recursos dependem de conexão com a internet.

## Uso

O portal deve ser publicado em um servidor web com HTTPS e configurado com o projeto Supabase correspondente. Não basta abrir `index.html` diretamente: login, dados compartilhados, documentos e permissões dependem do Supabase e das funções de servidor. O navegador mantém a sessão e preferências locais; os dados compartilhados ficam no Supabase. O backup JSON é uma cópia manual dos dados do escritório.

## Implantação

1. Configure o projeto Supabase e aplique as migrações em `supabase/migrations`.
2. Configure os secrets exigidos pelas funções em `supabase/functions` (Supabase, R2 e, se usados, Superlógica e Web Push).
3. Publique as funções Supabase e os arquivos da raiz em um host HTTPS.
4. Para avisos Web Push, crie no Supabase Vault um segredo chamado `portal_slz_avisos_webhook` com pelo menos 32 caracteres e configure o secret da Edge Function `AVISOS_WEBHOOK_SECRET` com o mesmo valor. Sem esse segredo, os documentos continuam sendo confirmados, mas o gatilho não envia avisos.
5. Crie o primeiro usuário Super Master pela ação de bootstrap da função `admin-usuarios`, usando o `BOOTSTRAP_CODIGO` configurado no servidor.

## Alterações e publicação

`index.html` contém a estrutura da página; `styles.css` contém a apresentação e `app.js` contém os fluxos da aplicação. Para mudanças no banco, adicione uma migração numerada nova em vez de alterar uma migração já aplicada. Aplique e revise primeiro em um projeto Supabase local/de desenvolvimento; faça uma cópia externa dos dados antes de aplicar em produção; depois publique as migrações e as Edge Functions afetadas e confira login, sincronização, envio de comprovante e conciliação.

## Recuperação e manutenção

O Portal guarda automaticamente as 200 versões anteriores dos dados do escritório no próprio Supabase. Um Super Master pode restaurar uma versão em **Ajustes → Recuperação e auditoria**; a versão atual é preservada antes da restauração. A mesma área mostra eventos recentes de documentos, usuários, condomínios e extratos. Esses snapshots ficam no mesmo banco e não substituem backups externos: exporte periodicamente o JSON e mantenha uma cópia fora do Supabase.

Importações de extrato criam o cabeçalho e os lançamentos numa única transação. O envio de comprovantes tem limite por usuário e valida no servidor os bytes, o tamanho e o SHA-256 do arquivo.

Os testes de assinatura de arquivos usam o runner padrão do Deno:

```sh
deno test supabase/functions/documentos-arquivos/validation_test.ts
```

Não coloque chaves de serviço, credenciais do R2, tokens do Superlógica, chaves VAPID ou o segredo do webhook no frontend ou no repositório.
