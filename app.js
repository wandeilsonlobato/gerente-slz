
(function () {
  // servidor do Portal SLZ (a chave pública pode ficar na página; quem protege os dados são as regras do banco)
  const SUPABASE_URL = 'https://crnrsqkiwbqihmnufotk.supabase.co';
  const SUPABASE_CHAVE = 'sb_publishable_XI9hpt1NxnumeKqggpGFjA_BNAHm_Tu';
  const DOMINIO_LOGIN = 'usuarios.portal-slz.invalid';
  const NOMES_PAPEL = { super_master: 'Super Master', master: 'Master', padrao: 'Padrão' };
  // ícone desenhado (SVG) — o Portal não usa emojis
  const ic = (nome, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${nome}"/></svg>`;
  const TITULOS = { geral: 'Visão geral', painel: 'Painel', contas: 'Contas fixas', despesas: 'Despesas', balancete: 'Balancete', config: 'Ajustes', documentos: 'Documentos', usuarios: 'Usuários' };
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_CHAVE, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'portal-slz-sessao' }
  });

  const CHAVE = 'slz-controle-gastos-v1';
  const CHAVE_FILTRO = 'slz-filtro-balancete-v2';
  const MES_INICIAL = '2026-11';
  const NOMES_MES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const SEQ_AVULSO = 99; // "Outro item" fica sempre no fim: 4.02.99

  const FIXAS_PADRAO = [
    { id: 'energia', nome: 'Energia', dia: 25, valor: 0 },
    { id: 'internet', nome: 'Internet', dia: 5, valor: 0 },
    { id: 'superlogica', nome: 'Sistema Superlógica', dia: 10, valor: 0 }
  ];
  const CATEGORIAS_PADRAO = [
    { id: 'almoco', nome: 'Almoço' },
    { id: 'papel', nome: 'Papel' },
    { id: 'toner', nome: 'Toner' },
    { id: 'tinta', nome: 'Tinta' },
    { id: 'uber', nome: 'Uber' },
    { id: 'outros', nome: 'Copa' }
  ];
  // itens da copa (conta "outros"), com quantidade comprada
  const ITENS_PADRAO = [
    { id: 'cafe', nome: 'Café' },
    { id: 'acucar', nome: 'Açúcar' },
    { id: 'leite', nome: 'Leite' },
    { id: 'biscoito', nome: 'Biscoito' },
    { id: 'bolo', nome: 'Bolo' },
    { id: 'outro', nome: 'Outro item' }
  ];
  // plano de contas aprovado para o escritório
  const GRUPOS_PADRAO = [
    { id: 'g-fixas', num: 1, nome: 'Despesas fixas', tipo: 'fixas' },
    { id: 'g-adm', num: 2, nome: 'Despesas administrativas' },
    { id: 'g-transp', num: 3, nome: 'Transporte' },
    { id: 'g-alim', num: 4, nome: 'Alimentação' }
  ];
  const GRUPO_DA_CATEGORIA = { papel: 'g-adm', toner: 'g-adm', tinta: 'g-adm', uber: 'g-transp', almoco: 'g-alim', outros: 'g-alim' };

  // ---------- dados ----------
  const proxSeq = (lista, filtro) => Math.max(0, ...lista.filter(filtro).map(x => x.seq || 0).filter(s => s < SEQ_AVULSO)) + 1;

  // completa dados antigos com o que as versões novas precisam
  function atualizarDados(d) {
    // aplica uma única vez os dias de vencimento padrão (Energia 25, Internet 5, Superlógica 10)
    if (!d.diasPadraoV2) {
      d.fixas.forEach(f => { const p = FIXAS_PADRAO.find(x => x.id === f.id); if (p) f.dia = p.dia; });
      d.diasPadraoV2 = true;
    }
    d.fixas.forEach(f => { f.desde = f.desde || MES_INICIAL; });
    if (!d.categorias) d.categorias = CATEGORIAS_PADRAO.map(c => ({ ...c, ativa: true }));
    if (!d.itensOutros) d.itensOutros = ITENS_PADRAO.map(i => ({ ...i, ativa: true }));

    // plano de contas: grupos, códigos permanentes e "Outros" passa a se chamar "Copa"
    if (!d.grupos) {
      d.grupos = GRUPOS_PADRAO.map(g => ({ ...g, ativa: true }));
      const semGrupo = d.categorias.filter(c => !GRUPO_DA_CATEGORIA[c.id]);
      if (semGrupo.length) d.grupos.push({ id: 'g-outras', num: 5, nome: 'Outras despesas', ativa: true });
      d.categorias.forEach(c => { c.grupo = GRUPO_DA_CATEGORIA[c.id] || 'g-outras'; });
      const ordem = ['almoco', 'outros'];
      d.categorias.slice().sort((a, b) => (ordem.indexOf(a.id) + 1 || 50) - (ordem.indexOf(b.id) + 1 || 50))
        .forEach(c => { c.seq = proxSeq(d.categorias, x => x.grupo === c.grupo && x.seq); });
      const copa = d.categorias.find(c => c.id === 'outros');
      if (copa && copa.nome === 'Outros') copa.nome = 'Copa';
      d.fixas.forEach(f => { f.seq = proxSeq(d.fixas, x => x.seq); });
      d.itensOutros.forEach(i => { i.seq = i.id === 'outro' ? SEQ_AVULSO : proxSeq(d.itensOutros, x => x.seq); });
    }
    return d;
  }
  const dadosNovos = () => atualizarDados({ fixas: FIXAS_PADRAO.map(f => ({ ...f })), meses: {}, ultimoBackup: null, diasPadraoV2: true });
  // cópia guardada neste aparelho (versão antiga do sistema, ou última cópia vista sem internet)
  function carregarLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(CHAVE));
      if (d && d.meses) return atualizarDados(d);
    } catch (e) {}
    return null;
  }
  let dados = dadosNovos();

  // ---------- gravação no servidor ----------
  let perfil = null;          // usuário logado
  let podeEditar = false;     // Super Master ou Master da equipe
  let ehEquipe = false;       // equipe SLZ (vê o escritório e todos os condomínios)
  let podeEnviarDocs = false; // Master e Super Master enviam notas; Padrão só vê e baixa
  let podeConferir = false;   // equipe que confere os documentos
  let condosDocs = [];        // condomínios que a pessoa enxerga
  let versaoServidor = 0;     // versão que temos; o servidor recusa gravar por cima de versão mais nova
  let ultimoEnviado = '';     // o que já está no servidor
  let enviando = false, timerEnvio = null;
  const pendente = () => podeEditar && JSON.stringify(dados) !== ultimoEnviado;

  function statusSync(estado) {
    const el = document.getElementById('statusSync');
    const txt = { salvo: 'Salvo', salvando: 'Salvando…', offline: navigator.onLine ? 'Falha ao sincronizar — tentando novamente' : 'Sem conexão — alterações serão reenviadas quando voltar', leitura: 'Só visualização' };
    el.className = estado || '';
    el.title = txt[estado] || '';
    el.innerHTML = txt[estado] ? (estado === 'leitura' ? ic('olho') : '<i class="ponto"></i>') + `<span class="txt">${txt[estado]}</span>` : '';
  }

  function salvar() {
    try { localStorage.setItem(CHAVE, JSON.stringify(dados)); } catch (e) {}
    if (!pendente()) return;
    statusSync('salvando');
    clearTimeout(timerEnvio);
    timerEnvio = setTimeout(enviar, 700);
  }

  async function enviar() {
    if (enviando) { clearTimeout(timerEnvio); timerEnvio = setTimeout(enviar, 400); return; }
    const json = JSON.stringify(dados);
    if (json === ultimoEnviado) { statusSync('salvo'); return; }
    enviando = true;
    let data, error;
    try {
      ({ data, error } = await sb.rpc('salvar_escritorio', { novos_dados: JSON.parse(json), versao_esperada: versaoServidor }));
    } catch (e) {
      enviando = false;
      statusSync('offline');
      timerEnvio = setTimeout(enviar, 8000);
      return;
    }
    enviando = false;
    if (error) {
      if (error.code === 'PT409') {
        // outra pessoa salvou antes: carrega a versão dela para não apagar o que ela fez
        await carregarDoServidor();
        render();
        alert('Outra pessoa salvou alterações no mesmo momento. Carreguei a versão mais nova — confira e, se precisar, refaça a sua última alteração.');
        return;
      }
      if (error.code === 'PT403') { podeEditar = false; aplicarPermissoes(); toast('Seu acesso é só para visualizar.'); return; }
      statusSync('offline');
      timerEnvio = setTimeout(enviar, 8000);
      return;
    }
    versaoServidor = data;
    ultimoEnviado = json;
    if (pendente()) salvar(); else statusSync('salvo');
  }

  async function carregarDoServidor() {
    const { data, error } = await sb.from('escritorio_estado').select('dados, versao, atualizado_em, perfis(nome)').maybeSingle();
    if (error) throw error;
    if (data) {
      ultimoEnviado = JSON.stringify(data.dados);
      dados = atualizarDados(data.dados);
      versaoServidor = data.versao;
      mostrarUltimaAlteracao(data);
      return true;
    }
    versaoServidor = 0;
    ultimoEnviado = '';
    return false;
  }
  function mostrarUltimaAlteracao(d) {
    const quando = new Date(d.atualizado_em);
    document.getElementById('ultimaAlteracao').textContent = 'Última alteração: ' + quando.toLocaleString('pt-BR') + (d.perfis ? ' por ' + d.perfis.nome : '');
  }

  // traz alterações feitas por outras pessoas (quando a tela volta a ficar visível e a cada 30 s)
  async function verificarAtualizacao() {
    if (!perfil || enviando || pendente() || document.visibilityState !== 'visible') return;
    const { data } = await sb.from('escritorio_estado').select('versao').maybeSingle();
    if (data && data.versao > versaoServidor) {
      await carregarDoServidor();
      render();
      toast('Dados atualizados com as alterações da equipe');
    }
  }

  // conta fixa vale do mês "desde" até antes do mês "ate" (quando removida)
  const fixaAtivaEm = (f, chave) => f.desde <= chave && (!f.ate || chave < f.ate);

  function mesDados(chave, criar) {
    if (!dados.meses[chave]) {
      if (!criar) return { contas: {}, despesas: [] };
      dados.meses[chave] = { contas: {}, despesas: [] };
    }
    const m = dados.meses[chave];
    if (criar) {
      dados.fixas.forEach(f => {
        if (fixaAtivaEm(f, chave) && !m.contas[f.id]) m.contas[f.id] = { valor: f.valor, pago: false, pagoEm: '' };
      });
    }
    return m;
  }
  const porSeq = (a, b) => a.seq - b.seq;
  const fixasDoMes = chave => { const m = dados.meses[chave]; return m ? dados.fixas.filter(f => m.contas[f.id]).sort(porSeq) : []; };
  const usadaEm = (chaves, teste) => chaves.some(k => dados.meses[k] && dados.meses[k].despesas.some(teste));
  const novoId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- utilidades ----------
  const brl = v => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const brlCurto = v => (v || 0) >= 10000
    ? (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 })
    : (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const pct = v => (v > 0 ? '+' : '') + v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const lerValor = s => {
    s = String(s).trim().replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? NaN : Math.round(n * 100) / 100;
  };
  const fmtValorInput = v => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtData = iso => iso ? iso.split('-').reverse().join('/') : '';
  const hojeISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const pad2 = n => String(n).padStart(2, '0');

  function somaMes(chave, desloc) {
    const [a, m] = chave.split('-').map(Number);
    const d = new Date(a, m - 1 + desloc, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  const nomeMes = chave => { const [a, m] = chave.split('-'); return NOMES_MES[+m - 1] + ' de ' + a; };
  const nomeMesCurto = chave => { const [a, m] = chave.split('-'); return NOMES_MES[+m - 1].slice(0, 3) + '/' + a.slice(2); };
  const diasNoMes = chave => { const [a, m] = chave.split('-').map(Number); return new Date(a, m, 0).getDate(); };

  function vencimento(chave, dia) {
    const d = Math.min(dia, diasNoMes(chave));
    return chave + '-' + String(d).padStart(2, '0');
  }
  // vencimento editado no mês tem prioridade sobre o dia padrão da configuração
  const vencConta = (chave, fixa, conta) => (conta && conta.venc) || vencimento(chave, fixa.dia);
  function situacao(chave, fixa, conta) {
    if (conta.pago) return { cls: 'paga', txt: 'Paga' };
    const venc = vencConta(chave, fixa, conta);
    const hoje = hojeISO();
    if (venc < hoje) return { cls: 'atrasada', txt: 'Atrasada' };
    const dias = Math.round((new Date(venc) - new Date(hoje)) / 86400000);
    return { cls: 'pendente', txt: dias === 0 ? 'Vence hoje' : 'Vence em ' + dias + (dias === 1 ? ' dia' : ' dias'), dias };
  }

  // ---------- plano de contas ----------
  const grupoFixas = () => dados.grupos.find(g => g.tipo === 'fixas');
  const grupoPorId = id => dados.grupos.find(g => g.id === id) || { num: 0, nome: '' };
  const gruposOrdenados = () => dados.grupos.slice().sort((a, b) => a.num - b.num);
  const codFixa = f => grupoFixas().num + '.' + pad2(f.seq);
  const codCat = c => grupoPorId(c.grupo).num + '.' + pad2(c.seq);
  const copa = () => dados.categorias.find(c => c.id === 'outros');
  const codItem = i => codCat(copa()) + '.' + pad2(i.seq);
  const catPorId = id => dados.categorias.find(c => c.id === id);
  const nomeCat = id => (catPorId(id) || { nome: id }).nome;
  const rotCat = id => { const c = catPorId(id); return c ? codCat(c) + ' ' + c.nome : id; };
  const nomeItem = id => (dados.itensOutros.find(i => i.id === id) || { nome: 'Outro item' }).nome;
  const rotItem = id => { const i = dados.itensOutros.find(x => x.id === id); return i ? codItem(i) + ' ' + i.nome : 'Outro item'; };
  const itemDe = d => d.item || 'outro';
  const qtdDe = d => d.qtd || 1;
  const fmtQtd = q => q.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' un';
  const ordemCat = (a, b) => grupoPorId(a.grupo).num - grupoPorId(b.grupo).num || a.seq - b.seq;

  // contas visíveis nos meses informados: as ativas + as removidas que tiveram lançamento
  const catsVisiveis = chaves => dados.categorias
    .filter(c => c.ativa || usadaEm(chaves, d => d.categoria === c.id)).sort(ordemCat);

  // Totais por conta: fixas pelo id da conta + despesas variáveis
  function totais(chave) {
    const m = dados.meses[chave];
    const t = {};
    dados.categorias.forEach(c => t[c.id] = 0);
    if (!m) return { porCat: t, fixas: 0, variaveis: 0, total: 0, existe: false };
    let fixas = 0, variaveis = 0;
    fixasDoMes(chave).forEach(f => { const v = m.contas[f.id].valor; t[f.id] = v; fixas += v; });
    m.despesas.forEach(d => { t[d.categoria] = (t[d.categoria] || 0) + d.valor; variaveis += d.valor; });
    return { porCat: t, fixas, variaveis, total: fixas + variaveis, existe: true };
  }
  // linhas do plano (fixas + variáveis) que aparecem ao comparar estes meses
  function todasCategorias(chaves) {
    const gF = grupoFixas();
    const fixas = dados.fixas.filter(f => chaves.some(k => dados.meses[k] && dados.meses[k].contas[f.id])).sort(porSeq);
    return [
      ...fixas.map(f => ({ id: f.id, nome: f.nome, cod: codFixa(f), grupo: gF.id, fixa: true })),
      ...catsVisiveis(chaves).map(c => ({ id: c.id, nome: c.nome, cod: codCat(c), grupo: c.grupo }))
    ];
  }

  // valor e quantidade por item da copa no mês, mais a lista de compras
  function itensMes(chave) {
    const m = dados.meses[chave];
    const porItem = {};
    dados.itensOutros.forEach(i => porItem[i.id] = { valor: 0, qtd: 0 });
    const compras = m ? m.despesas.filter(d => d.categoria === 'outros') : [];
    compras.forEach(d => { const it = porItem[itemDe(d)] || porItem.outro; it.valor += d.valor; it.qtd += qtdDe(d); });
    return { porItem, compras };
  }

  // Tendência em relação ao mês anterior: 'mais' (vermelho), 'menos' (verde), 'igual' ou 'sem' dados
  function tendencia(atual, ant, temAnt) {
    if (!temAnt) return 'sem';
    const d = atual - ant;
    return d > 0.005 ? 'mais' : d < -0.005 ? 'menos' : 'igual';
  }
  function variacaoTxt(atual, ant, temAnt) {
    const t = tendencia(atual, ant, temAnt);
    if (t === 'sem') return '<span class="neutro">Sem dados do mês anterior</span>';
    if (t === 'igual') return '<span class="neutro">Igual ao mês anterior</span>';
    const dif = atual - ant;
    const p = ant ? ' (' + pct(dif / ant * 100) + ')' : '';
    return t === 'mais' ? `<span class="mais">▲ ${brl(dif)} a mais${p}</span>` : `<span class="menos">▼ ${brl(-dif)} a menos${p}</span>`;
  }
  // pílula curta: "▲ R$ 20,00" / "▼ 12%"
  function pilula(atual, ant, temAnt, modo) {
    const t = tendencia(atual, ant, temAnt);
    if (t === 'sem') return '<span class="pill neutro">—</span>';
    if (t === 'igual') return '<span class="pill neutro">= igual</span>';
    const d = atual - ant;
    const seta = t === 'mais' ? '▲ ' : '▼ ';
    const txt = modo === 'pct' ? (ant ? pct(d / ant * 100) : 'novo') : (d > 0 ? '+' : '−') + brl(Math.abs(d));
    return `<span class="pill ${t}">${seta}${txt}</span>`;
  }

  // ---------- estado ----------
  function mesPadrao() {
    const d = new Date();
    const atual = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return atual < MES_INICIAL ? MES_INICIAL : atual;
  }
  let mesSel = mesPadrao();
  let filtro = '';

  // filtro do balancete por grupo e por conta do plano (fica salvo neste aparelho)
  const FILTRO_PADRAO = { grupos: {}, contas: {}, itens: true, compras: true, lista: false, comparar: true, resumo: true };
  let filtroBal = { ...FILTRO_PADRAO };
  try { const f = JSON.parse(localStorage.getItem(CHAVE_FILTRO)); if (f) filtroBal = { ...FILTRO_PADRAO, ...f }; } catch (e) {}
  const salvarFiltro = () => { try { localStorage.setItem(CHAVE_FILTRO, JSON.stringify(filtroBal)); } catch (e) {} };
  const marcado = (mapa, id) => mapa[id] !== false;

  // ---------- render ----------
  function rotularMes() {
    document.getElementById('mesLabel').textContent = window.innerWidth <= 760 ? nomeMesCurto(mesSel) : nomeMes(mesSel);
    document.getElementById('mesAnt').disabled = mesSel <= MES_INICIAL;
    document.querySelectorAll('.mesTxt').forEach(e => e.textContent = nomeMes(mesSel));
  }
  function render() {
    mesDados(mesSel, true);
    salvar();
    rotularMes();
    renderAlertas();
    renderPainel();
    renderContas();
    renderDespesas();
    renderBalancete();
    renderConfig();
    aplicarPermissoes();
    if (perfil && document.getElementById('aba-documentos').classList.contains('ativa')) carregarDocs();
    if (perfil && document.getElementById('aba-geral').classList.contains('ativa')) carregarGeral();
  }

  // quem só visualiza: esconde botões de edição e trava os campos (o servidor também recusa gravar)
  function aplicarPermissoes() {
    document.body.classList.toggle('so-leitura', !podeEditar);
    if (!podeEditar) {
      document.querySelectorAll('#tabContas input, #tabDespesas input, #tabDespesas select, #tabConfig input, #planoEditor input, #planoEditor select')
        .forEach(el => { el.disabled = true; });
      if (ehEquipe) statusSync('leitura');
    }
  }

  function renderAlertas() {
    // Lembretes de contas: atrasadas em qualquer mês + as que vencem nos próximos 5 dias
    const itens = [];
    Object.keys(dados.meses).sort().forEach(chave => {
      fixasDoMes(chave).forEach(f => {
        const c = dados.meses[chave].contas[f.id];
        if (c.pago) return;
        const s = situacao(chave, f, c);
        const venc = fmtData(vencConta(chave, f, c));
        if (s.cls === 'atrasada') itens.push(`<div class="alerta atrasada">${ic('alerta')}<span><strong>${esc(f.nome)}</strong> de ${nomeMes(chave)} está <strong>atrasada</strong> — venceu em ${venc} · ${brl(c.valor)}</span></div>`);
        else if (s.dias <= 5) itens.push(`<div class="alerta proxima">${ic('sino')}<span>Lembrete: <strong>${esc(f.nome)}</strong> ${s.txt.toLowerCase()} (${venc}) · ${brl(c.valor)}</span></div>`);
      });
    });
    document.getElementById('alertas').innerHTML = itens.join('');
  }

  function renderPainel() {
    const ant = somaMes(mesSel, -1);
    const tA = totais(mesSel), tP = totais(ant);
    const m = dados.meses[mesSel];
    const fixas = fixasDoMes(mesSel);
    const pendentes = fixas.filter(f => !m.contas[f.id].pago);
    const valorPend = pendentes.reduce((s, f) => s + m.contas[f.id].valor, 0);
    const kpi = (rot, a, p) => `<div class="card kpi t-${tendencia(a, p, tP.existe)}"><div class="rot">${rot}</div><div class="val">${brl(a)}</div><div class="det">${variacaoTxt(a, p, tP.existe)}</div></div>`;

    document.getElementById('kpis').innerHTML =
      kpi('Total gasto no mês', tA.total, tP.total) +
      kpi('Contas fixas', tA.fixas, tP.fixas) +
      kpi('Despesas variáveis', tA.variaveis, tP.variaveis) +
      `<div class="card kpi ${pendentes.length ? 't-alerta' : 't-ok'}"><div class="rot">Contas a pagar</div><div class="val" style="color:${pendentes.length ? 'var(--amarelo)' : 'var(--verde)'}">${pendentes.length ? brl(valorPend) : 'Tudo pago'}</div><div class="det neutro">${pendentes.length ? pendentes.length + ' de ' + fixas.length + ' pendentes' : 'Nenhuma conta pendente'}</div></div>`;

    document.getElementById('painelContas').innerHTML = fixas.length ? '<table><tbody>' + fixas.map(f => {
      const c = m.contas[f.id], s = situacao(mesSel, f, c);
      return `<tr><td><strong>${esc(f.nome)}</strong><br><span class="miudo">Vence ${fmtData(vencConta(mesSel, f, c))}</span></td><td class="num">${brl(c.valor)}</td><td class="num"><span class="tag ${s.cls}">${s.txt}</span></td></tr>`;
    }).join('') + '</tbody></table>' : '<p class="vazio">Nenhuma conta fixa neste mês.</p>';

    const cats = todasCategorias([mesSel, ant]);
    const max = Math.max(1, ...cats.map(c => Math.max(tA.porCat[c.id] || 0, tP.porCat[c.id] || 0)));
    const w = v => (v ? Math.max(v / max * 100, 1.5) : 0) + '%';
    document.getElementById('painelBarras').innerHTML = cats.map(c => {
      const a = tA.porCat[c.id] || 0, p = tP.porCat[c.id] || 0;
      const t = tendencia(a, p, tP.existe);
      return `<div class="barra-linha"><div title="${c.cod} ${esc(c.nome)}">${esc(c.nome)}</div><div class="barra-par">
        <div class="b"><div class="trilho"><div class="barra" style="width:${w(p)}"></div></div><span>${tP.existe ? brl(p) : '—'}</span></div>
        <div class="b atu"><div class="trilho"><div class="barra atu ${t}" style="width:${w(a)}"></div></div><span class="${t === 'mais' || t === 'menos' ? t : ''}">${brl(a)}</span></div>
      </div></div>`;
    }).join('');

    // histórico: até 6 meses terminando no mês selecionado, sem passar do mês inicial
    const meses = [];
    for (let i = 5; i >= 0; i--) { const k = somaMes(mesSel, -i); if (k >= MES_INICIAL) meses.push(k); }
    const tots = meses.map(k => totais(k));
    const mx = Math.max(1, ...tots.map(t => t.total));
    document.getElementById('historico').innerHTML = meses.map((k, i) => {
      const t = i ? tendencia(tots[i].total, tots[i - 1].total, tots[i - 1].existe) : 'sem';
      return `<div class="coluna ${t} ${k === mesSel ? 'sel' : ''}" title="${nomeMes(k)}: ${brl(tots[i].total)}"><div class="v">${brlCurto(tots[i].total)}</div><div class="c" style="height:${tots[i].total / mx * 82}%"></div></div>`;
    }).join('');
    document.getElementById('historicoRot').innerHTML = meses.map(k => `<div class="${k === mesSel ? 'sel' : ''}">${nomeMesCurto(k)}</div>`).join('');
  }

  function renderContas() {
    const m = dados.meses[mesSel];
    const mAnt = dados.meses[somaMes(mesSel, -1)];
    const fixas = fixasDoMes(mesSel);
    document.getElementById('tabContas').innerHTML = (fixas.length ? fixas.map(f => {
      const c = m.contas[f.id], s = situacao(mesSel, f, c);
      const cAnt = mAnt && mAnt.contas[f.id];
      return `<tr>
        <td class="titulo-linha"><span class="cod">${codFixa(f)}</span><strong>${esc(f.nome)}</strong></td>
        <td data-label="Vencimento"><input type="date" class="inline" data-conta-venc="${f.id}" value="${vencConta(mesSel, f, c)}"></td>
        <td data-label="Valor (R$)" class="num"><input class="inline valor" inputmode="decimal" data-conta-valor="${f.id}" value="${fmtValorInput(c.valor)}"></td>
        <td data-label="× mês anterior" class="num">${pilula(c.valor, cAnt ? cAnt.valor : 0, !!cAnt)}</td>
        <td data-label="Situação"><span class="tag ${s.cls}">${s.txt}</span></td>
        <td data-label="Pago em">${c.pago ? fmtData(c.pagoEm) : '—'}</td>
        <td class="num"><button class="btn peq editar ${c.pago ? 'sec' : ''}" data-conta-pagar="${f.id}" title="${c.pago ? 'Voltar esta conta para não paga' : 'Marcar esta conta como paga hoje'}">${c.pago ? ic('seta') + 'Desfazer pagamento' : 'Marcar como paga'}</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="vazio">Nenhuma conta fixa neste mês.</td></tr>') +
      `<tr class="total"><td class="titulo-linha" colspan="2">Total contas fixas</td><td class="num" data-label="Valor">${brl(totais(mesSel).fixas)}</td><td colspan="4"></td></tr>`;
  }

  // opções de conta agrupadas pelo plano: só as ativas, mais a atual da linha (mesmo se removida)
  function opcoesCat(sel) {
    return gruposOrdenados().filter(g => g.tipo !== 'fixas').map(g => {
      const cats = dados.categorias.filter(c => c.grupo === g.id && (c.ativa || c.id === sel)).sort(porSeq);
      if (!cats.length) return '';
      return `<optgroup label="${g.num} · ${esc(g.nome)}">` +
        cats.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${codCat(c)} ${esc(c.nome)}</option>`).join('') + '</optgroup>';
    }).join('');
  }
  function opcoesItem(sel) {
    return dados.itensOutros.filter(i => i.ativa || i.id === sel).sort(porSeq)
      .map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${codItem(i)} ${esc(i.nome)}</option>`).join('');
  }
  // campos de item e quantidade só aparecem para a conta da copa
  function atualizarFormOutros() {
    const outros = document.getElementById('fCat').value === 'outros';
    document.querySelectorAll('.so-outros').forEach(el => el.hidden = !outros);
    const item = document.getElementById('fItem').value;
    document.getElementById('fDesc').placeholder = !outros ? 'Ex.: almoço equipe, corrida até condomínio X'
      : item === 'outro' ? 'Descreva o item comprado' : 'Ex.: marca, tamanho (opcional)';
  }

  function renderDespesas() {
    const ant = somaMes(mesSel, -1);
    // recria as listas preservando a escolha atual (o plano pode ter mudado nos Ajustes)
    const fCat = document.getElementById('fCat');
    const catAtual = fCat.value;
    fCat.innerHTML = opcoesCat();
    if ([...fCat.options].some(o => o.value === catAtual)) fCat.value = catAtual;
    const fItem = document.getElementById('fItem');
    const itemAtual = fItem.value;
    fItem.innerHTML = opcoesItem();
    if ([...fItem.options].some(o => o.value === itemAtual)) fItem.value = itemAtual;
    atualizarFormOutros();

    const cats = catsVisiveis([mesSel, ant]);
    if (filtro && !cats.some(c => c.id === filtro)) filtro = '';
    const filt = document.getElementById('filtroCat');
    filt.innerHTML = '<option value="">Todas as contas</option>' + cats.map(c => `<option value="${c.id}">${codCat(c)} ${esc(c.nome)}</option>`).join('');
    filt.value = filtro;

    const fData = document.getElementById('fData');
    if (!fData.value || fData.value.slice(0, 7) !== mesSel) fData.value = hojeISO().slice(0, 7) === mesSel ? hojeISO() : mesSel + '-01';

    // resumo por conta com cor de tendência
    const tA = totais(mesSel), tP = totais(ant);
    document.getElementById('chips').innerHTML = cats.map(c => {
      const a = tA.porCat[c.id] || 0, p = tP.porCat[c.id] || 0;
      const t = tendencia(a, p, tP.existe);
      const d = t === 'sem' ? '<span class="neutro">sem comparação</span>'
        : t === 'igual' ? '<span class="neutro">= mês anterior</span>'
        : `<span class="${t}">${t === 'mais' ? '▲ +' : '▼ −'}${brl(Math.abs(a - p))}</span>`;
      return `<button type="button" class="chip ${t} ${filtro === c.id ? 'sel' : ''}" data-chip="${c.id}"><div class="n">${codCat(c)} ${esc(c.nome)}</div><div class="v">${brl(a)}</div><div class="d">${d}</div></button>`;
    }).join('');

    const lista = dados.meses[mesSel].despesas
      .filter(d => !filtro || d.categoria === filtro)
      .sort((a, b) => b.data.localeCompare(a.data));
    const tot = lista.reduce((s, d) => s + d.valor, 0);
    document.getElementById('filtroTotal').textContent = 'Total: ' + brl(tot);
    document.getElementById('tabDespesas').innerHTML = lista.length
      ? lista.map(d => `<tr>
          <td data-label="Data"><input type="date" class="inline" min="2026-11-01" data-edit="data" data-id="${d.id}" value="${d.data}"></td>
          <td data-label="Conta"><select class="inline" data-edit="categoria" data-id="${d.id}">${opcoesCat(d.categoria)}</select></td>
          ${d.categoria === 'outros'
            ? `<td data-label="Item"><select class="inline" data-edit="item" data-id="${d.id}">${opcoesItem(itemDe(d))}</select></td>`
            : '<td class="so-desk neutro">—</td>'}
          <td data-label="Descrição"><input class="inline" data-edit="descricao" data-id="${d.id}" value="${esc(d.descricao || '')}" placeholder="—"></td>
          ${d.categoria === 'outros'
            ? `<td data-label="Quantidade" class="num"><input type="number" min="1" step="1" inputmode="numeric" class="inline qtd-in" data-edit="qtd" data-id="${d.id}" value="${qtdDe(d)}"></td>`
            : '<td class="num so-desk neutro">—</td>'}
          <td data-label="Valor" class="num"><input class="inline valor" inputmode="decimal" data-edit="valor" data-id="${d.id}" value="${fmtValorInput(d.valor)}"></td>
          <td class="num"><button class="btn perigo peq editar" data-excluir="${d.id}">Excluir</button></td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="vazio">${filtro ? 'Nenhuma despesa em ' + esc(rotCat(filtro)) + ' neste mês.' : 'Nenhuma despesa lançada ainda.'}</td></tr>`;
  }

  // ---------- balancete (organizado pelo plano de contas, com filtro de personalização) ----------
  function dadosBalancete() {
    const f = filtroBal;
    const ant = somaMes(mesSel, -1);
    const tA = totais(mesSel), tP = totais(ant);
    const linhas = todasCategorias([mesSel, ant]).map(c => ({ ...c, ant: tP.porCat[c.id] || 0, atu: tA.porCat[c.id] || 0 }));
    const soma = (ls, k) => ls.reduce((s, l) => s + l[k], 0);

    const grupos = gruposOrdenados().map(g => ({ g, todas: linhas.filter(l => l.grupo === g.id) })).filter(x => x.todas.length);
    grupos.forEach(x => {
      x.sel = marcado(f.grupos, x.g.id) ? x.todas.filter(l => marcado(f.contas, l.id)) : [];
      x.atu = soma(x.sel, 'atu'); x.ant = soma(x.sel, 'ant');
    });
    const gruposSel = grupos.filter(x => x.sel.length);
    const sel = gruposSel.flatMap(x => x.sel);
    const completo = grupos.every(x => x.sel.length === x.todas.length);
    const temCopa = sel.some(l => l.id === 'outros');

    const iA = itensMes(mesSel), iP = itensMes(ant);
    // itens ativos sempre aparecem; removidos e "Outro item" só quando houver compra
    const itens = dados.itensOutros.slice().sort(porSeq)
      .filter(i => (i.ativa && i.id !== 'outro') || iA.porItem[i.id].qtd || iP.porItem[i.id].qtd)
      .map(i => ({ nome: i.nome, cod: codItem(i), ant: iP.porItem[i.id].valor, atu: iA.porItem[i.id].valor, qAnt: iP.porItem[i.id].qtd, qAtu: iA.porItem[i.id].qtd }));

    const ids = new Set(sel.map(l => l.id));
    const descricao = gruposSel.map(x => x.sel.length === x.todas.length
      ? x.g.num + ' ' + x.g.nome
      : x.sel.map(l => l.cod + ' ' + l.nome).join(', ')).join(' + ');

    return {
      f, ant, tA, tP, grupos, gruposSel, sel, completo,
      descricao: descricao || 'nada selecionado',
      totAtu: soma(sel, 'atu'), totAnt: soma(sel, 'ant'),
      itens: f.itens && temCopa ? itens : [],
      compras: f.compras && temCopa ? iA.compras.slice().sort((a, b) => a.data.localeCompare(b.data)) : null,
      lista: f.lista ? dados.meses[mesSel].despesas.filter(d => ids.has(d.categoria)).sort((a, b) => a.data.localeCompare(b.data)) : null
    };
  }

  function renderFiltroBal(B) {
    const f = B.f;
    const chk = (attr, val, rot, on, desab, forte) =>
      `<label class="check ${desab ? 'desab' : ''} ${forte ? 'forte' : ''}"><input type="checkbox" ${attr}="${val}" ${on ? 'checked' : ''}> ${esc(rot)}</label>`;
    const grupo = (titulo, conteudo) => `<div class="check-grupo"><h3>${titulo}</h3><div class="opcoes">${conteudo}</div></div>`;
    document.getElementById('opcoesFiltro').innerHTML =
      B.grupos.map(x => {
        const on = marcado(f.grupos, x.g.id);
        return grupo(esc(x.g.num + ' · ' + x.g.nome),
          chk('data-fb-grupo', x.g.id, 'Grupo inteiro', on, false, true) +
          x.todas.map(l => chk('data-fb-conta', l.id, l.cod + ' ' + l.nome, marcado(f.contas, l.id), !on)).join(''));
      }).join('') +
      grupo('Detalhes', chk('data-fb', 'itens', 'Itens da copa com quantidades', f.itens) + chk('data-fb', 'compras', 'Lista de compras da copa', f.compras) + chk('data-fb', 'lista', 'Lista de todas as despesas lançadas', f.lista)) +
      grupo('Exibição', chk('data-fb', 'comparar', 'Comparar com o mês anterior', f.comparar) + chk('data-fb', 'resumo', 'Resumo do mês', f.resumo));
  }

  function renderBalancete() {
    const B = dadosBalancete();
    const { f, ant, tP } = B;
    const comp = f.comparar && tP.existe;
    renderFiltroBal(B);

    document.getElementById('tituloBal').textContent = 'Balancete — ' + nomeMes(mesSel) + (f.comparar ? ' × ' + nomeMes(ant) : '');
    document.getElementById('thAnt').textContent = nomeMesCurto(ant);
    document.getElementById('thAtu').textContent = nomeMesCurto(mesSel);
    document.getElementById('tabelaBal').classList.toggle('sem-comp', !f.comparar);
    document.getElementById('filtroAtivo').innerHTML = B.completo ? '' : 'Mostrando: <strong>' + esc(B.descricao) + '</strong>';
    document.getElementById('printFiltro').textContent = B.completo ? '' : ' · ' + B.descricao;
    const lAnt = nomeMesCurto(ant), lAtu = nomeMesCurto(mesSel);

    const celulas = (a, p, txtAnt, txtAtu) => `
      <td class="num comp" data-label="${lAnt}">${tP.existe ? txtAnt : '—'}</td>
      <td class="num" data-label="${lAtu}">${txtAtu}</td>
      <td class="num comp" data-label="Diferença">${pilula(a, p, tP.existe)}</td>
      <td class="num comp" data-label="Variação">${pilula(a, p, tP.existe, 'pct')}</td>`;
    const linhaGrupo = (cls, rot, a, p) => `<tr class="${cls}"><td class="titulo-linha"><strong>${rot}</strong></td>${celulas(a, p, brl(p), brl(a))}</tr>`;
    const linhaConta = l => `<tr><td class="titulo-linha sub"><span class="cod">${l.cod}</span>${esc(l.nome)}</td>${celulas(l.atu, l.ant, brl(l.ant), brl(l.atu))}</tr>`;
    const linhaItem = it => `<tr class="item">
      <td class="titulo-linha sub2"><span class="cod">${it.cod}</span>${esc(it.nome)}</td>${celulas(it.atu, it.ant,
        brl(it.ant) + ' <span class="qtd">· ' + fmtQtd(it.qAnt) + '</span>',
        brl(it.atu) + ' <span class="qtd">· ' + fmtQtd(it.qAtu) + '</span>')}</tr>`;

    let html = B.gruposSel.map(x =>
      linhaGrupo('grupo', `<span class="cod">${x.g.num}</span>${esc(x.g.nome)}`, x.atu, x.ant) +
      x.sel.map(l => linhaConta(l) + (l.id === 'outros' ? B.itens.map(linhaItem).join('') : '')).join('')).join('');
    html += B.sel.length
      ? linhaGrupo('total', B.completo ? 'TOTAL DO MÊS' : 'TOTAL SELECIONADO', B.totAtu, B.totAnt)
      : '<tr><td colspan="5" class="vazio">Nada selecionado. Abra “Personalizar balancete e impressão” e marque o que deseja ver.</td></tr>';
    document.getElementById('tabBal').innerHTML = html;

    // resumo com os totais do que está selecionado
    let resumo = '';
    if (f.resumo) {
      const quem = B.completo ? 'O escritório' : 'Nas contas selecionadas, o escritório';
      const d = B.totAtu - B.totAnt;
      if (!comp) resumo = `<div class="resumo igual">${f.comparar && !tP.existe ? nomeMes(mesSel) + ' é o primeiro mês com lançamentos — a comparação começa a partir do próximo mês. ' : ''}${B.completo ? 'Total gasto' : 'Total selecionado'}: <strong>${brl(B.totAtu)}</strong>.</div>`;
      else {
        const maiores = B.sel.map(l => ({ ...l, d: l.atu - l.ant })).filter(l => Math.abs(l.d) > 0.005).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 2);
        const destaque = maiores.length ? ' Maior variação: ' + maiores.map(l => `<span class="${l.d > 0 ? 'mais' : 'menos'}">${l.cod} ${esc(l.nome)} (${l.d > 0 ? '+' : '−'}${brl(Math.abs(l.d))})</span>`).join(', ') + '.' : '';
        if (Math.abs(d) < 0.005) resumo = `<div class="resumo igual">${quem} gastou <strong>o mesmo valor</strong> que em ${nomeMes(ant)}: ${brl(B.totAtu)}.${destaque}</div>`;
        else if (d > 0) resumo = `<div class="resumo mais">${quem} <strong class="mais">▲ gastou ${brl(d)} a mais</strong> que em ${nomeMes(ant)}${B.totAnt ? ' (' + pct(d / B.totAnt * 100) + ')' : ''}.${destaque}</div>`;
        else resumo = `<div class="resumo menos">${quem} <strong class="menos">▼ gastou ${brl(-d)} a menos</strong> que em ${nomeMes(ant)} (${pct(d / B.totAnt * 100)}).${destaque}</div>`;
      }
    }
    document.getElementById('resumoBal').innerHTML = resumo;

    const nomeCopa = copa() ? rotCat('outros') : 'Copa';
    document.getElementById('tituloCompras').textContent = nomeCopa;
    document.getElementById('cardCompras').hidden = !B.compras;
    if (B.compras) {
      const l = B.compras;
      document.getElementById('tabOutros').innerHTML = l.length
        ? l.map(d => `<tr>
            <td data-label="Data">${fmtData(d.data)}</td>
            <td class="titulo-linha"><strong>${esc(rotItem(itemDe(d)))}</strong></td>
            <td data-label="Descrição">${esc(d.descricao || '—')}</td>
            <td class="num" data-label="Quantidade">${fmtQtd(qtdDe(d))}</td>
            <td class="num" data-label="Valor">${brl(d.valor)}</td></tr>`).join('') +
          `<tr class="total"><td class="titulo-linha" colspan="3">Total — ${esc(nomeCopa)}</td><td class="num" data-label="Quantidade">${fmtQtd(l.reduce((s, d) => s + qtdDe(d), 0))}</td><td class="num" data-label="Valor">${brl(l.reduce((s, d) => s + d.valor, 0))}</td></tr>`
        : '<tr><td colspan="5" class="vazio">Nenhuma compra da copa neste mês.</td></tr>';
    }

    document.getElementById('cardLista').hidden = !B.lista;
    if (B.lista) {
      const l = B.lista;
      document.getElementById('tabLista').innerHTML = l.length
        ? l.map(d => {
            const outros = d.categoria === 'outros';
            return `<tr>
              <td data-label="Data">${fmtData(d.data)}</td>
              <td class="titulo-linha"><strong>${esc(rotCat(d.categoria))}</strong></td>
              <td data-label="Item">${outros ? esc(rotItem(itemDe(d))) : '—'}</td>
              <td data-label="Descrição">${esc(d.descricao || '—')}</td>
              <td class="num" data-label="Quantidade">${outros ? fmtQtd(qtdDe(d)) : '—'}</td>
              <td class="num" data-label="Valor">${brl(d.valor)}</td></tr>`;
          }).join('') +
          `<tr class="total"><td class="titulo-linha" colspan="5">Total das despesas listadas</td><td class="num" data-label="Valor">${brl(l.reduce((s, d) => s + d.valor, 0))}</td></tr>`
        : '<tr><td colspan="6" class="vazio">Nenhuma despesa lançada nas contas selecionadas.</td></tr>';
    }
  }

  // plano de contas completo (ativos), na ordem dos códigos
  function linhasPlano() {
    const out = [];
    gruposOrdenados().filter(g => g.ativa).forEach(g => {
      out.push({ nivel: 0, cod: String(g.num), nome: g.nome });
      if (g.tipo === 'fixas') dados.fixas.filter(f => !f.ate).sort(porSeq).forEach(f => out.push({ nivel: 1, cod: codFixa(f), nome: f.nome }));
      dados.categorias.filter(c => c.grupo === g.id && c.ativa).sort(porSeq).forEach(c => {
        out.push({ nivel: 1, cod: codCat(c), nome: c.nome });
        if (c.id === 'outros') dados.itensOutros.filter(i => i.ativa).sort(porSeq).forEach(i => out.push({ nivel: 2, cod: codItem(i), nome: i.nome }));
      });
    });
    return out;
  }

  function renderConfig() {
    const ativas = dados.fixas.filter(f => !f.ate).sort(porSeq);
    document.getElementById('tabConfig').innerHTML = ativas.length ? ativas.map(f => `<tr>
      <td data-label="Conta"><div class="nome-cod"><span class="cod">${codFixa(f)}</span><input data-cfg-nome="${f.id}" value="${esc(f.nome)}"></div></td>
      <td data-label="Dia do vencimento"><input class="dia" type="number" inputmode="numeric" min="1" max="31" data-cfg-dia="${f.id}" value="${f.dia}"></td>
      <td class="num" data-label="Valor padrão (R$)"><input class="valor" inputmode="decimal" data-cfg-valor="${f.id}" value="${fmtValorInput(f.valor)}"></td>
      <td class="num"><button class="btn perigo peq editar" data-rem-fixa="${f.id}">Remover</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="vazio">Nenhuma conta fixa cadastrada.</td></tr>';

    // editor do plano de contas
    const gruposAtivos = gruposOrdenados().filter(g => g.ativa);
    const opcoesGrupo = sel => gruposAtivos.filter(g => g.tipo !== 'fixas')
      .map(g => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>Grupo ${g.num} · ${esc(g.nome)}</option>`).join('');
    document.getElementById('planoEditor').innerHTML = gruposAtivos.map(g => {
      const cab = `<div class="linha cab"><span class="cod">${g.num}</span><input data-grupo-nome="${g.id}" value="${esc(g.nome)}" aria-label="Nome do grupo">`;
      if (g.tipo === 'fixas') {
        return `<div class="grupo-plano">${cab}<span class="fixo">contas fixas</span></div>` +
          dados.fixas.filter(f => !f.ate).sort(porSeq).map(f => `<div class="linha so-ler"><span class="cod">${codFixa(f)}</span>${esc(f.nome)}</div>`).join('') +
          `<p class="miudo" style="margin:0">As contas deste grupo são cadastradas no card “Contas fixas”, com vencimento e valor.</p></div>`;
      }
      const cats = dados.categorias.filter(c => c.grupo === g.id && c.ativa).sort(porSeq);
      return `<div class="grupo-plano">${cab}${cats.length ? '' : `<button class="btn perigo peq editar" data-rem-grupo="${g.id}">Remover</button>`}</div>` +
        cats.map(c => `<div class="linha"><span class="cod">${codCat(c)}</span>
            <input data-cat-nome="${c.id}" value="${esc(c.nome)}" aria-label="Nome da conta">
            <select data-cat-grupo="${c.id}" aria-label="Grupo">${opcoesGrupo(c.grupo)}</select>
            ${c.id === 'outros' ? '<span class="fixo">tem itens</span>' : `<button class="btn perigo peq editar" data-rem-cat="${c.id}">Remover</button>`}
          </div>` +
          (c.id === 'outros'
            ? dados.itensOutros.filter(i => i.ativa).sort(porSeq).map(i => `<div class="linha sub"><span class="cod">${codItem(i)}</span>
                <input data-item-nome="${i.id}" value="${esc(i.nome)}" aria-label="Nome do item">
                ${i.id === 'outro' ? '<span class="fixo">avulsos</span>' : `<button class="btn perigo peq editar" data-rem-item="${i.id}">Remover</button>`}
              </div>`).join('') +
              `<form class="add mini sub editar" data-add-item><input placeholder="Novo item em ${esc(c.nome)} (ex.: Água mineral)" autocomplete="off" required><button class="btn sec peq" type="submit">+ Item</button></form>`
            : '')).join('') +
        `<form class="add mini editar" data-add-cat="${g.id}"><input placeholder="Nova conta em ${esc(g.nome)}" autocomplete="off" required><button class="btn sec peq" type="submit">+ Conta</button></form></div>`;
    }).join('');

    document.getElementById('ultimoBackup').textContent = dados.ultimoBackup
      ? 'Último backup: ' + new Date(dados.ultimoBackup).toLocaleString('pt-BR')
      : 'Nenhum backup feito ainda.';
  }

  // ---------- eventos ----------
  const toast = msg => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 3200); };
  function mensagemUsuario(e, padrao = 'Não foi possível concluir. Tente novamente.') {
    const codigo = e && (e.code || e.status);
    if (!navigator.onLine || /network|fetch|failed to fetch/i.test(e && e.message || '')) return 'Sem conexão. Confira a internet e tente novamente.';
    if (codigo === 'PT409') return 'Os dados mudaram em outro aparelho. Atualize a tela e tente de novo.';
    if (codigo === 'PT403' || codigo === 401 || codigo === 403) return 'Seu acesso não permite esta ação. Entre novamente ou fale com o administrador.';
    if (codigo === 429) return 'Muitos envios em pouco tempo. Aguarde alguns minutos e tente novamente.';
    const msg = String(e && e.message || '');
    if (/duplicate|unique/i.test(msg)) return 'Este registro já existe.';
    if (/invalid.*(input|date|value)|violates check/i.test(msg)) return 'Confira os campos informados e tente novamente.';
    return padrao;
  }
  async function executarBotao(botao, textoCarregando, acao, textoFalha) {
    if (!botao || botao.disabled) return;
    const original = botao.innerHTML;
    botao.disabled = true; botao.setAttribute('aria-busy', 'true'); botao.textContent = textoCarregando;
    try { await acao(); }
    catch (e) { toast(mensagemUsuario(e, textoFalha)); }
    finally { botao.innerHTML = original; botao.disabled = false; botao.removeAttribute('aria-busy'); }
  }

  function irParaAba(nome) {
    if (!nome) return;   // ex.: botão "← Visão geral" da barra, que navega pelo data-ir
    document.querySelectorAll('nav.abas button').forEach(x => x.classList.toggle('ativa', x.dataset.aba === nome));
    document.querySelectorAll('.aba').forEach(s => s.classList.toggle('ativa', s.id === 'aba-' + nome));
    document.body.dataset.aba = nome;
    aplicarArea(areaDaAba(nome));
    document.getElementById('tituloPagina').textContent = nome === 'usuarios' && ehDev() ? 'Acessos' : (TITULOS[nome] || 'Portal SLZ');
    // subtítulo conforme a aba (o dev e a síndica têm o deles, definido pela área/condomínio)
    if (!ehDev() && !document.body.classList.contains('externo'))
      document.getElementById('subTitulo').textContent = nome === 'documentos' ? 'Notas e comprovantes dos condomínios'
        : nome === 'usuarios' ? 'Pessoas e condomínios com acesso' : 'Controle de gastos do escritório';
    const botao = document.querySelector(`nav.abas button[data-aba="${nome}"]`);
    if (botao && botao.scrollIntoView) botao.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    try { sessionStorage.setItem('slz-aba', nome); } catch (e) {}
    if (nome === 'documentos' && perfil) carregarDocs();
    if (nome === 'geral' && perfil) carregarGeral();
    if (nome === 'config' && ehDev()) carregarHistoricoAdmin();
  }
  document.querySelectorAll('nav.abas button').forEach(b => b.addEventListener('click', () => { irParaAba(b.dataset.aba); window.scrollTo(0, 0); }));
  document.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', () => { irParaAba(b.dataset.ir); window.scrollTo(0, 0); }));
  try { const a = sessionStorage.getItem('slz-aba'); if (a && a !== 'plano' && document.getElementById('aba-' + a)) irParaAba(a); } catch (e) {}

  document.getElementById('fab').onclick = () => {
    irParaAba('despesas');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => document.getElementById('fValor').focus(), 250);
  };

  // abre o calendário ao clicar em qualquer ponto do campo de data (não só no ícone)
  document.addEventListener('click', e => {
    const el = e.target;
    if (el.matches && el.matches('input[type="date"]') && typeof el.showPicker === 'function') {
      try { el.showPicker(); } catch (err) {}
    }
  });

  document.getElementById('mesAnt').onclick = () => { if (mesSel > MES_INICIAL) { mesSel = somaMes(mesSel, -1); render(); } };
  document.getElementById('mesProx').onclick = () => { mesSel = somaMes(mesSel, 1); render(); };
  let larguraAnt = window.innerWidth;
  window.addEventListener('resize', () => {
    if ((larguraAnt <= 760) !== (window.innerWidth <= 760)) document.getElementById('mesLabel').textContent = window.innerWidth <= 760 ? nomeMesCurto(mesSel) : nomeMes(mesSel);
    larguraAnt = window.innerWidth;
  });

  document.getElementById('tabContas').addEventListener('change', e => {
    const idVenc = e.target.dataset.contaVenc;
    if (idVenc) {
      if (!e.target.value) { toast('Data inválida'); renderContas(); return; }
      dados.meses[mesSel].contas[idVenc].venc = e.target.value;
      salvar(); render(); toast('Vencimento atualizado');
      return;
    }
    const id = e.target.dataset.contaValor;
    if (!id) return;
    const v = lerValor(e.target.value);
    if (isNaN(v) || v < 0) { toast('Valor inválido'); renderContas(); return; }
    dados.meses[mesSel].contas[id].valor = v;
    salvar(); render(); toast('Valor atualizado');
  });
  document.getElementById('tabContas').addEventListener('click', e => {
    const b = e.target.closest('[data-conta-pagar]');
    const id = b && b.dataset.contaPagar;
    if (!id) return;
    const c = dados.meses[mesSel].contas[id];
    c.pago = !c.pago;
    c.pagoEm = c.pago ? hojeISO() : '';
    salvar(); render(); toast(c.pago ? 'Conta marcada como paga' : 'Pagamento desmarcado');
  });

  document.getElementById('formDespesa').addEventListener('submit', e => {
    e.preventDefault();
    if (!podeEditar) return;
    const valor = lerValor(document.getElementById('fValor').value);
    const data = document.getElementById('fData').value;
    if (isNaN(valor) || valor <= 0) { toast('Informe um valor válido'); return; }
    if (!data) { toast('Informe a data'); return; }
    // a despesa vai para o mês da data informada
    const chave = data.slice(0, 7);
    if (chave < MES_INICIAL) { toast('O controle começa em Novembro de 2026'); return; }
    const categoria = document.getElementById('fCat').value;
    if (!categoria) { toast('Cadastre uma conta no plano de contas (Ajustes)'); return; }
    const descricao = document.getElementById('fDesc').value.trim();
    const nova = { id: novoId('d'), data, categoria, descricao, valor };
    if (categoria === 'outros') {
      nova.item = document.getElementById('fItem').value || 'outro';
      nova.qtd = parseFloat(String(document.getElementById('fQtd').value).replace(',', '.'));
      if (!(nova.qtd > 0)) { toast('Informe a quantidade'); return; }
      if (nova.item === 'outro' && !descricao) { toast('Descreva o item comprado'); document.getElementById('fDesc').focus(); return; }
    }
    mesDados(chave, true).despesas.push(nova);
    salvar();
    document.getElementById('fValor').value = '';
    document.getElementById('fDesc').value = '';
    document.getElementById('fQtd').value = 1;
    const outroMes = chave !== mesSel;
    mesSel = chave;
    render(); toast(outroMes ? 'Despesa lançada em ' + nomeMes(chave) : 'Despesa lançada');
  });

  document.getElementById('fCat').addEventListener('change', atualizarFormOutros);
  document.getElementById('fItem').addEventListener('change', atualizarFormOutros);

  // edição direto na lista de despesas
  const tabDesp = document.getElementById('tabDespesas');
  tabDesp.addEventListener('change', e => {
    const campo = e.target.dataset.edit, id = e.target.dataset.id;
    if (!campo) return;
    const m = dados.meses[mesSel];
    const d = m.despesas.find(x => x.id === id);
    if (!d) return;
    if (campo === 'valor') {
      const v = lerValor(e.target.value);
      if (isNaN(v) || v <= 0) { toast('Valor inválido'); renderDespesas(); return; }
      d.valor = v;
    } else if (campo === 'data') {
      const nova = e.target.value;
      if (!nova || nova.slice(0, 7) < MES_INICIAL) { toast('O controle começa em Novembro de 2026'); renderDespesas(); return; }
      d.data = nova;
      const chave = nova.slice(0, 7);
      if (chave !== mesSel) {
        // mudou de mês: move a despesa para o mês certo
        m.despesas = m.despesas.filter(x => x.id !== id);
        mesDados(chave, true).despesas.push(d);
        salvar(); render(); toast('Despesa movida para ' + nomeMes(chave));
        return;
      }
    } else if (campo === 'categoria') {
      d.categoria = e.target.value;
      if (d.categoria === 'outros') { d.item = d.item || 'outro'; d.qtd = d.qtd || 1; }
    } else if (campo === 'item') d.item = e.target.value;
    else if (campo === 'qtd') {
      const q = parseFloat(String(e.target.value).replace(',', '.'));
      if (!(q > 0)) { toast('Quantidade inválida'); renderDespesas(); return; }
      d.qtd = q;
    }
    else if (campo === 'descricao') d.descricao = e.target.value.trim();
    salvar(); render(); toast('Despesa atualizada');
  });
  tabDesp.addEventListener('click', e => {
    const id = e.target.dataset.excluir;
    if (!id || !confirm('Excluir esta despesa?')) return;
    const m = dados.meses[mesSel];
    m.despesas = m.despesas.filter(d => d.id !== id);
    salvar(); render(); toast('Despesa excluída');
  });
  document.getElementById('filtroCat').addEventListener('change', e => { filtro = e.target.value; renderDespesas(); });
  document.getElementById('chips').addEventListener('click', e => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    filtro = filtro === b.dataset.chip ? '' : b.dataset.chip;
    renderDespesas();
  });

  // ---------- ajustes: contas fixas ----------
  document.getElementById('btnSalvarConfig').onclick = () => {
    const ativas = dados.fixas.filter(f => !f.ate);
    for (const f of ativas) {
      const nome = document.querySelector(`[data-cfg-nome="${f.id}"]`).value.trim();
      const v = lerValor(document.querySelector(`[data-cfg-valor="${f.id}"]`).value);
      const dia = parseInt(document.querySelector(`[data-cfg-dia="${f.id}"]`).value, 10);
      if (!nome || isNaN(v) || v < 0 || !(dia >= 1 && dia <= 31)) { toast('Confira os dados de ' + (nome || f.nome)); return; }
      f.nome = nome; f.valor = v; f.dia = dia;
    }
    // aplica o novo valor padrão nas contas ainda não pagas do mês selecionado em diante
    Object.keys(dados.meses).filter(k => k >= mesSel).forEach(k => {
      ativas.forEach(f => { const c = dados.meses[k].contas[f.id]; if (c && !c.pago) { c.valor = f.valor; delete c.venc; } });
    });
    salvar(); render(); toast('Contas fixas salvas');
  };
  // nova conta fixa (usada em Ajustes e no botão vermelho da aba Contas fixas)
  function novaFixa(nome, diaTxt, valorTxt) {
    nome = nome.trim();
    const dia = parseInt(diaTxt, 10);
    const valor = valorTxt.trim() ? lerValor(valorTxt) : 0;
    if (!podeEditar) return false;
    if (!nome) { toast('Informe o nome da conta'); return false; }
    if (!(dia >= 1 && dia <= 31)) { toast('Informe o dia do vencimento (1 a 31)'); return false; }
    if (isNaN(valor) || valor < 0) { toast('Valor inválido'); return false; }
    const f = { id: novoId('f'), nome, dia, valor, desde: mesSel, seq: proxSeq(dados.fixas, () => true) };
    dados.fixas.push(f);
    salvar(); render(); toast(codFixa(f) + ' ' + nome + ' adicionada a partir de ' + nomeMes(mesSel));
    return true;
  }
  document.getElementById('formNovaFixa').addEventListener('submit', e => {
    e.preventDefault();
    if (novaFixa(document.getElementById('nfNome').value, document.getElementById('nfDia').value, document.getElementById('nfValor').value)) e.target.reset();
  });

  // nova conta de despesa no plano (usada em Ajustes e no botão vermelho da aba Despesas)
  function novaConta(grupo, nome) {
    nome = nome.trim();
    if (!podeEditar || !nome) return null;
    if (dados.categorias.some(c => c.ativa && mesmoNome(c.nome, nome))) { toast('Essa conta já existe'); return null; }
    const antigo = dados.categorias.find(c => !c.ativa && mesmoNome(c.nome, nome));
    let c;
    if (antigo) { c = antigo; c.ativa = true; if (c.grupo !== grupo) { c.grupo = grupo; c.seq = proxSeq(dados.categorias, x => x.grupo === grupo && x.id !== c.id); } }
    else { c = { id: novoId('c'), nome, ativa: true, grupo, seq: proxSeq(dados.categorias, x => x.grupo === grupo) }; dados.categorias.push(c); }
    salvar(); render(); toast(codCat(c) + ' ' + nome + ' adicionada');
    return c;
  }

  // janelas do botão vermelho "+"
  document.querySelectorAll('dialog.modal [data-fechar]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  document.getElementById('maisFixa').onclick = () => {
    document.getElementById('formModalFixa').reset();
    document.getElementById('modalFixa').showModal();
    document.getElementById('mfNome').focus();
  };
  document.getElementById('formModalFixa').addEventListener('submit', e => {
    e.preventDefault();
    if (novaFixa(document.getElementById('mfNome').value, document.getElementById('mfDia').value, document.getElementById('mfValor').value))
      document.getElementById('modalFixa').close();
  });
  document.getElementById('maisConta').onclick = () => {
    document.getElementById('formModalConta').reset();
    document.getElementById('mcGrupo').innerHTML = gruposOrdenados().filter(g => g.ativa && g.tipo !== 'fixas')
      .map(g => `<option value="${g.id}">Grupo ${g.num} · ${esc(g.nome)}</option>`).join('');
    document.getElementById('modalConta').showModal();
    document.getElementById('mcNome').focus();
  };
  document.getElementById('formModalConta').addEventListener('submit', e => {
    e.preventDefault();
    const c = novaConta(document.getElementById('mcGrupo').value, document.getElementById('mcNome').value);
    if (!c) return;
    document.getElementById('modalConta').close();
    // já deixa a conta nova escolhida no formulário de lançar
    document.getElementById('fCat').value = c.id;
    atualizarFormOutros();
    document.getElementById('fValor').focus();
  });
  document.getElementById('tabConfig').addEventListener('click', e => {
    const id = e.target.dataset.remFixa;
    if (!id) return;
    const f = dados.fixas.find(x => x.id === id);
    if (!confirm(`Remover "${f.nome}" a partir de ${nomeMes(mesSel)}?\nOs meses anteriores e as faturas já pagas continuam no histórico.`)) return;
    f.ate = mesSel;
    Object.keys(dados.meses).filter(k => k >= mesSel).forEach(k => {
      const c = dados.meses[k].contas[id];
      if (c && !c.pago) delete dados.meses[k].contas[id];
    });
    // se nunca foi usada em mês nenhum, some de vez
    if (!Object.values(dados.meses).some(m => m.contas[id])) dados.fixas = dados.fixas.filter(x => x.id !== id);
    salvar(); render(); toast(f.nome + ' removida');
  });

  // ---------- ajustes: plano de contas ----------
  const todosMeses = () => Object.keys(dados.meses);
  const mesmoNome = (a, b) => a.toLowerCase() === b.toLowerCase();
  const editor = document.getElementById('planoEditor');
  editor.addEventListener('change', e => {
    const t = e.target, d = t.dataset;
    const nome = t.value.trim();
    if ((d.grupoNome || d.catNome || d.itemNome) && !nome) { toast('O nome não pode ficar vazio'); renderConfig(); return; }
    if (d.grupoNome) { dados.grupos.find(g => g.id === d.grupoNome).nome = nome; toast('Grupo renomeado'); }
    else if (d.catNome) { catPorId(d.catNome).nome = nome; toast('Conta renomeada'); }
    else if (d.itemNome) { dados.itensOutros.find(i => i.id === d.itemNome).nome = nome; toast('Item renomeado'); }
    else if (d.catGrupo) {
      // mudar de grupo dá o próximo código livre no grupo novo
      const c = catPorId(d.catGrupo);
      c.grupo = t.value;
      c.seq = proxSeq(dados.categorias, x => x.grupo === c.grupo && x.id !== c.id);
      toast('Conta movida para ' + codCat(c));
    } else return;
    salvar(); render();
  });
  editor.addEventListener('click', e => {
    const d = e.target.dataset;
    if (d.remCat) {
      const c = catPorId(d.remCat);
      const emUso = usadaEm(todosMeses(), x => x.categoria === c.id);
      if (!confirm(`Remover "${codCat(c)} ${c.nome}"?` + (emUso ? '\nOs lançamentos antigos continuam no histórico.' : ''))) return;
      // com lançamentos: só esconde (o código continua reservado); sem lançamentos: apaga
      if (emUso) c.ativa = false; else dados.categorias = dados.categorias.filter(x => x.id !== c.id);
      salvar(); render(); toast('Conta removida');
    } else if (d.remItem) {
      const i = dados.itensOutros.find(x => x.id === d.remItem);
      const emUso = usadaEm(todosMeses(), x => x.categoria === 'outros' && itemDe(x) === i.id);
      if (!confirm(`Remover "${codItem(i)} ${i.nome}"?` + (emUso ? '\nOs lançamentos antigos continuam no histórico.' : ''))) return;
      if (emUso) i.ativa = false; else dados.itensOutros = dados.itensOutros.filter(x => x.id !== i.id);
      salvar(); render(); toast('Item removido');
    } else if (d.remGrupo) {
      const g = dados.grupos.find(x => x.id === d.remGrupo);
      if (!confirm(`Remover o grupo "${g.num} ${g.nome}"?`)) return;
      if (dados.categorias.some(c => c.grupo === g.id)) g.ativa = false; else dados.grupos = dados.grupos.filter(x => x.id !== g.id);
      salvar(); render(); toast('Grupo removido');
    }
  });
  editor.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target, nome = form.querySelector('input').value.trim();
    if (!nome) return;
    if (form.hasAttribute('data-add-item')) {
      const lista = dados.itensOutros;
      if (lista.some(i => i.ativa && mesmoNome(i.nome, nome))) { toast('Esse item já existe'); return; }
      const antigo = lista.find(i => !i.ativa && mesmoNome(i.nome, nome));
      if (antigo) antigo.ativa = true;
      else lista.push({ id: novoId('i'), nome, ativa: true, seq: proxSeq(lista, () => true) });
      salvar(); render(); toast('Item adicionado');
    } else if (form.dataset.addCat) {
      novaConta(form.dataset.addCat, nome);
    }
  });
  document.getElementById('formNovoGrupo').addEventListener('submit', e => {
    e.preventDefault();
    const nome = document.getElementById('ngNome').value.trim();
    if (!nome) return;
    const antigo = dados.grupos.find(g => mesmoNome(g.nome, nome));
    if (antigo && antigo.ativa) { toast('Esse grupo já existe'); return; }
    if (antigo) antigo.ativa = true;
    else dados.grupos.push({ id: novoId('g'), num: Math.max(0, ...dados.grupos.map(g => g.num)) + 1, nome, ativa: true });
    e.target.reset();
    salvar(); render(); toast('Grupo adicionado');
  });

  function imprimirSecao(id) {
    const s = document.getElementById(id);
    s.classList.add('imprimir'); window.print(); s.classList.remove('imprimir');
  }
  document.getElementById('btnImprimirPlano').onclick = () => {
    document.getElementById('planoData').textContent = 'Emitido em ' + fmtData(hojeISO());
    document.getElementById('tabPlanoImpressao').innerHTML = linhasPlano().map(l =>
      `<tr class="${l.nivel === 0 ? 'grupo' : ''}"><td><strong>${l.cod}</strong></td><td style="padding-left:${10 + l.nivel * 22}px">${l.nivel === 0 ? '<strong>' + esc(l.nome) + '</strong>' : esc(l.nome)}</td></tr>`).join('');
    imprimirSecao('aba-plano');
  };

  // ---------- personalização do balancete ----------
  const PRESETS = {
    completo: () => ({ ...FILTRO_PADRAO }),
    fixas: () => {
      const grupos = {};
      dados.grupos.forEach(g => { if (g.tipo !== 'fixas') grupos[g.id] = false; });
      return { ...FILTRO_PADRAO, grupos, compras: false };
    },
    mes: () => ({ ...FILTRO_PADRAO, grupos: { [grupoFixas().id]: false }, lista: true }),
    copa: () => {
      const c = copa(), grupos = {}, contas = {};
      dados.grupos.forEach(g => { if (!c || g.id !== c.grupo) grupos[g.id] = false; });
      dados.categorias.forEach(x => { if (x.id !== 'outros') contas[x.id] = false; });
      return { ...FILTRO_PADRAO, grupos, contas };
    }
  };
  document.querySelector('.presets').addEventListener('click', e => {
    const p = e.target.dataset.preset;
    if (!p) return;
    filtroBal = PRESETS[p]();
    salvarFiltro(); renderBalancete();
  });
  document.getElementById('opcoesFiltro').addEventListener('change', e => {
    const t = e.target, d = t.dataset;
    if (d.fb) filtroBal[d.fb] = t.checked;
    else if (d.fbGrupo) filtroBal.grupos = { ...filtroBal.grupos, [d.fbGrupo]: t.checked };
    else if (d.fbConta) filtroBal.contas = { ...filtroBal.contas, [d.fbConta]: t.checked };
    else return;
    salvarFiltro(); renderBalancete();
  });

  document.getElementById('btnImprimir').onclick = () => imprimirSecao('aba-balancete');

  function baixar(nome, conteudo, tipo) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const paraCsv = rows => '﻿' + rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');

  document.getElementById('btnCsvPlano').onclick = () => {
    const rows = [['Código', 'Conta', 'Nível']];
    linhasPlano().forEach(l => rows.push([l.cod, l.nome, ['Grupo', 'Conta', 'Item'][l.nivel]]));
    baixar('plano-de-contas-slz.csv', paraCsv(rows), 'text/csv;charset=utf-8');
  };

  document.getElementById('btnCsv').onclick = () => {
    const B = dadosBalancete();
    const n = v => v.toFixed(2).replace('.', ',');
    const q = v => String(v).replace('.', ',');
    const rows = [];
    if (!B.completo) rows.push(['Filtro: ' + B.descricao], []);
    rows.push(['Código', 'Conta', nomeMes(B.ant), nomeMes(mesSel), 'Diferença', 'Qtd ' + nomeMes(B.ant), 'Qtd ' + nomeMes(mesSel)]);
    B.gruposSel.forEach(x => {
      rows.push([x.g.num, x.g.nome, n(x.ant), n(x.atu), n(x.atu - x.ant)]);
      x.sel.forEach(l => {
        rows.push([l.cod, l.nome, n(l.ant), n(l.atu), n(l.atu - l.ant)]);
        if (l.id === 'outros') B.itens.forEach(it => rows.push([it.cod, it.nome, n(it.ant), n(it.atu), n(it.atu - it.ant), q(it.qAnt), q(it.qAtu)]));
      });
    });
    rows.push(['', B.completo ? 'TOTAL' : 'TOTAL SELECIONADO', n(B.totAnt), n(B.totAtu), n(B.totAtu - B.totAnt)]);
    const ids = new Set(B.sel.map(l => l.id));
    const despesas = B.lista || dados.meses[mesSel].despesas.filter(d => ids.has(d.categoria)).sort((a, b) => a.data.localeCompare(b.data));
    if (despesas.length) {
      rows.push([], ['Despesas lançadas'], ['Data', 'Código', 'Conta', 'Item', 'Descrição', 'Quantidade', 'Valor']);
      despesas.forEach(d => {
        const outros = d.categoria === 'outros';
        const c = catPorId(d.categoria);
        rows.push([fmtData(d.data), c ? codCat(c) : '', nomeCat(d.categoria), outros ? rotItem(itemDe(d)) : '', d.descricao, outros ? q(qtdDe(d)) : '', n(d.valor)]);
      });
    }
    baixar(`balancete-slz-${mesSel}.csv`, paraCsv(rows), 'text/csv;charset=utf-8');
  };

  document.getElementById('btnExportar').onclick = () => {
    dados.ultimoBackup = new Date().toISOString();
    salvar();
    baixar(`backup-gastos-slz-${hojeISO()}.json`, JSON.stringify(dados, null, 2), 'application/json');
    renderConfig(); toast('Backup baixado');
  };
  document.getElementById('btnImportar').onclick = () => document.getElementById('arqImport').click();
  document.getElementById('arqImport').addEventListener('change', e => {
    const arq = e.target.files[0];
    if (!arq) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d.meses || !d.fixas) throw new Error();
        if (!podeEditar) return;
        if (!confirm('Restaurar este backup? Os dados atuais do Portal serão substituídos para toda a equipe.')) return;
        dados = atualizarDados(d); salvar(); render(); toast('Backup restaurado');
      } catch (err) { alert('Arquivo de backup inválido.'); }
      finally { e.target.value = ''; }
    };
    r.readAsText(arq);
  });

  // ---------- PWA: instalação e funcionamento offline ----------
  const statusApp = document.getElementById('statusApp');
  const instalado = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (instalado) statusApp.textContent = 'Você está usando o app instalado.';
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // quando sai uma versão nova, ela assume o controle e a página recarrega uma vez
    const tinhaControle = !!navigator.serviceWorker.controller;
    let recarregou = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (tinhaControle && !recarregou) { recarregou = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => {
        reg.update();
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
      })
      .catch(() => {});
  }
  let pedidoInstalacao = null;
  const btnInstalar = document.getElementById('btnInstalar');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    pedidoInstalacao = e;
    btnInstalar.style.display = 'inline-block';
  });
  btnInstalar.onclick = async () => {
    if (!pedidoInstalacao) return;
    pedidoInstalacao.prompt();
    await pedidoInstalacao.userChoice;
    pedidoInstalacao = null;
    btnInstalar.style.display = 'none';
  };
  window.addEventListener('appinstalled', () => { btnInstalar.style.display = 'none'; toast('App instalado!'); });

  // ---------- login ----------
  const TELAS = ['telaCarregando', 'telaLogin', 'telaSenha'];
  function mostrarTela(nome) {
    TELAS.forEach(t => { document.getElementById(t).hidden = t !== nome; });
    document.body.classList.toggle('tela-app', nome === 'app');
    if (nome === 'telaLogin') setTimeout(() => document.getElementById('lUsuario').focus(), 50);
    if (nome === 'telaSenha') setTimeout(() => document.getElementById('sNova').focus(), 50);
  }
  const senhaOk = s => s.length >= 8 && /[a-zA-Z]/.test(s) && /\d/.test(s);

  async function entrar(user) {
    const { data: p, error } = await sb.from('perfis').select('*').eq('id', user.id).maybeSingle();
    if (error) { mostrarTela('telaLogin'); document.getElementById('erroLogin').textContent = 'Sem conexão com o servidor. Verifique a internet e tente de novo.'; return; }
    if (!p || !p.ativo) {
      await sb.auth.signOut();
      mostrarTela('telaLogin');
      document.getElementById('erroLogin').textContent = 'Seu acesso não está liberado. Fale com o administrador.';
      return;
    }
    perfil = p;
    if (p.trocar_senha) { mostrarTela('telaSenha'); return; }

    const equipe = p.papel === 'super_master' || p.equipe_slz;
    ehEquipe = equipe;
    // o dev só consulta os documentos (pela Visão geral); quem envia são síndicas e equipe
    podeEnviarDocs = p.papel === 'master';
    podeConferir = equipe && p.papel !== 'padrao';
    document.body.classList.toggle('externo', !equipe);
    const iniciais = p.nome.split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join('').toUpperCase();
    document.getElementById('quemSou').innerHTML = `<span class="avatar" aria-hidden="true">${esc(iniciais)}</span><span class="quem"><strong>${esc(p.nome)}</strong><small>${NOMES_PAPEL[p.papel]}</small></span>`;
    document.getElementById('quemSou').title = p.nome + ' · ' + NOMES_PAPEL[p.papel];
    await carregarCondos();
    if (!equipe) {
      // síndicas e usuários de condomínio: só a aba Documentos, do(s) condomínio(s) dela(s)
      podeEditar = false;
      document.getElementById('subTitulo').textContent = condosDocs.length === 1 ? condosDocs[0].nome : 'Documentos do condomínio';
      document.querySelector('.lateral .rodape').innerHTML = `<strong>${esc(condosDocs.map(c => c.nome).join(' · ') || 'Seu condomínio')}</strong>Dúvidas? Fale com o escritório da SLZ.`;
      mostrarTela('app');
      irParaAba('documentos');
      render();
      return;
    }

    podeEditar = p.papel === 'super_master' || p.papel === 'master';
    document.getElementById('abaUsuarios').hidden = p.papel !== 'super_master';
    try {
      const temNoServidor = await carregarDoServidor();
      const local = carregarLocal();
      if (!temNoServidor && podeEditar && local && Object.keys(local.meses).length &&
          confirm('Encontrei lançamentos salvos neste aparelho (da versão anterior do sistema).\n\nEnviar esses dados para o Portal SLZ, para toda a equipe ver?')) {
        dados = local;
      }
    } catch (e) {
      // sem internet: mostra a última cópia deste aparelho, só para consulta
      const local = carregarLocal();
      if (local) dados = local;
      podeEditar = false;
      toast('Sem conexão: mostrando a última cópia deste aparelho, só para consulta.');
    }
    mostrarTela('app');
    document.getElementById('abaGeral').hidden = p.papel !== 'super_master';
    if (p.papel === 'super_master') { nomesDev(); aplicarArea(areaDaAba(document.body.dataset.aba)); }
    try {
      const a = sessionStorage.getItem('slz-aba');
      if ((a === 'usuarios' || a === 'geral') && p.papel !== 'super_master') irParaAba('painel');
      // o dev entra direto na visão geral
      if (!a && p.papel === 'super_master') irParaAba('geral');
    } catch (e) {}
    render();
    if (!pendente() && podeEditar) statusSync('salvo');
    if (p.papel === 'super_master') {
      carregarUsuarios();
      prepararAvisos();
      const pa = new URLSearchParams(location.search);
      if (pa.get('doc')) {
        history.replaceState(null, '', location.pathname);
        abrirDocDoAviso({ documento_id: pa.get('doc'), condominio_id: pa.get('condo'), competencia: pa.get('mes') });
      }
    }
    contarAguardando();
  }

  document.getElementById('formLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const erro = document.getElementById('erroLogin');
    const usuario = document.getElementById('lUsuario').value.trim().toLowerCase();
    const senha = document.getElementById('lSenha').value;
    erro.textContent = '';
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Entrando…';
    const { data, error } = await sb.auth.signInWithPassword({ email: usuario + '@' + DOMINIO_LOGIN, password: senha });
    btn.disabled = false; btn.textContent = 'Entrar';
    if (error) {
      erro.textContent = /banned/i.test(error.message) ? 'Usuário bloqueado. Fale com o administrador.'
        : error.status === 429 || /rate limit|too many/i.test(error.message) ? 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.'
        : /fetch|network/i.test(error.message) ? 'Sem conexão com o servidor. Verifique a internet.'
        : 'Usuário ou senha incorretos.';
      return;
    }
    document.getElementById('lSenha').value = '';
    await entrar(data.user);
  });

  document.getElementById('formSenha').addEventListener('submit', async e => {
    e.preventDefault();
    const erro = document.getElementById('erroSenha');
    const nova = document.getElementById('sNova').value, conf = document.getElementById('sConfirma').value;
    erro.textContent = '';
    if (!senhaOk(nova)) { erro.textContent = 'A senha precisa de pelo menos 8 caracteres, com letras e números.'; return; }
    if (nova !== conf) { erro.textContent = 'As duas senhas não são iguais.'; return; }
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: nova });
    if (error) {
      btn.disabled = false;
      erro.textContent = /different|same/i.test(error.message) ? 'A nova senha precisa ser diferente da temporária.' : 'Não foi possível trocar a senha: ' + error.message;
      return;
    }
    await sb.rpc('senha_trocada');
    btn.disabled = false;
    e.target.reset();
    const { data: { user } } = await sb.auth.getUser();
    toast('Senha criada com sucesso!');
    await entrar(user);
  });

  async function sair() {
    if (pendente() && !confirm('Ainda há alterações sendo salvas. Sair mesmo assim?')) return;
    if (btnAvisos.classList.contains('ligado')) {
      try { const sub = await inscricaoAtual(); if (sub) await sb.rpc('remover_push', { p_endpoint: sub.endpoint }); } catch (e) {}
    }
    await sb.auth.signOut();
    // não deixa dados do escritório no aparelho depois de sair
    try { localStorage.removeItem(CHAVE); sessionStorage.clear(); } catch (e) {}
    location.reload();
  }
  document.getElementById('btnSair').onclick = sair;

  // ---------- avisos no celular (Web Push): os devs recebem quando uma síndica envia documento ----------
  const VAPID_PUBLICA = 'BIWXnHIgPj50Pazqya2963gob2urX24xhsKbKdPxJggxRdPf233UtRJijO3D8mCkJG6vUA9_ipYKPLOgkiaqR80';
  const btnAvisos = document.getElementById('btnAvisos');
  const temPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const chaveBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function inscricaoAtual() {
    if (!temPush()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  function nomeAparelho() {
    const u = navigator.userAgent;
    return (/iPhone|iPad/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : 'Aparelho') +
      (/Edg\//.test(u) ? ' · Edge' : /Chrome\//.test(u) ? ' · Chrome' : /Firefox\//.test(u) ? ' · Firefox' : /Safari\//.test(u) ? ' · Safari' : '');
  }
  async function registrarNoServidor(sub) {
    const j = sub.toJSON();
    const { error } = await sb.rpc('registrar_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_aparelho: nomeAparelho() });
    if (error) throw error;
  }
  function sino(ligado) {
    btnAvisos.classList.toggle('ligado', ligado);
    btnAvisos.setAttribute('aria-pressed', ligado);
    btnAvisos.title = ligado ? 'Avisos ligados neste aparelho (toque para desligar)' : 'Ativar avisos de documentos novos';
  }
  // no login do dev: mostra o sino e, se este aparelho já tinha ligado os avisos, liga de novo para quem entrou
  async function prepararAvisos() {
    btnAvisos.hidden = false;
    try {
      const sub = temPush() && Notification.permission === 'granted' ? await inscricaoAtual() : null;
      if (sub) await registrarNoServidor(sub);
      sino(!!sub);
    } catch (e) { sino(false); }
  }
  btnAvisos.addEventListener('click', async () => {
    if (!temPush()) {
      alert(/iPhone|iPad/.test(navigator.userAgent)
        ? 'No iPhone, os avisos só funcionam com o Portal instalado na tela inicial.\n\nNo Safari, toque em Compartilhar → "Adicionar à Tela de Início", abra o Portal pelo ícone e toque no sino de novo.'
        : 'Este navegador não recebe avisos. Use o Chrome ou o Edge.');
      return;
    }
    const sub = await inscricaoAtual().catch(() => null);
    if (sub && btnAvisos.classList.contains('ligado')) {
      if (!confirm('Desligar os avisos de documentos novos neste aparelho?')) return;
      await sb.rpc('remover_push', { p_endpoint: sub.endpoint });
      await sub.unsubscribe().catch(() => {});
      sino(false);
      toast('Avisos desligados neste aparelho.');
      return;
    }
    if (Notification.permission === 'denied') {
      alert('As notificações do Portal estão bloqueadas neste navegador.\n\nPara liberar: toque no cadeado ao lado do endereço do site → Notificações → Permitir. Depois toque no sino de novo.');
      return;
    }
    if (await Notification.requestPermission() !== 'granted') { toast('Sem a permissão, os avisos não podem ser ligados.'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const nova = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(VAPID_PUBLICA) });
      await registrarNoServidor(nova);
      sino(true);
      toast('Pronto! Você vai receber um aviso a cada documento enviado pelas síndicas.');
    } catch (e) { sino(false); toast(mensagemUsuario(e, 'Não foi possível ativar os avisos neste aparelho.')); }
  });
  // tocar no aviso abre o documento, no mês e no condomínio dele
  function abrirDocDoAviso(a) {
    if (!a || !a.documento_id || !a.condominio_id || !ehDev()) return;
    if (/^\d{4}-\d{2}$/.test(a.competencia || '') && a.competencia >= MES_INICIAL) mesSel = a.competencia;
    rotularMes();
    focoDoc = a.documento_id;
    document.getElementById('fdStatus').value = '';
    abrirCondominio(a.condominio_id);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.tipo === 'abrir-doc') abrirDocDoAviso(e.data);
  });

  window.addEventListener('beforeunload', e => { if (pendente()) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => { if (pendente()) enviar(); });
  document.addEventListener('visibilitychange', verificarAtualizacao);
  setInterval(verificarAtualizacao, 30000);

  // ---------- usuários e condomínios (só Super Master) ----------
  let adminDados = { usuarios: [], condominios: [] };
  async function carregarHistoricoAdmin() {
    if (!ehDev()) return;
    const backupsEl = document.getElementById('listaBackupsAdmin');
    const auditoriaEl = document.getElementById('listaAuditoriaAdmin');
    const [{ data: backups, error: eBackups }, { data: eventos, error: eEventos }] = await Promise.all([
      sb.from('escritorio_backups').select('id, criado_em, versao, criado_por').order('id', { ascending: false }).limit(20),
      sb.from('auditoria').select('id, ocorrido_em, ator, tabela, acao, entidade_id').order('id', { ascending: false }).limit(30)
    ]);
    if (eBackups) backupsEl.textContent = 'Não foi possível carregar as versões. Aplique as migrações recentes do banco.';
    else backupsEl.innerHTML = backups && backups.length ? backups.map(b => `<div class="linha" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--borda)">
      <span style="flex:1">Versão ${b.versao} · ${new Date(b.criado_em).toLocaleString('pt-BR')}</span>
      <button class="btn sec peq" data-restaurar-snapshot="${b.id}">Restaurar</button></div>`).join('') : '<p class="miudo">Ainda não há versões anteriores. Elas são criadas automaticamente quando os dados são alterados.</p>';
    if (eEventos) auditoriaEl.textContent = 'Não foi possível carregar a auditoria. Aplique as migrações recentes do banco.';
    else auditoriaEl.innerHTML = eventos && eventos.length ? eventos.map(a => {
      const nomes = { documentos: 'documento', escritorio_estado: 'dados do escritório', perfis: 'usuário', condominios: 'condomínio', extratos: 'extrato' };
      const acao = { INSERT: 'criado', UPDATE: 'alterado', DELETE: 'excluído' }[a.acao] || 'atualizado';
      const id = a.entidade_id ? ' · ' + esc(a.entidade_id.slice(0, 8)) : '';
      return `<div style="padding:7px 0;border-bottom:1px solid var(--borda)">${new Date(a.ocorrido_em).toLocaleString('pt-BR')} · ${esc(nomes[a.tabela] || a.tabela)} ${acao}${id}${a.ator ? ' · usuário ' + esc(a.ator.slice(0, 8)) : ' · sistema'}</div>`;
    }).join('') : '<p class="miudo">Nenhuma atividade registrada ainda.</p>';
  }
  document.getElementById('btnHistoricoAtualizar').addEventListener('click', e => executarBotao(e.currentTarget, 'Atualizando…', carregarHistoricoAdmin, 'Não foi possível atualizar o histórico.'));
  document.getElementById('listaBackupsAdmin').addEventListener('click', async e => {
    const botao = e.target.closest('[data-restaurar-snapshot]');
    if (!botao || !confirm('Restaurar esta versão? Os dados atuais serão substituídos; uma cópia deles será guardada antes da restauração.')) return;
    await executarBotao(botao, 'Restaurando…', async () => {
      const { data: snapshot, error } = await sb.from('escritorio_backups').select('dados').eq('id', botao.dataset.restaurarSnapshot).single();
      if (error) throw error;
      const { data: novaVersao, error: erroSalvar } = await sb.rpc('salvar_escritorio', { novos_dados: snapshot.dados, versao_esperada: versaoServidor });
      if (erroSalvar) throw erroSalvar;
      dados = atualizarDados(snapshot.dados); versaoServidor = novaVersao; ultimoEnviado = JSON.stringify(snapshot.dados);
      render(); toast('Versão restaurada; a cópia anterior ficou preservada.'); carregarHistoricoAdmin();
    }, 'Não foi possível restaurar esta versão. Atualize os dados e tente novamente.');
  });
  async function adminApi(corpo) {
    const { data, error } = await sb.functions.invoke('admin-usuarios', { body: corpo });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.erro || msg; } catch (e) {}
      throw new Error(msg);
    }
    return data;
  }
  function gerarSenha() {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', nums = '23456789';
    const n = new Uint32Array(10); crypto.getRandomValues(n);
    const base = [...n].slice(0, 8).map(x => letras[x % letras.length]).join('');
    return base + nums[n[8] % nums.length] + nums[n[9] % nums.length];
  }
  async function carregarUsuarios() {
    try { adminDados = await adminApi({ acao: 'listar' }); renderUsuarios(); if (document.getElementById('aba-geral').classList.contains('ativa')) { renderGeralUsuarios(); if (ultimoGeral) renderGeralCondos(...ultimoGeral); } }
    catch (e) { document.getElementById('tabUsuarios').innerHTML = `<tr><td colspan="7" class="vazio">${esc(mensagemUsuario(e, 'Não foi possível carregar os usuários. Tente atualizar a lista.'))}</td></tr>`; }
  }
  function renderUsuarios() {
    const condos = adminDados.condominios;
    const ativos = condos.filter(c => c.ativo);
    const nomeCondo = id => (condos.find(c => c.id === id) || { nome: '?' }).nome;
    const chkCondos = (attr, sel) => ativos.length
      ? ativos.map(c => `<label class="check"><input type="checkbox" ${attr} value="${c.id}" ${sel.includes(c.id) ? 'checked' : ''}> ${esc(c.nome)}</label>`).join('')
      : '<span class="miudo">Cadastre os condomínios no card ao lado.</span>';

    document.getElementById('tabUsuarios').innerHTML = adminDados.usuarios.map(u => {
      const eu = u.id === perfil.id;
      return `<tr data-uid="${u.id}">
        <td class="titulo-linha"><input class="inline" data-u="nome" value="${esc(u.nome)}" aria-label="Nome"></td>
        <td data-label="Usuário"><code>${esc(u.usuario)}</code></td>
        <td data-label="Nível"><select class="inline" data-u="papel" ${eu ? 'disabled' : ''}>${Object.entries(NOMES_PAPEL).map(([k, v]) => `<option value="${k}" ${k === u.papel ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td data-label="Equipe SLZ"><input type="checkbox" data-u="equipe" ${u.equipe_slz ? 'checked' : ''} ${u.papel === 'super_master' ? 'disabled' : ''} aria-label="Equipe SLZ"></td>
        <td data-label="Condomínios"><details><summary>${u.condominios.length ? esc(u.condominios.map(nomeCondo).join(', ')) : 'nenhum'}</summary><div class="condos">${chkCondos('data-u-condo', u.condominios)}</div></details></td>
        <td data-label="Situação">${u.ativo ? '<span class="tag ativo">Ativo</span>' : '<span class="tag bloq">Bloqueado</span>'}${u.trocar_senha ? ' <span class="tag trocar">1º acesso</span>' : ''}</td>
        <td class="num"><div class="acoes" style="justify-content:flex-end">
          <button class="btn sec peq" data-u-acao="senha">Redefinir senha</button>
          ${eu ? '' : `<button class="btn sec peq" data-u-acao="${u.ativo ? 'bloquear' : 'desbloquear'}">${u.ativo ? 'Bloquear' : 'Desbloquear'}</button>
          <button class="btn perigo peq" data-u-acao="excluir">Excluir</button>`}
        </div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="vazio">Nenhum usuário.</td></tr>';

    document.getElementById('nuCondos').innerHTML = chkCondos('data-nu-condo', []);
    document.getElementById('listaCondos').innerHTML = condos.length ? condos.map(c => `<div class="linha">
        <input data-condo-nome="${c.id}" value="${esc(c.nome)}" aria-label="Nome do condomínio">
        ${c.id_superlogica ? `<span class="tag sl" title="Ligado ao Superlógica">SL ${c.id_superlogica}</span>` : ''}
        <button class="btn ${c.ativo ? 'perigo' : 'sec'} peq" data-condo-ativo="${c.id}">${c.ativo ? 'Desativar' : 'Reativar'}</button>
      </div>`).join('') : '<p class="miudo">Nenhum condomínio cadastrado.</p>';
  }
  async function acaoAdmin(corpo, msgOk) {
    try { await adminApi(corpo); toast(msgOk); }
    catch (e) { toast(mensagemUsuario(e, 'Não foi possível salvar esta alteração.')); }
    await carregarUsuarios();
  }
  const tabU = document.getElementById('tabUsuarios');
  tabU.addEventListener('change', e => {
    const tr = e.target.closest('tr[data-uid]'); if (!tr) return;
    const id = tr.dataset.uid, campo = e.target.dataset.u;
    if (campo === 'nome') acaoAdmin({ acao: 'atualizar', id, nome: e.target.value }, 'Nome atualizado');
    else if (campo === 'papel') acaoAdmin({ acao: 'atualizar', id, papel: e.target.value, equipe_slz: tr.querySelector('[data-u="equipe"]').checked }, 'Nível atualizado');
    else if (campo === 'equipe') acaoAdmin({ acao: 'atualizar', id, equipe_slz: e.target.checked }, 'Equipe atualizada');
    else if (e.target.hasAttribute('data-u-condo')) {
      const condominios = [...tr.querySelectorAll('[data-u-condo]:checked')].map(x => x.value);
      acaoAdmin({ acao: 'atualizar', id, condominios }, 'Condomínios atualizados');
    }
  });
  tabU.addEventListener('click', async e => {
    const acao = e.target.dataset.uAcao; if (!acao) return;
    const tr = e.target.closest('tr[data-uid]'), id = tr.dataset.uid;
    const u = adminDados.usuarios.find(x => x.id === id);
    if (acao === 'senha') {
      const senha = prompt(`Nova senha temporária para ${u.nome} (${u.usuario}).\nCopie e passe para a pessoa — no próximo acesso ela cria a própria senha:`, gerarSenha());
      if (senha === null) return;
      if (!senhaOk(senha)) { alert('A senha precisa de pelo menos 8 caracteres, com letras e números.'); return; }
      acaoAdmin({ acao: 'redefinir_senha', id, senha }, 'Senha redefinida');
    } else if (acao === 'bloquear' || acao === 'desbloquear') {
      if (acao === 'bloquear' && !confirm(`Bloquear ${u.nome}? A pessoa não consegue mais entrar até ser desbloqueada.`)) return;
      acaoAdmin({ acao: 'atualizar', id, ativo: acao === 'desbloquear' }, acao === 'bloquear' ? 'Usuário bloqueado' : 'Usuário desbloqueado');
    } else if (acao === 'excluir') {
      if (!confirm(`Excluir o usuário ${u.nome} (${u.usuario}) de vez?\nSe for só para impedir o acesso, prefira "Bloquear".`)) return;
      acaoAdmin({ acao: 'excluir', id }, 'Usuário excluído');
    }
  });
  document.getElementById('btnRecarregarUsuarios').onclick = e => executarBotao(e.currentTarget, 'Atualizando…', carregarUsuarios, 'Não foi possível atualizar a lista de usuários.');
  document.getElementById('btnGerarSenha').onclick = () => { document.getElementById('nuSenha').value = gerarSenha(); };
  document.getElementById('nuPapel').addEventListener('change', e => {
    const eq = document.getElementById('nuEquipe');
    if (e.target.value === 'super_master') eq.checked = true;
    eq.disabled = e.target.value === 'super_master';
  });
  document.getElementById('formNovoUsuario').addEventListener('submit', async e => {
    e.preventDefault();
    const corpo = {
      acao: 'criar',
      nome: document.getElementById('nuNome').value.trim(),
      usuario: document.getElementById('nuUsuario').value.trim().toLowerCase(),
      senha: document.getElementById('nuSenha').value.trim(),
      papel: document.getElementById('nuPapel').value,
      equipe_slz: document.getElementById('nuEquipe').checked,
      condominios: [...document.querySelectorAll('[data-nu-condo]:checked')].map(x => x.value)
    };
    if (!senhaOk(corpo.senha)) { alert('A senha temporária precisa de pelo menos 8 caracteres, com letras e números.'); return; }
    if (!corpo.equipe_slz && !corpo.condominios.length && !confirm('Este usuário não é da equipe e não tem condomínio: ele não vai ver nada. Cadastrar mesmo assim?')) return;
    try {
      await adminApi(corpo);
      alert(`Usuário cadastrado!\n\nPasse para ${corpo.nome}:\nEndereço: ${location.origin}\nUsuário: ${corpo.usuario}\nSenha temporária: ${corpo.senha}`);
      e.target.reset();
      document.getElementById('nuEquipe').disabled = false;
      document.getElementById('nuSenha').value = gerarSenha();
    } catch (err) { toast(mensagemUsuario(err, 'Não foi possível concluir a ação de administração.')); }
    await carregarUsuarios();
  });
  document.getElementById('nuSenha').value = gerarSenha();

  const listaCondos = document.getElementById('listaCondos');
  listaCondos.addEventListener('change', async e => {
    const id = e.target.dataset.condoNome; if (!id) return;
    const nome = e.target.value.trim();
    if (!nome) { renderUsuarios(); return; }
    const { error } = await sb.from('condominios').update({ nome }).eq('id', id);
    if (error) toast(mensagemUsuario(error, 'Não foi possível renomear o condomínio.')); else toast('Condomínio renomeado');
    carregarUsuarios();
  });
  listaCondos.addEventListener('click', async e => {
    const id = e.target.dataset.condoAtivo; if (!id) return;
    const c = adminDados.condominios.find(x => x.id === id);
    const { error } = await sb.from('condominios').update({ ativo: !c.ativo }).eq('id', id);
    if (error) toast(mensagemUsuario(error, 'Não foi possível alterar a situação do condomínio.')); else toast(c.ativo ? 'Condomínio desativado' : 'Condomínio reativado');
    carregarUsuarios();
  });
  document.getElementById('formNovoCondo').addEventListener('submit', async e => {
    e.preventDefault();
    const nome = document.getElementById('ncondNome').value.trim();
    if (!nome) return;
    const { error } = await sb.from('condominios').insert({ nome });
    if (error) { toast(/duplicate|unique/i.test(error.message) ? 'Esse condomínio já existe.' : mensagemUsuario(error, 'Não foi possível cadastrar o condomínio.')); return; }
    e.target.reset(); toast('Condomínio adicionado');
    carregarUsuarios();
  });

  // ---------- documentos: notas fiscais e comprovantes (arquivos no Cloudflare R2) ----------
  const TIPOS_DOC = { nota_fiscal: 'Nota fiscal', comprovante: 'Comprovante', recibo: 'Recibo', boleto: 'Boleto', outro: 'Outro' };
  const SITUACAO = { enviado: ['pendente', 'Aguardando conferência'], pendencia: ['atrasada', 'Pendência'], conferido: ['paga', 'Conferido'] };
  const MIME_POR_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  const TAMANHO_MAX = 25 * 1024 * 1024;
  let docsCarregados = [];

  async function docsApi(corpo) {
    const { data, error } = await sb.functions.invoke('documentos-arquivos', { body: corpo });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.erro || msg; } catch (e) {}
      throw new Error(msg);
    }
    return data;
  }
  // alguns celulares/Windows não informam o tipo do arquivo (ex.: .heic): usa a extensão
  function tipoArquivo(f) {
    if (Object.values(MIME_POR_EXT).includes(f.type)) return f.type;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return !f.type || f.type === 'application/octet-stream' ? MIME_POR_EXT[ext] || null : null;
  }
  const extDe = mime => Object.keys(MIME_POR_EXT).find(k => MIME_POR_EXT[k] === mime && k !== 'jpeg') || 'bin';
  const fmtTamanho = b => b >= 1048576 ? (b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  async function hashSha256(blob) {
    const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function validarArquivos(files) {
    if (!files.length) return 'Escolha pelo menos um arquivo.';
    if (files.length > 10) return 'Envie no máximo 10 arquivos por documento.';
    for (const f of files) {
      if (!tipoArquivo(f)) return `"${f.name}" não é PDF nem foto. Envie PDF, JPG, PNG, WEBP ou HEIC.`;
      if (f.size > TAMANHO_MAX) return `"${f.name}" tem ${fmtTamanho(f.size)}. O limite é 25 MB por arquivo.`;
    }
    return '';
  }
  // upload com barra de progresso (fetch não mostra o progresso de envio)
  function putArquivo(url, file, tipo, aoProgredir) {
    return new Promise((ok, falha) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Type', tipo);
      x.upload.onprogress = e => { if (e.lengthComputable) aoProgredir(e.loaded / e.total); };
      x.onload = () => x.status >= 200 && x.status < 300 ? ok() : falha(new Error('O envio falhou (' + x.status + ').'));
      x.onerror = () => falha(new Error('Sem conexão durante o envio.'));
      x.send(file);
    });
  }
  async function enviarArquivos(docId, files) {
    const caixa = document.getElementById('progressoEnvio');
    caixa.innerHTML = files.map((f, i) => `<div class="item" id="prog${i}"><span>${esc(f.name)} · ${fmtTamanho(f.size)}</span><div class="barrinha"><i></i></div></div>`).join('');
    const falhas = [];
    for (const [i, f] of files.entries()) {
      const linha = document.getElementById('prog' + i), barra = linha.querySelector('i');
      try {
        const tipo = tipoArquivo(f);
        const sha256 = await hashSha256(f);
        const { arquivo_id, url } = await docsApi({ acao: 'upload_url', documento_id: docId, nome: f.name, tipo, tamanho: f.size, sha256 });
        await putArquivo(url, f, tipo, p => { barra.style.width = Math.round(p * 95) + '%'; });
        await docsApi({ acao: 'confirmar', arquivo_id });
        barra.style.width = '100%'; linha.classList.add('ok');
      } catch (e) {
        linha.classList.add('falha'); linha.querySelector('span').textContent = 'Falhou — ' + f.name + ': ' + mensagemUsuario(e, 'tente novamente.');
        falhas.push(f.name);
      }
    }
    return falhas;
  }

  async function carregarCondos() {
    const { data } = await sb.from('condominios').select('id, nome, id_superlogica').eq('ativo', true).order('nome');
    condosDocs = data || [];
    const opcoes = condosDocs.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
    document.getElementById('dCondo').innerHTML = opcoes;
    document.querySelector('#formDoc .f-condo').hidden = condosDocs.length < 2;
    const fd = document.getElementById('fdCondo');
    fd.innerHTML = (condosDocs.length > 1 ? '<option value="">Todos os condomínios</option>' : '') + opcoes;
    fd.hidden = condosDocs.length < 2;
  }

  async function contarAguardando() {
    if (!podeConferir) return;
    const { count } = await sb.from('documentos').select('id', { count: 'exact', head: true }).eq('status', 'enviado');
    document.getElementById('badgeDocs').innerHTML = count ? `<span class="badge" title="Aguardando conferência">${count}</span>` : '';
  }

  let formDocAberto = false;   // na área da síndica, o formulário só abre pelo botão "Enviar"
  let pendTodas = [];          // pendências da síndica em qualquer mês
  let focoDoc = null;          // documento para destacar depois de carregar a lista
  let histSind = [];           // documentos dos últimos 6 meses (só valores) para a visão geral da síndica
  const mesesHist = () => { const r = []; for (let i = 5; i >= 0; i--) { const k = somaMes(mesSel, -i); if (k >= MES_INICIAL) r.push(k); } return r; };
  async function carregarDocs() {
    const externo = document.body.classList.contains('externo');
    document.getElementById('cardEnviarDoc').hidden = !podeEnviarDocs || !condosDocs.length || (externo && !formDocAberto);
    const lista = document.getElementById('listaDocs');
    if (!condosDocs.length) {
      lista.innerHTML = `<p class="vazio">${ehEquipe ? 'Nenhum condomínio cadastrado ainda. O Super Master cadastra na aba Usuários.' : 'Seu usuário ainda não está ligado a nenhum condomínio. Fale com o escritório.'}</p>`;
      document.getElementById('btnZip').hidden = true;
      return;
    }
    if (ehDev() && document.body.dataset.modo === 'condominio') {
      const fd = document.getElementById('fdCondo');
      if (!fd.value) { try { fd.value = sessionStorage.getItem('slz-condo') || ''; } catch (e) {} }
      if (!fd.value && condosDocs.length) fd.value = condosDocs[0].id;
      fd.hidden = true;
      aplicarArea('condominio');
    }
    const todosMeses = ehEquipe && document.getElementById('fdTodosMeses').checked;
    const condo = document.getElementById('fdCondo').value || (condosDocs.length === 1 ? condosDocs[0].id : '');
    document.getElementById('tituloDocs').textContent = todosMeses ? 'Documentos de todos os meses' : 'Documentos de ' + nomeMes(mesSel);
    let q = sb.from('documentos')
      .select('*, documento_arquivos(id, nome_original, tipo_mime, tamanho, sha256, confirmado, criado_em), enviado:perfis!enviado_por(nome), conferido:perfis!conferido_por(nome)')
      .order('enviado_em', { ascending: false });
    if (!todosMeses) q = q.eq('competencia', mesSel);
    if (condo) q = q.eq('condominio_id', condo);
    // a situação é filtrada na tela (as abas mostram a contagem de cada uma)
    let qh = sb.from('documentos').select('competencia, valor, conta, fornecedor').in('competencia', mesesHist());
    if (condo) qh = qh.eq('condominio_id', condo);
    const [{ data, error }, pend, hist] = await Promise.all([q, externo
      ? sb.from('documentos').select('id, competencia, tipo, fornecedor, valor, comentario').eq('status', 'pendencia').order('enviado_em')
      : Promise.resolve({ data: [] }), externo ? qh : Promise.resolve({ data: [] })]);
    pendTodas = pend.data || [];
    histSind = hist.data || [];
    if (error) { lista.innerHTML = `<p class="vazio">${esc(mensagemUsuario(error, 'Não foi possível carregar os documentos. Atualize a lista ou tente novamente mais tarde.'))}</p>`; return; }
    docsCarregados = data;
    renderDocs();
    contarAguardando();
    if (ehDev() && document.body.dataset.modo === 'condominio') carregarConc(); else document.getElementById('cardConc').hidden = true;
  }

  const documentosNaBusca = () => {
    const busca = document.getElementById('fdBusca').value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return docsCarregados.filter(d => {
      if (!busca) return true;
      const nomeCondo = (condosDocs.find(c => c.id === d.condominio_id) || {}).nome || '';
      const texto = [d.fornecedor, d.descricao, d.conta, nomeCondo].join(' ').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return texto.includes(busca);
    });
  };
  const docsVisiveis = () => {
    const st = document.getElementById('fdStatus').value;
    const encontrados = documentosNaBusca();
    return st ? encontrados.filter(d => d.status === st) : encontrados;
  };
  function renderDocs() {
    const encontrados = documentosNaBusca();
    const docs = docsVisiveis();
    const st = document.getElementById('fdStatus').value;
    const conta = v => encontrados.filter(d => !v || d.status === v).length;
    document.getElementById('fdStatusTabs').innerHTML = [['', 'Todos'], ['enviado', 'Aguardando'], ['pendencia', 'Correção'], ['conferido', 'Conferidos']]
      .map(([v, t]) => `<button type="button" role="tab" data-status="${v}" class="${st === v ? 'sel' : ''}" aria-selected="${st === v}">${t}<span class="${conta(v) ? 'tem' : ''}">${conta(v)}</span></button>`).join('');
    const nomeCondo = id => (condosDocs.find(c => c.id === id) || { nome: '' }).nome;
    const variosCondos = new Set(docs.map(d => d.condominio_id)).size > 1;
    const total = docs.reduce((s, d) => s + (Number(d.valor) || 0), 0);
    document.getElementById('fdTotal').textContent = docs.length ? docs.length + ' documento' + (docs.length > 1 ? 's' : '') + ' · ' + brl(total) : '';
    const n = st => docs.filter(d => d.status === st).length;
    document.getElementById('resumoDocs').innerHTML = docs.length ? Object.entries(SITUACAO)
      .map(([k, [cls, txt]]) => n(k) ? `<span class="tag ${cls}">${txt}: ${n(k)}</span>` : '').join('') : '';
    document.getElementById('btnZip').hidden = !docs.some(d => d.documento_arquivos.some(a => a.confirmado));
    document.getElementById('btnZip').innerHTML = st || document.getElementById('fdBusca').value.trim() ? 'Baixar resultados (ZIP)' : 'Baixar tudo (ZIP)';
    const contas = [...new Set(docs.map(d => d.conta).filter(Boolean))];
    document.getElementById('dContas').innerHTML = contas.map(c => `<option value="${esc(c)}">`).join('');

    document.getElementById('listaDocs').innerHTML = docs.length ? docs.map(d => {
      const [cls, txt] = SITUACAO[d.status];
      const meu = d.enviado_por === perfil.id;
      const editavel = podeConferir || (podeEnviarDocs && d.status !== 'conferido');
      const arqs = d.documento_arquivos.filter(a => a.confirmado).sort((a, b) => a.criado_em.localeCompare(b.criado_em));
      const detalhes = [
        variosCondos || (ehEquipe && condosDocs.length > 1) ? '<strong>' + esc(nomeCondo(d.condominio_id)) + '</strong>' : '',
        d.conta ? esc(d.conta) : '',
        d.data_pagamento ? 'Pago em ' + fmtData(d.data_pagamento) : '',
        document.getElementById('fdTodosMeses').checked ? 'Ref. ' + nomeMesCurto(d.competencia) : '',
        'Enviado' + (d.enviado ? ' por ' + esc(d.enviado.nome) : meu ? ' por você' : '') + ' em ' + new Date(d.enviado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
        d.status === 'conferido' && d.conferido_em ? 'Conferido' + (d.conferido ? ' por ' + esc(d.conferido.nome) : '') + ' em ' + new Date(d.conferido_em).toLocaleDateString('pt-BR') : ''
      ].filter(Boolean).join(' · ');
      return `<div class="doc s-${d.status}" data-doc="${d.id}">
        <div class="doc-cab"><span class="tag ${cls}">${txt}</span><strong>${TIPOS_DOC[d.tipo]} · ${esc(d.fornecedor)}</strong><span class="doc-valor">${d.valor != null ? brl(Number(d.valor)) : ''}</span></div>
        <div class="miudo">${detalhes}</div>
        ${d.descricao ? `<div>${esc(d.descricao)}</div>` : ''}
        ${d.status === 'pendencia' && d.comentario ? `<div class="pendencia"><strong>Correção pedida pelo escritório:</strong> ${esc(d.comentario)}</div>` : ''}
        <div class="doc-arqs">${arqs.length ? arqs.map(a => `<div class="arq" data-arq="${a.id}">
            ${ic(a.tipo_mime === 'application/pdf' ? 'arquivo' : 'imagem')}<span class="nome" title="${esc(a.nome_original)}">${esc(a.nome_original)}</span><span class="miudo">${fmtTamanho(a.tamanho)}</span>
            <button class="btn sec" data-arq-acao="abrir">Abrir</button><button class="btn sec" data-arq-acao="baixar">Baixar</button>
            ${editavel ? '<button class="btn perigo" data-arq-acao="excluir" title="Remover arquivo" aria-label="Remover arquivo">' + ic('x') + '</button>' : ''}</div>`).join('')
          : '<span class="miudo">' + ic('alerta') + ' Nenhum arquivo enviado.</span>'}</div>
        <div class="acoes">
          ${podeConferir && d.status !== 'conferido' ? '<button class="btn peq" data-doc-acao="conferir">' + ic('check') + 'Conferido</button>' : ''}
          ${podeConferir && d.status !== 'pendencia' ? '<button class="btn sec peq" data-doc-acao="pendencia">Pedir correção</button>' : ''}
          ${podeConferir && d.status === 'conferido' ? '<button class="btn sec peq" data-doc-acao="reabrir">Voltar para conferência</button>' : ''}
          ${!podeConferir && podeEnviarDocs && d.status === 'pendencia' ? '<button class="btn peq" data-doc-acao="corrigido">Já corrigi — enviar de novo</button>' : ''}
          ${editavel ? `<label class="btn sec peq" style="cursor:pointer">+ Arquivo<input type="file" multiple accept="application/pdf,image/*" data-doc-mais hidden></label>` : ''}
          ${editavel ? '<button class="btn perigo peq" data-doc-acao="excluir">Excluir</button>' : ''}
        </div>
      </div>`;
    }).join('') : `<div class="vazio-doc">${ic('arquivo')}<strong>${docsCarregados.length ? 'Nenhum resultado encontrado' : `Nenhum documento ${st ? 'nessa situação' : 'enviado'}${document.getElementById('fdTodosMeses').checked ? '' : ' em ' + nomeMes(mesSel)}`}</strong>${docsCarregados.length ? '<span>Tente outro termo ou ajuste os filtros.</span>' : !st && podeEnviarDocs ? '<span>Quando uma nota ou comprovante for enviado, ele aparece aqui com a situação da conferência.</span>' : ''}</div>`;
    renderSindica();
    if (focoDoc) {
      const el = document.querySelector(`#listaDocs [data-doc="${focoDoc}"]`);
      focoDoc = null;
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('destaque'); void el.offsetWidth; el.classList.add('destaque'); }
    }
  }

  // ---------- área da síndica: boas-vindas, resumo do mês e correções pedidas ----------
  function renderSindica() {
    if (!document.body.classList.contains('externo')) return;
    document.getElementById('sindOla').textContent = 'Olá, ' + perfil.nome.split(/\s+/)[0] + '!';
    document.getElementById('sindCondo').textContent = condosDocs.map(c => c.nome).join(' · ') || 'Seu condomínio';
    const docs = docsCarregados, n = st => docs.filter(d => d.status === st).length;
    const ant = somaMes(mesSel, -1);
    const doMes = k => histSind.filter(d => d.competencia === k);
    const soma = l => l.reduce((s, d) => s + (Number(d.valor) || 0), 0);
    const total = soma(doMes(mesSel)), totAnt = soma(doMes(ant)), temAnt = doMes(ant).length > 0;
    document.getElementById('sindKpis').innerHTML =
      kpiCard('Gastos do mês', brl(total), variacaoTxt(total, totAnt, temAnt), 't-' + tendencia(total, totAnt, temAnt)) +
      kpiCard('Documentos enviados', docs.length, `<span class="neutro">${n('conferido')} conferido${n('conferido') === 1 ? '' : 's'} pelo escritório</span>`, docs.length && n('conferido') === docs.length ? 't-ok' : '') +
      kpiCard('Aguardando conferência', n('enviado'), '<span class="neutro">o escritório ainda vai conferir</span>', n('enviado') ? 't-alerta' : '') +
      kpiCard('Precisam de correção', pendTodas.length, `<span class="neutro">${pendTodas.length ? 'veja os detalhes abaixo' : 'nenhuma correção pedida'}</span>`, pendTodas.length ? 't-mais' : 't-ok');

    // gastos por conta: mês aberto × mês anterior (junta contas escritas igual, sem ligar para maiúsculas)
    const contas = new Map();
    for (const d of histSind) {
      if (d.competencia !== mesSel && d.competencia !== ant) continue;
      const k = (d.conta || '').trim().toLowerCase() || '~';
      if (!contas.has(k)) contas.set(k, { nome: (d.conta || '').trim() || 'Sem conta informada', a: 0, p: 0 });
      contas.get(k)[d.competencia === mesSel ? 'a' : 'p'] += Number(d.valor) || 0;
    }
    let lin = [...contas.values()].sort((x, y) => y.a - x.a || y.p - x.p);
    if (lin.length > 8) lin = lin.slice(0, 7).concat([lin.slice(7).reduce((o, c) => (o.a += c.a, o.p += c.p, o), { nome: 'Outras contas', a: 0, p: 0 })]);
    const max = Math.max(1, ...lin.map(c => Math.max(c.a, c.p)));
    const w = v => (v ? Math.max(v / max * 100, 1.5) : 0) + '%';
    document.getElementById('sindBarras').innerHTML = lin.length ? lin.map(c => {
      const t = tendencia(c.a, c.p, temAnt);
      return `<div class="barra-linha"><div title="${esc(c.nome)}">${esc(c.nome)}</div><div class="barra-par">
        <div class="b"><div class="trilho"><div class="barra" style="width:${w(c.p)}"></div></div><span>${temAnt ? brl(c.p) : '—'}</span></div>
        <div class="b atu"><div class="trilho"><div class="barra atu ${t}" style="width:${w(c.a)}"></div></div><span class="${t === 'mais' || t === 'menos' ? t : ''}">${brl(c.a)}</span></div>
      </div></div>`;
    }).join('') : '<p class="vazio">Nenhum gasto enviado neste mês nem no anterior.</p>';

    // maiores fornecedores do mês aberto
    const forn = new Map();
    for (const d of doMes(mesSel)) {
      const k = (d.fornecedor || '').trim().toLowerCase();
      if (!forn.has(k)) forn.set(k, { nome: (d.fornecedor || '').trim() || '—', v: 0, q: 0 });
      const f = forn.get(k); f.v += Number(d.valor) || 0; f.q++;
    }
    const fl = [...forn.values()].sort((x, y) => y.v - x.v).slice(0, 6);
    document.getElementById('sindForn').innerHTML = fl.length ? fl.map((f, i) => `<div class="forn-linha"><span class="pos">${i + 1}</span><span class="nome" title="${esc(f.nome)}">${esc(f.nome)}</span><span class="v">${brl(f.v)}<small>${f.q} documento${f.q > 1 ? 's' : ''}</small></span></div>`).join('')
      : `<p class="vazio">Nenhum documento enviado em ${nomeMes(mesSel)}.</p>`;

    // histórico: até 6 meses terminando no mês aberto
    const meses = mesesHist(), tots = meses.map(k => soma(doMes(k))), tem = meses.map(k => doMes(k).length > 0);
    const mx = Math.max(1, ...tots);
    document.getElementById('sindHist').innerHTML = meses.map((k, i) => {
      const t = i ? tendencia(tots[i], tots[i - 1], tem[i - 1]) : 'sem';
      return `<div class="coluna ${t} ${k === mesSel ? 'sel' : ''}" title="${nomeMes(k)}: ${brl(tots[i])}"><div class="v">${brlCurto(tots[i])}</div><div class="c" style="height:${tots[i] / mx * 82}%"></div></div>`;
    }).join('');
    document.getElementById('sindHistRot').innerHTML = meses.map(k => `<div class="${k === mesSel ? 'sel' : ''}">${nomeMesCurto(k)}</div>`).join('');
    document.getElementById('sindPend').hidden = !pendTodas.length;
    document.getElementById('sindPendLista').innerHTML = pendTodas.map(d => `<div class="pend-item">
        <div><strong>${TIPOS_DOC[d.tipo]} · ${esc(d.fornecedor)}</strong>${d.valor != null ? ' <span class="miudo">· ' + brl(Number(d.valor)) + '</span>' : ''} <span class="miudo">· ${nomeMes(d.competencia)}</span>
          ${d.comentario ? `<div class="msg">${esc(d.comentario)}</div>` : ''}</div>
        <button class="btn peq" type="button" data-corrigir="${d.id}" data-mes="${d.competencia}">Corrigir</button>
      </div>`).join('');
  }
  function abrirFormDoc(abrir) {
    formDocAberto = abrir;
    const card = document.getElementById('cardEnviarDoc');
    card.hidden = !abrir;
    if (abrir) { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => document.getElementById('dZona').focus(), 350); }
  }
  document.getElementById('sindEnviar').addEventListener('click', () => abrirFormDoc(true));
  document.getElementById('dFechar').addEventListener('click', () => { limparArquivos(); abrirFormDoc(false); });
  document.getElementById('sindPendLista').addEventListener('click', e => {
    const b = e.target.closest('[data-corrigir]'); if (!b) return;
    focoDoc = b.dataset.corrigir;
    document.getElementById('fdStatus').value = '';
    if (b.dataset.mes !== mesSel) { mesSel = b.dataset.mes; render(); } else renderDocs();
  });
  document.getElementById('fdStatusTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-status]'); if (!b) return;
    document.getElementById('fdStatus').value = b.dataset.status;
    renderDocs();
  });

  // ---------- arquivos escolhidos: arrastar e soltar, prévia e remover ----------
  let arquivosSel = [], urlsPrevia = [];
  const inputArq = document.getElementById('dArquivos');
  function sincronizarArquivos() {
    const dt = new DataTransfer();
    arquivosSel.forEach(f => dt.items.add(f));
    inputArq.files = dt.files;
    urlsPrevia.forEach(u => URL.revokeObjectURL(u)); urlsPrevia = [];
    document.getElementById('dPrevias').innerHTML = arquivosSel.map((f, i) => {
      let mini;
      if (/^image\/(jpeg|png|webp|gif)$/.test(f.type)) { const u = URL.createObjectURL(f); urlsPrevia.push(u); mini = `<img src="${u}" alt="">`; }
      else mini = ic(f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'arquivo' : 'imagem', 'g');
      return `<div class="previa"><div class="mini">${mini}</div><div class="info"><strong title="${esc(f.name)}">${esc(f.name)}</strong><span>${fmtTamanho(f.size)}</span></div>
        <button type="button" class="btn-x" data-remover="${i}" aria-label="Remover ${esc(f.name)}">${ic('x')}</button></div>`;
    }).join('');
    const zona = document.getElementById('dZona');
    zona.classList.toggle('tem', arquivosSel.length > 0);
    zona.querySelector('strong').textContent = arquivosSel.length ? `${arquivosSel.length} arquivo${arquivosSel.length > 1 ? 's' : ''} — clique para adicionar mais` : 'Arraste os arquivos aqui ou clique para escolher';
  }
  function adicionarArquivos(lista) {
    for (const f of lista) if (!arquivosSel.some(x => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) arquivosSel.push(f);
    sincronizarArquivos();
  }
  function limparArquivos() { arquivosSel = []; sincronizarArquivos(); }
  inputArq.addEventListener('change', () => adicionarArquivos([...inputArq.files]));
  document.getElementById('dPrevias').addEventListener('click', e => {
    const b = e.target.closest('[data-remover]'); if (!b) return;
    arquivosSel.splice(Number(b.dataset.remover), 1);
    sincronizarArquivos();
  });
  const zonaArq = document.getElementById('dZona');
  ['dragenter', 'dragover'].forEach(ev => zonaArq.addEventListener(ev, e => { e.preventDefault(); zonaArq.classList.add('arrastando'); }));
  ['dragleave', 'drop'].forEach(ev => zonaArq.addEventListener(ev, () => zonaArq.classList.remove('arrastando')));
  zonaArq.addEventListener('drop', e => { e.preventDefault(); adicionarArquivos([...e.dataTransfer.files]); });

  // tipo de documento em botões grandes (o select escondido guarda o valor)
  function selecionarTipo(t) {
    document.getElementById('dTipo').value = t;
    document.querySelectorAll('#dTipoSeg button').forEach(b => { const sel = b.dataset.tipo === t; b.classList.toggle('sel', sel); b.setAttribute('aria-checked', sel); });
  }
  document.getElementById('dTipoSeg').addEventListener('click', e => { const b = e.target.closest('[data-tipo]'); if (b) selecionarTipo(b.dataset.tipo); });

  document.getElementById('formDoc').addEventListener('submit', async e => {
    e.preventDefault();
    const files = [...document.getElementById('dArquivos').files];
    const msg = validarArquivos(files);
    if (msg) { alert(msg); return; }
    const valorTxt = document.getElementById('dValor').value.trim();
    const valor = valorTxt ? lerValor(valorTxt) : null;
    if (valorTxt && (isNaN(valor) || valor < 0)) { alert('Valor inválido.'); return; }
    const btn = e.target.querySelector('button[type="submit"]'); const rotuloBtn = btn.innerHTML; btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const { data: doc, error } = await sb.from('documentos').insert({
        condominio_id: document.getElementById('dCondo').value,
        competencia: mesSel,
        tipo: document.getElementById('dTipo').value,
        fornecedor: document.getElementById('dFornecedor').value.trim(),
        valor,
        data_pagamento: document.getElementById('dData').value || null,
        conta: document.getElementById('dConta').value.trim() || null,
        descricao: document.getElementById('dDesc').value.trim() || null,
        enviado_por: perfil.id
      }).select('id').single();
      if (error) throw new Error(error.message);
      const falhas = await enviarArquivos(doc.id, files);
      if (falhas.length) alert('O documento foi registrado, mas ' + falhas.length + ' arquivo(s) não foram enviados. Use "+ Arquivo" no documento para tentar de novo.');
      else {
        toast('Documento enviado para o escritório');
        e.target.reset(); limparArquivos(); selecionarTipo('nota_fiscal');
        setTimeout(() => { document.getElementById('progressoEnvio').innerHTML = ''; }, 2500);
        if (document.body.classList.contains('externo')) abrirFormDoc(false);
      }
    } catch (err) { toast(mensagemUsuario(err, 'Não foi possível enviar o documento. Confira os dados e tente novamente.')); }
    btn.disabled = false; btn.innerHTML = rotuloBtn;
    carregarDocs();
  });

  // ---------- Superlógica (só leitura) ----------
  // Por enquanto só traz os condomínios. A função do servidor também sabe ler as despesas pagas,
  // que vão servir para a conciliação bancária das notas enviadas.
  async function slApi(corpo) {
    const { data, error } = await sb.functions.invoke('superlogica', { body: corpo });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.erro || msg; } catch (e) {}
      throw new Error(msg);
    }
    return data;
  }

  document.getElementById('btnImportarSL').addEventListener('click', e => executarBotao(e.currentTarget, 'Importando…', async () => {
      const r = await slApi({ acao: 'importar_condominios' });
      toast(`Superlógica: ${r.total} condomínios — ${r.criados} novos, ${r.ligados} ligados aos que já existiam`);
      await carregarCondos();
      await carregarUsuarios();
    }, 'Não foi possível importar os condomínios. Confira a conexão com o Superlógica.'));

  const listaDocs = document.getElementById('listaDocs');
  // baixa o arquivo e confere a "impressão digital": prova que é idêntico ao que foi enviado
  async function baixarConferido(arq) {
    const { url } = await docsApi({ acao: 'download_url', arquivo_id: arq.id });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Não foi possível baixar o arquivo.');
    const blob = await resp.blob();
    const integro = (await hashSha256(blob)) === arq.sha256;
    return { blob, integro };
  }
  listaDocs.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const card = b.closest('[data-doc]'); if (!card) return;
    const doc = docsCarregados.find(d => d.id === card.dataset.doc);
    const arqId = b.closest('[data-arq]') && b.closest('[data-arq]').dataset.arq;
    const arq = arqId && doc.documento_arquivos.find(a => a.id === arqId);
    try {
      if (b.dataset.arqAcao === 'abrir') {
        const janela = window.open('', '_blank');
        const { url } = await docsApi({ acao: 'download_url', arquivo_id: arq.id, abrir: true });
        if (janela) janela.location = url; else location.href = url;
      } else if (b.dataset.arqAcao === 'baixar') {
        b.disabled = true;
        const { blob, integro } = await baixarConferido(arq);
        baixar(arq.nome_original, blob, arq.tipo_mime);
        toast(integro ? 'Arquivo íntegro — idêntico ao enviado' : 'Atenção: o arquivo baixado não confere com o enviado. Tente de novo.');
        b.disabled = false;
      } else if (b.dataset.arqAcao === 'excluir') {
        if (!confirm(`Remover o arquivo "${arq.nome_original}"?`)) return;
        await docsApi({ acao: 'excluir_arquivo', arquivo_id: arq.id }); toast('Arquivo removido'); carregarDocs();
      } else if (b.dataset.docAcao === 'excluir') {
        if (!confirm(`Excluir o documento "${TIPOS_DOC[doc.tipo]} · ${doc.fornecedor}" e todos os arquivos dele?`)) return;
        await docsApi({ acao: 'excluir_documento', documento_id: doc.id }); toast('Documento excluído'); carregarDocs();
      } else if (b.dataset.docAcao) {
        const mudancas = {
          conferir: { status: 'conferido', comentario: null },
          reabrir: { status: 'enviado' },
          corrigido: { descricao: doc.descricao }   // qualquer alteração da síndica devolve para "aguardando"
        }[b.dataset.docAcao];
        let alteracao = mudancas;
        if (b.dataset.docAcao === 'pendencia') {
          const comentario = prompt('O que precisa ser corrigido? A síndica vai ver esta mensagem.', doc.comentario || '');
          if (comentario === null) return;
          if (!comentario.trim()) { alert('Escreva o que precisa ser corrigido.'); return; }
          alteracao = { status: 'pendencia', comentario: comentario.trim() };
        }
        const { error } = await sb.from('documentos').update(alteracao).eq('id', doc.id);
        if (error) throw new Error(error.message);
        toast({ conferir: 'Documento conferido', pendencia: 'Correção pedida', reabrir: 'Voltou para conferência', corrigido: 'Enviado de novo para o escritório' }[b.dataset.docAcao]);
        carregarDocs();
      }
    } catch (err) { b.disabled = false; toast(mensagemUsuario(err, 'Não foi possível concluir esta ação.')); }
  });
  listaDocs.addEventListener('change', async e => {
    if (!e.target.hasAttribute('data-doc-mais')) return;
    const files = [...e.target.files];
    const id = e.target.closest('[data-doc]').dataset.doc;
    const msg = validarArquivos(files);
    if (msg) { alert(msg); return; }
    document.getElementById('cardEnviarDoc').hidden = false;
    const falhas = await enviarArquivos(id, files);
    toast(falhas.length ? 'Alguns arquivos não foram enviados' : 'Arquivo adicionado');
    carregarDocs();
  });
  ['fdCondo', 'fdStatus', 'fdTodosMeses'].forEach(id => document.getElementById(id).addEventListener('change', carregarDocs));
  document.getElementById('fdBusca').addEventListener('input', renderDocs);

  // ZIP com tudo o que está na lista, já organizado e com resumo, para a prestação de contas
  document.getElementById('btnZip').addEventListener('click', async e => {
    const btn = e.target;
    const docs = docsVisiveis().filter(d => d.documento_arquivos.some(a => a.confirmado));
    const nomeCondo = id => (condosDocs.find(c => c.id === id) || { nome: 'Condomínio' }).nome;
    const limpo = t => String(t).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
    const variosCondos = new Set(docs.map(d => d.condominio_id)).size > 1;
    const zip = new JSZip();
    const linhas = [['Nº', 'Condomínio', 'Mês', 'Tipo', 'Fornecedor', 'Conta', 'Valor', 'Data do pagamento', 'Situação', 'Arquivo', 'Íntegro', 'Enviado por', 'Enviado em']];
    let feitos = 0, problemas = 0;
    const totalArqs = docs.reduce((s, d) => s + d.documento_arquivos.filter(a => a.confirmado).length, 0);
    btn.disabled = true;
    try {
      for (const [i, d] of docs.entries()) {
        const pasta = variosCondos ? limpo(nomeCondo(d.condominio_id)) + '/' : '';
        const arqs = d.documento_arquivos.filter(a => a.confirmado).sort((a, b) => a.criado_em.localeCompare(b.criado_em));
        for (const [k, a] of arqs.entries()) {
          btn.textContent = `Baixando ${++feitos} de ${totalArqs}…`;
          const { blob, integro } = await baixarConferido(a);
          if (!integro) problemas++;
          const nome = `${String(i + 1).padStart(2, '0')} ${TIPOS_DOC[d.tipo]} - ${limpo(d.fornecedor)}${d.valor != null ? ' - R$ ' + fmtValorInput(Number(d.valor)) : ''}${arqs.length > 1 ? ' (' + (k + 1) + ')' : ''}.${extDe(a.tipo_mime)}`;
          zip.file(pasta + nome, blob);
          linhas.push([i + 1, nomeCondo(d.condominio_id), d.competencia, TIPOS_DOC[d.tipo], d.fornecedor, d.conta || '', d.valor != null ? fmtValorInput(Number(d.valor)) : '',
            d.data_pagamento ? fmtData(d.data_pagamento) : '', SITUACAO[d.status][1], pasta + nome, integro ? 'sim' : 'NÃO', d.enviado ? d.enviado.nome : '', new Date(d.enviado_em).toLocaleString('pt-BR')]);
        }
      }
      zip.file('Resumo dos documentos.csv', paraCsv(linhas));
      btn.textContent = 'Montando o ZIP…';
      const conteudo = await zip.generateAsync({ type: 'blob' });
      const titulo = (variosCondos ? 'Condomínios' : limpo(nomeCondo(docs[0].condominio_id))) + (document.getElementById('fdTodosMeses').checked ? ' - todos os meses' : ' - ' + mesSel);
      baixar(titulo + '.zip', conteudo, 'application/zip');
      toast(problemas ? `Atenção: ${problemas} arquivo(s) não conferem com o enviado` : `ZIP pronto: ${totalArqs} arquivo(s) conferidos`);
    } catch (err) { toast(mensagemUsuario(err, 'Não foi possível montar o ZIP. Tente novamente.')); }
    btn.disabled = false; renderDocs();
  });

  // ---------- dev: três áreas — Visão geral, Escritório e Condomínio ----------
  // No topo, o dev vê só "Visão geral" e "Acessos". Clicando no escritório ou num condomínio,
  // entra na interface daquela área (a mesma do Master do escritório) e volta pela "← Visão geral".
  function areaDaAba(aba) {
    return { geral: 'geral', usuarios: 'geral', painel: 'escritorio', contas: 'escritorio', despesas: 'escritorio', balancete: 'escritorio', config: 'escritorio', documentos: 'condominio' }[aba] || 'geral';
  }
  function ehDev() { return document.body.classList.contains('dev'); }
  function nomesDev() {
    document.body.classList.add('dev');
    const b = document.querySelector('nav.abas [data-aba="usuarios"]');
    b.replaceChildren(b.querySelector('svg'));
    b.insertAdjacentHTML('beforeend', '<span>Acessos</span>');
    document.getElementById('geralEscritorio').classList.add('clicavel');
  }
  function aplicarArea(area) {
    if (!ehDev()) return;
    document.body.dataset.modo = area;
    document.querySelectorAll('nav.abas button[data-aba]').forEach(b => { b.hidden = areaDaAba(b.dataset.aba) !== area; });
    document.getElementById('abaVoltar').hidden = area === 'geral';
    const nome = document.getElementById('contextoNome'), dica = document.getElementById('contextoDica');
    if (area === 'escritorio') { nome.textContent = 'ESCRITÓRIO SLZ'; dica.textContent = 'Controle de gastos do escritório'; }
    if (area === 'condominio') {
      const c = condosDocs.find(x => x.id === document.getElementById('fdCondo').value);
      nome.textContent = c ? c.nome : 'Condomínio';
      dica.textContent = 'Documentos e conciliação bancária';
    }
    const condoAtual = condosDocs.find(x => x.id === document.getElementById('fdCondo').value);
    document.getElementById('subTitulo').textContent = area === 'escritorio' ? 'Controle de gastos do escritório'
      : area === 'condominio' ? (condoAtual ? condoAtual.nome : 'Condomínio') : 'Escritório e condomínios';
  }

  // ---------- modo claro / escuro ----------
  const temaEscuro = () => (document.documentElement.dataset.tema || (matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro')) === 'escuro';
  function mostrarIconeTema() {
    document.querySelectorAll('[data-tema-alternar]').forEach(b => { b.innerHTML = ic(temaEscuro() ? 'sol' : 'lua'); b.title = temaEscuro() ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'; });
    document.querySelector('meta[name="theme-color"]').content = temaEscuro() ? '#0b0e17' : '#ffffff';
  }
  document.querySelectorAll('[data-tema-alternar]').forEach(b => b.addEventListener('click', () => {
    const novo = temaEscuro() ? 'claro' : 'escuro';
    document.documentElement.dataset.tema = novo;
    try { localStorage.setItem('portal-slz-tema', novo); } catch (e) {}
    mostrarIconeTema();
  }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', mostrarIconeTema);
  mostrarIconeTema();

  // ---------- conciliação bancária: extrato OFX × notas e comprovantes (só devs) ----------
  const FOLGA_DIAS = 5;   // mesma tolerância do projeto "slz automatização financeira"
  const normalTxt = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dataOfx = t => t && t.length >= 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
  const diasEntre = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

  // lê o OFX (SGML ou XML) do mesmo jeito que o extrato.py do projeto de automação
  function lerOfx(texto) {
    const campo = (bloco, tag) => { const m = bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i')); return m ? m[1].trim() : ''; };
    const lancamentos = [...texto.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)].map(m => ({
      data: dataOfx(campo(m[1], 'DTPOSTED')),
      valor: Math.round(parseFloat(campo(m[1], 'TRNAMT').replace(',', '.')) * 100) / 100,
      descricao: campo(m[1], 'MEMO') || campo(m[1], 'NAME'),
      tipo: campo(m[1], 'TRNTYPE'),
      id_banco: campo(m[1], 'FITID') || null
    })).filter(l => l.data && !isNaN(l.valor));
    return {
      banco: campo(texto, 'ORG') || campo(texto, 'BANKID'), agencia: campo(texto, 'BRANCHID'), conta: campo(texto, 'ACCTID'),
      inicio: dataOfx(campo(texto, 'DTSTART')), fim: dataOfx(campo(texto, 'DTEND')), lancamentos
    };
  }

  // extratos (com lançamentos) de um condomínio — ou de todos, se condo for null — no mês
  async function carregarExtratos(condo, mes) {
    if (!ehDev()) return [];
    let q = sb.from('extratos').select('*, extrato_lancamentos(id, data, valor, descricao, tipo, id_banco)').eq('competencia', mes).order('enviado_em');
    if (condo) q = q.eq('condominio_id', condo);
    const { data } = await q;
    return data || [];
  }

  // Compara as saídas do extrato com os documentos. Documentos do mesmo fornecedor e valor
  // (ex.: nota fiscal + comprovante enviados separados) contam como um só pagamento.
  function conciliar(extratos, docs) {
    const lancs = extratos.flatMap(e => e.extrato_lancamentos.map(l => ({ ...l, valor: Number(l.valor), extrato: e })));
    const saidas = lancs.filter(l => l.valor < 0), entradas = lancs.filter(l => l.valor > 0);
    const inicio = lancs.reduce((m, l) => !m || l.data < m ? l.data : m, null), fim = lancs.reduce((m, l) => !m || l.data > m ? l.data : m, null);
    // documentos com valor, do mês ou com pagamento dentro do período do extrato
    const grupos = {};
    docs.filter(d => d.valor != null && Number(d.valor) > 0).forEach(d => {
      const k = Number(d.valor).toFixed(2) + '|' + normalTxt(d.fornecedor);
      (grupos[k] ||= { valor: Number(d.valor), fornecedor: d.fornecedor, data: null, docs: [] }).docs.push(d);
      if (d.data_pagamento && (!grupos[k].data || d.data_pagamento < grupos[k].data)) grupos[k].data = d.data_pagamento;
    });
    const listaGrupos = Object.values(grupos);
    const candidatos = s => listaGrupos.filter(g => g.valor.toFixed(2) === Math.abs(s.valor).toFixed(2) && (!g.data || diasEntre(g.data, s.data) <= FOLGA_DIAS));
    const cands = new Map(saidas.map(sd => [sd, candidatos(sd)]));
    const disputa = new Map();
    cands.forEach(l => l.forEach(g => disputa.set(g, (disputa.get(g) || 0) + 1)));
    const conciliados = [], ambiguos = [], semComprovante = [], usados = new Set();
    cands.forEach((lista, sd) => {
      if (lista.length === 1 && disputa.get(lista[0]) === 1) { conciliados.push({ saida: sd, grupo: lista[0] }); usados.add(lista[0]); }
      else if (lista.length) ambiguos.push({ saida: sd, grupos: lista });
      else semComprovante.push(sd);
    });
    ambiguos.forEach(a => a.grupos.forEach(g => usados.add(g)));
    // comprovante sem pagamento: só os do mês (os de meses vizinhos podem ter sido pagos em outro extrato)
    const semPagamento = listaGrupos.filter(g => !usados.has(g) && g.docs.some(d => d.competencia === mesSel || (d.data_pagamento && inicio && d.data_pagamento >= inicio && d.data_pagamento <= fim)));
    return { saidas, entradas, conciliados, ambiguos, semComprovante, semPagamento };
  }
  const somaV = ls => ls.reduce((s, x) => s + Math.abs(x.valor), 0);

  function colunaConc(condo, extratos, docs) {
    const meus = extratos.filter(e => e.condominio_id === condo);
    if (!meus.length) return '<span class="miudo">Sem extrato no mês</span>';
    const r = conciliar(meus, docs.filter(d => d.condominio_id === condo));
    if (!r.saidas.length) return '<span class="miudo">Extrato sem saídas</span>';
    const pct = Math.round(r.conciliados.length / r.saidas.length * 100);
    return `<div class="progresso-conc ${pct < 50 ? 'baixo' : pct < 100 ? 'medio' : ''}"><div class="trilho"><div class="barra" style="width:${pct}%"></div></div><strong>${pct}%</strong></div>
      <div class="miudo">${r.conciliados.length} de ${r.saidas.length} saídas com comprovante${r.semPagamento.length ? ` · ${r.semPagamento.length} nota(s) sem pagamento` : ''}</div>`;
  }

  async function carregarConc() {
    const card = document.getElementById('cardConc');
    const condo = document.getElementById('fdCondo').value;
    if (!ehDev() || !condo || document.getElementById('fdTodosMeses').checked) { card.hidden = true; return; }
    card.hidden = false;
    const [extratos, { data: docs }] = await Promise.all([
      carregarExtratos(condo, mesSel),
      sb.from('documentos').select('id, tipo, fornecedor, valor, data_pagamento, status, competencia').eq('condominio_id', condo).in('competencia', [somaMes(mesSel, -1), mesSel, somaMes(mesSel, 1)])
    ]);
    renderConc(extratos, docs || [], null);
    if (!extratos.length) return;
    // o que cada saída é no Superlógica, no período do extrato (só leitura)
    const datas = extratos.flatMap(e => e.extrato_lancamentos.map(l => l.data)).sort();
    const chave = condo + '|' + datas[0] + '|' + datas[datas.length - 1];
    try {
      if (!cacheConcSL[chave]) cacheConcSL[chave] = await slApi({ acao: 'conciliacao', condominio_id: condo, inicio: datas[0], fim: datas[datas.length - 1] });
      if (document.getElementById('fdCondo').value === condo) renderConc(extratos, docs || [], cacheConcSL[chave]);
    } catch (e) { renderConc(extratos, docs || [], { erro: e.message }); }
  }
  const cacheConcSL = {};

  // cada saída do extrato × despesas do Superlógica: paga com o mesmo valor e até 5 dias (par único),
  // senão em aberto com o mesmo valor (falta dar baixa), senão não lançada
  function casarSL(saidas, sl) {
    const mapa = new Map();
    if (!sl || sl.erro || sl.sem_ligacao) return mapa;
    const igual = (d, s) => Number(d.valor).toFixed(2) === Math.abs(s.valor).toFixed(2);
    const cands = new Map(saidas.map(sd => [sd, sl.pagas.filter(d => d.liquidacao && igual(d, sd) && diasEntre(d.liquidacao, sd.data) <= FOLGA_DIAS)]));
    const disputa = new Map();
    cands.forEach(l => l.forEach(d => disputa.set(d, (disputa.get(d) || 0) + 1)));
    cands.forEach((lista, sd) => {
      if (lista.length === 1 && disputa.get(lista[0]) === 1) mapa.set(sd.id, { tipo: 'paga', ds: lista });
      else if (lista.length) mapa.set(sd.id, { tipo: 'varias', ds: lista });
      else {
        const abertas = sl.em_aberto.filter(d => igual(d, sd));
        mapa.set(sd.id, abertas.length ? { tipo: 'aberto', ds: abertas } : { tipo: 'nada', ds: [] });
      }
    });
    return mapa;
  }
  const descSL = d => [d.favorecido, d.categoria, d.conta_bancaria].filter(Boolean).join(' · ');
  function linhaSL(info, sl) {
    if (!sl) return '<span class="sl-desc miudo">Consultando o Superlógica…</span>';
    if (sl.erro) return `<span class="sl-desc miudo">Superlógica indisponível: ${esc(sl.erro)}</span>`;
    if (sl.sem_ligacao || !info) return '';
    // várias despesas com o mesmo valor, mas todas do mesmo favorecido e conta (ex.: contas de luz): a descrição é a mesma
    const mesmaDescricao = info.ds.length && info.ds.every(d => descSL(d) === descSL(info.ds[0]));
    if (info.tipo === 'paga' || (info.tipo === 'varias' && mesmaDescricao)) return `<span class="sl-desc">Superlógica: <strong>${esc(info.ds[0].favorecido || 'sem favorecido')}</strong>${info.ds[0].categoria ? ' · ' + esc(info.ds[0].categoria) : ''}${info.ds[0].conta_bancaria ? ' · ' + esc(info.ds[0].conta_bancaria) : ''}</span>`;
    if (info.tipo === 'varias') return `<span class="sl-desc">Superlógica (mais de uma com esse valor): ${info.ds.slice(0, 3).map(d => esc(d.favorecido)).join(' ou ')}</span>`;
    if (info.tipo === 'aberto') return `<span class="sl-desc"><span class="tag pendente">em aberto no Superlógica — falta dar baixa</span> ${esc(info.ds[0].favorecido)}${info.ds[0].vencimento ? ' · vence ' + fmtData(info.ds[0].vencimento) : ''}</span>`;
    return '<span class="sl-desc"><span class="tag atrasada">não lançado no Superlógica</span></span>';
  }
  let ultimaConc = null;   // para a planilha

  function renderConc(extratos, docs, sl) {
    let mapaSL = new Map();
    const fmtL = l => `<span>${fmtData(l.data)}</span><span>${esc(l.descricao || '—')}${linhaSL(mapaSL.get(l.id), sl)}</span>`;
    const refDoc = g => `<span class="doc-ref">${g.docs.map(d => `${TIPOS_DOC[d.tipo]} · ${esc(d.fornecedor)}${d.data_pagamento ? ' · pago ' + fmtData(d.data_pagamento) : ''}`).join('<br>')}</span>`;
    document.getElementById('concExtratos').innerHTML = extratos.length ? extratos.map(e => {
      const n = e.extrato_lancamentos.length, s = e.extrato_lancamentos.filter(l => Number(l.valor) < 0).length;
      return `<div class="conc-extrato" data-extrato="${e.id}">${ic('arquivo')}<strong>${esc(e.nome_arquivo)}</strong>
        <span class="miudo">${[e.banco, e.agencia && 'ag. ' + e.agencia, e.conta && 'conta ' + e.conta].filter(Boolean).map(esc).join(' · ')}${e.periodo_inicio ? ' · ' + fmtData(e.periodo_inicio) + ' a ' + fmtData(e.periodo_fim) : ''} · ${n} lançamentos (${s} saídas)</span>
        <div class="acoes">${e.arquivo_confirmado ? '<button class="btn sec peq" data-ext-acao="baixar">Baixar OFX</button>' : '<span class="tag pendente">arquivo original não guardado</span>'}<button class="btn perigo peq" data-ext-acao="excluir">Excluir</button></div></div>`;
    }).join('') : '<p class="vazio">Nenhum extrato enviado para este condomínio neste mês.</p>';
    document.getElementById('concPlanilha').hidden = !extratos.length;
    if (!extratos.length) { document.getElementById('concResumo').innerHTML = ''; document.getElementById('concResultado').innerHTML = ''; ultimaConc = null; return; }

    const r = conciliar(extratos, docs);
    mapaSL = casarSL(r.saidas, sl);
    ultimaConc = { r, mapaSL, sl, docs };
    const contaSL = t => r.saidas.filter(x => (mapaSL.get(x.id) || {}).tipo === t).length;
    const pct = r.saidas.length ? Math.round(r.conciliados.length / r.saidas.length * 100) : 0;
    document.getElementById('concResumo').innerHTML = `
      <span class="tag paga">Conciliados: ${r.conciliados.length} de ${r.saidas.length} saídas (${pct}%)</span>
      <span class="tag atrasada">Pagamentos sem comprovante: ${r.semComprovante.length} · ${brl(somaV(r.semComprovante))}</span>
      <span class="tag pendente">Comprovantes sem pagamento: ${r.semPagamento.length}</span>
      ${r.ambiguos.length ? `<span class="tag trocar">Para conferir à mão: ${r.ambiguos.length}</span>` : ''}
      <span class="tag sl">Entradas (fora da comparação): ${r.entradas.length} · ${brl(somaV(r.entradas))}</span>
      ${sl && !sl.erro && !sl.sem_ligacao ? `<span class="tag sl">Superlógica: ${contaSL('paga') + contaSL('varias')} lançadas e pagas · ${contaSL('aberto')} falta dar baixa · ${contaSL('nada')} não lançadas</span>` : ''}`;
    const grupo = (titulo, itens, linha, vazio) => `<div class="conc-grupo"><h3>${titulo}</h3>${itens.length ? itens.map(linha).join('') : `<p class="miudo">${vazio}</p>`}</div>`;
    document.getElementById('concResultado').innerHTML =
      grupo(ic('alerta') + 'Pagamentos sem comprovante', r.semComprovante, l => `<div class="conc-linha">${fmtL(l)}<span class="doc-ref">ninguém enviou a nota</span><span class="v mais">${brl(Math.abs(l.valor))}</span></div>`, 'Todas as saídas têm comprovante.') +
      grupo(ic('alerta') + 'Comprovantes sem pagamento no extrato', r.semPagamento, g => `<div class="conc-linha"><span>${g.data ? fmtData(g.data) : 'sem data'}</span><span>${esc(g.fornecedor)}</span>${refDoc(g)}<span class="v">${brl(g.valor)}</span></div>`, 'Todos os comprovantes do mês aparecem no extrato.') +
      (r.ambiguos.length ? grupo(ic('duvida') + 'Para conferir à mão (mais de um comprovante com o mesmo valor)', r.ambiguos, a => `<div class="conc-linha">${fmtL(a.saida)}<span class="doc-ref">${a.grupos.map(g => esc(g.fornecedor)).join(' ou ')}</span><span class="v">${brl(Math.abs(a.saida.valor))}</span></div>`, '') : '') +
      grupo(ic('check') + 'Conciliados', r.conciliados, c => `<div class="conc-linha">${fmtL(c.saida)}${refDoc(c.grupo)}<span class="v menos">${brl(Math.abs(c.saida.valor))}</span></div>`, 'Nenhuma saída conciliada ainda.');
  }

  // envio do OFX: lê no navegador, grava os lançamentos e guarda o arquivo original no R2
  async function enviarExtrato(file, condo) {
    const bytes = await file.arrayBuffer();
    const texto = new TextDecoder('windows-1252').decode(bytes);
    const ofx = lerOfx(texto);
    if (!ofx.lancamentos.length) throw new Error(`"${file.name}" não parece um extrato OFX (nenhum lançamento encontrado).`);
    // mês do extrato = mês com mais lançamentos
    const porMes = {};
    ofx.lancamentos.forEach(l => { porMes[l.data.slice(0, 7)] = (porMes[l.data.slice(0, 7)] || 0) + 1; });
    const competencia = Object.entries(porMes).sort((a, b) => b[1] - a[1])[0][0];
    const sha256 = await hashSha256(new Blob([bytes]));
    // lançamentos repetidos no mesmo arquivo (mesmo FITID) entram uma vez só
    const vistos = new Set();
    const linhas = ofx.lancamentos.filter(l => !l.id_banco || (!vistos.has(l.id_banco) && vistos.add(l.id_banco)))
      .map(l => ({ data: l.data, valor: l.valor, descricao: l.descricao, tipo: l.tipo, id_banco: l.id_banco || null }));
    const { data: extId, error } = await sb.rpc('criar_extrato_com_lancamentos', {
      p_extrato: {
        condominio_id: condo, competencia, nome_arquivo: file.name, sha256, tamanho: file.size,
        banco: ofx.banco || null, agencia: ofx.agencia || null, conta: ofx.conta || null,
        periodo_inicio: ofx.inicio, periodo_fim: ofx.fim
      },
      p_lancamentos: linhas
    });
    if (error) throw new Error(/duplicate|unique/i.test(error.message) ? `"${file.name}" já foi enviado para este condomínio.` : mensagemUsuario(error, 'Não foi possível registrar o extrato.'));
    let guardado = true;
    try {
      const { url } = await docsApi({ acao: 'extrato_upload_url', extrato_id: extId, tamanho: file.size });
      await putArquivo(url, file, 'application/x-ofx', () => {});
      await docsApi({ acao: 'extrato_confirmar', extrato_id: extId });
    } catch (e) { guardado = false; }
    return { competencia, n: linhas.length, guardado };
  }
  document.getElementById('concArquivo').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    const condo = document.getElementById('fdCondo').value;
    for (const f of files) {
      try {
        const r = await enviarExtrato(f, condo);
        toast(`Extrato lido: ${r.n} lançamentos de ${nomeMes(r.competencia)}${r.guardado ? '' : ' (o arquivo original não foi guardado)'}`);
        if (r.competencia !== mesSel) { mesSel = r.competencia; render(); continue; }
      } catch (err) { toast(mensagemUsuario(err, 'Não foi possível importar este extrato. Confira o arquivo e tente novamente.')); }
    }
    carregarConc();
  });
  document.getElementById('concPlanilha').addEventListener('click', () => {
    if (!ultimaConc) return;
    const { r, mapaSL } = ultimaConc;
    const comprovante = new Map();
    r.conciliados.forEach(c => comprovante.set(c.saida.id, c.grupo.docs.map(d => `${TIPOS_DOC[d.tipo]} · ${d.fornecedor}`).join(' / ')));
    r.ambiguos.forEach(a => comprovante.set(a.saida.id, 'conferir: ' + a.grupos.map(g => g.fornecedor).join(' ou ')));
    const situacaoSL = { paga: 'lançada e paga', varias: 'mais de uma com esse valor', aberto: 'em aberto (falta dar baixa)', nada: 'não lançada' };
    const linhas = [['Data', 'Descrição no banco', 'Valor', 'Tipo', 'Superlógica', 'Situação no Superlógica', 'Comprovante no Portal', 'Banco / conta']];
    [...r.saidas, ...r.entradas].sort((a, b) => a.data.localeCompare(b.data)).forEach(l => {
      const info = mapaSL.get(l.id);
      linhas.push([fmtData(l.data), l.descricao || '', fmtValorInput(l.valor), l.valor < 0 ? 'saída' : 'entrada',
        info ? info.ds.map(descSL).join(' | ') : '', l.valor < 0 && info ? situacaoSL[info.tipo] : '',
        l.valor < 0 ? (comprovante.get(l.id) || 'sem comprovante') : '',
        [l.extrato.banco, l.extrato.conta].filter(Boolean).join(' · ')]);
    });
    const condo = condosDocs.find(c => c.id === document.getElementById('fdCondo').value);
    baixar(`conciliacao - ${condo ? condo.nome : 'condominio'} - ${mesSel}.csv`, paraCsv(linhas), 'text/csv;charset=utf-8');
  });
  document.getElementById('concExtratos').addEventListener('click', async e => {
    const acao = e.target.dataset.extAcao; if (!acao) return;
    const id = e.target.closest('[data-extrato]').dataset.extrato;
    try {
      if (acao === 'baixar') { const { url } = await docsApi({ acao: 'extrato_download_url', extrato_id: id }); location.href = url; }
      if (acao === 'excluir') {
        if (!confirm('Excluir este extrato e todos os lançamentos dele da conciliação?')) return;
        await docsApi({ acao: 'extrato_excluir', extrato_id: id }); toast('Extrato excluído'); carregarConc();
      }
    } catch (err) { toast(mensagemUsuario(err, 'Não foi possível concluir a ação do extrato.')); }
  });

  // ---------- visão geral (Super Master): escritório + todos os condomínios ----------
  let geralCarregando = false;
  function kpiCard(rot, val, det, cls) {
    return `<div class="card kpi ${cls || ''}"><div class="rot">${rot}</div><div class="val">${val}</div><div class="det">${det || ''}</div></div>`;
  }
  function renderGeralEscritorio() {
    const ant = somaMes(mesSel, -1);
    const tA = totais(mesSel), tP = totais(ant);
    const m = dados.meses[mesSel];
    const fixas = fixasDoMes(mesSel);
    const pend = m ? fixas.filter(f => !m.contas[f.id].pago) : [];
    document.getElementById('geralEscritorio').innerHTML =
      kpiCard('Total gasto no mês', brl(tA.total), variacaoTxt(tA.total, tP.total, tP.existe), 't-' + tendencia(tA.total, tP.total, tP.existe)) +
      kpiCard('Contas fixas', brl(tA.fixas), variacaoTxt(tA.fixas, tP.fixas, tP.existe), 't-' + tendencia(tA.fixas, tP.fixas, tP.existe)) +
      kpiCard('Despesas variáveis', brl(tA.variaveis), variacaoTxt(tA.variaveis, tP.variaveis, tP.existe), 't-' + tendencia(tA.variaveis, tP.variaveis, tP.existe)) +
      kpiCard('Contas a pagar', pend.length ? brl(pend.reduce((s, f) => s + m.contas[f.id].valor, 0)) : 'Tudo pago',
        `<span class="neutro">${pend.length ? pend.map(f => esc(f.nome)).join(', ') : 'Nenhuma conta pendente'}</span>`, pend.length ? 't-alerta' : 't-ok');
  }
  async function carregarGeral() {
    if (!perfil || perfil.papel !== 'super_master') return;
    renderGeralEscritorio();
    renderGeralUsuarios();
    if (geralCarregando) return;
    geralCarregando = true;
    try {
      await carregarCondos();
      const [{ data: docs }, conc] = await Promise.all([
        sb.from('documentos').select('id, condominio_id, status, valor, fornecedor, data_pagamento, competencia, tipo').in('competencia', [somaMes(mesSel, -1), mesSel, somaMes(mesSel, 1)]),
        carregarExtratos(null, mesSel)
      ]);
      renderGeralCondos((docs || []).filter(d => d.competencia === mesSel), conc, docs || []);
    } finally { geralCarregando = false; }
  }
  let ultimoGeral = null;    // últimos dados da tabela, para redesenhar quando a lista de usuários chegar
  function renderGeralCondos(docs, extratos = [], docsVizinhos = docs) {
    ultimoGeral = [docs, extratos, docsVizinhos];
    const n = (cid, st) => docs.filter(d => d.condominio_id === cid && (!st || d.status === st)).length;
    const linhas = condosDocs.map(c => {
      const pessoas = (adminDados.usuarios || []).filter(u => u.condominios.includes(c.id));
      const cont = [['enviado', 'pendente', 'aguardando'], ['pendencia', 'atrasada', 'pendência'], ['conferido', 'paga', 'conferidos']]
        .map(([st, cls, rot]) => n(c.id, st) ? `<span class="tag ${cls}">${n(c.id, st)} ${rot}</span>` : '').join('');
      return `<tr class="clicavel" data-geral-docs="${c.id}" title="Abrir ${esc(c.nome)}">
        <td class="titulo-linha"><strong>${esc(c.nome)}</strong>${c.id_superlogica ? ` <span class="tag sl">SL ${c.id_superlogica}</span>` : ''}</td>
        <td data-label="Documentos"><div class="contagens">${cont || '<span class="miudo">Nenhum documento enviado</span>'}</div></td>
        <td data-label="Conciliação">${colunaConc(c.id, extratos, docsVizinhos)}</td>
        <td data-label="Usuários" class="pessoas">${pessoas.length ? pessoas.map(u => esc(u.nome) + (u.trocar_senha ? ' <span class="tag trocar">1º acesso</span>' : '')).join('<br>') : '<span class="tag atrasada">Sem síndica cadastrada</span>'}</td>
        <td class="num"><button class="btn sec peq" data-geral-docs="${c.id}">Abrir condomínio</button></td>
      </tr>`;
    });
    document.getElementById('tabGeralCondos').innerHTML = linhas.join('') ||
      '<tr><td colspan="5" class="vazio">Nenhum condomínio no Portal. Em Acessos → Condomínios, clique em “Importar do Superlógica”.</td></tr>';
    const aguardando = docs.filter(d => d.status === 'enviado').length;
    const pendencia = docs.filter(d => d.status === 'pendencia').length, conferidos = docs.filter(d => d.status === 'conferido').length;
    document.getElementById('geralKpisCondos').innerHTML =
      kpiCard('Condomínios', condosDocs.length, `<span class="neutro">${condosDocs.filter(c => c.id_superlogica).length} ligados ao Superlógica</span>`) +
      kpiCard('Aguardando conferência', aguardando, '<span class="neutro">documentos enviados pelas síndicas</span>', aguardando ? 't-alerta' : 't-ok') +
      kpiCard('Com pendência', pendencia, '<span class="neutro">correções pedidas às síndicas</span>', pendencia ? 't-mais' : 't-ok') +
      kpiCard('Conferidos', conferidos, `<span class="neutro">de ${docs.length} documento${docs.length === 1 ? '' : 's'} no mês</span>`, conferidos ? 't-ok' : '');
  }
  function renderGeralUsuarios() {
    const us = adminDados.usuarios || [];
    const por = p => us.filter(u => u.papel === p && u.ativo).length;
    const semVinculo = us.filter(u => u.ativo && !u.equipe_slz && u.papel !== 'super_master' && !u.condominios.length);
    const primeiro = us.filter(u => u.ativo && u.trocar_senha);
    const bloqueados = us.filter(u => !u.ativo);
    document.getElementById('geralUsuarios').innerHTML =
      kpiCard('Usuários ativos', us.filter(u => u.ativo).length, `<span class="neutro">${por('super_master')} Super Master · ${por('master')} Master · ${por('padrao')} Padrão</span>`) +
      kpiCard('Equipe SLZ × condomínios', us.filter(u => u.ativo && (u.equipe_slz || u.papel === 'super_master')).length + ' · ' + us.filter(u => u.ativo && !u.equipe_slz && u.papel !== 'super_master').length,
        '<span class="neutro">equipe do escritório · síndicas e usuários de condomínio</span>') +
      kpiCard('Ainda no 1º acesso', primeiro.length, `<span class="neutro">${primeiro.length ? primeiro.map(u => esc(u.nome)).join(', ') : 'todos já criaram a senha'}</span>`, primeiro.length ? 't-alerta' : 't-ok') +
      kpiCard('Sem condomínio / bloqueados', semVinculo.length + ' · ' + bloqueados.length,
        `<span class="neutro">${semVinculo.length ? 'sem condomínio: ' + semVinculo.map(u => esc(u.nome)).join(', ') : 'todos com acesso definido'}</span>`, semVinculo.length ? 't-mais' : '');
  }
  document.getElementById('geralAtualizar').addEventListener('click', e => executarBotao(e.currentTarget, 'Atualizando…', async () => {
    await carregarUsuarios(); await carregarGeral(); toast('Visão geral atualizada');
  }, 'Não foi possível atualizar a visão geral.'));
  // clicar num condomínio (linha ou botão) abre a área daquele condomínio
  function abrirCondominio(id) {
    document.getElementById('fdTodosMeses').checked = false;
    document.getElementById('fdCondo').value = id;
    try { sessionStorage.setItem('slz-condo', id); } catch (e) {}
    irParaAba('documentos');
    window.scrollTo(0, 0);
  }
  document.getElementById('tabGeralCondos').addEventListener('click', e => {
    const alvo = e.target.closest('[data-geral-docs]');
    if (alvo) abrirCondominio(alvo.dataset.geralDocs);
  });
  // clicar nos indicadores do escritório abre o escritório
  document.getElementById('geralEscritorio').addEventListener('click', () => { irParaAba('painel'); window.scrollTo(0, 0); });

  // ---------- início ----------
  (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await entrar(session.user); else mostrarTela('telaLogin');
  })();
})();
