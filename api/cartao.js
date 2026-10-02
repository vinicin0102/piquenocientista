/**
 * POST /api/cartao — cobrança no cartão de crédito nacional (BRL, card_raw).
 * { plano, extras?, pedido?, nome, cpf, email, telefone, rastreio?,
 *   cartao: { numero, titular, mes, ano, cvv }, parcelas? }
 * -> { status: PAID | PENDING | PENDING_3DS, transactionId, valor, parcelas, redirect? }
 *
 * Os dados do cartão passam por aqui só para serem repassados à ZuckPay.
 * NUNCA são gravados, registrados em log ou devolvidos — nem com DEBUG=1.
 */
import crypto from 'node:crypto';
import { rota, json, Falha, corpoJson, montarPedido, zuckpay, urlWebhook, registrarPedido,
  primeiroNome, luhnValido, dentroDoLimite, ipDe, detalheDebug, configCartao } from '../lib/core.js';
import { MAX_PARCELAS, LIMITE_CARTAO, CARTAO_ATIVO } from '../lib/config.js';

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

export const POST = rota(async (request) => {
  if (!CARTAO_ATIVO) {
    return json(503, { erro: 'Pagamento com cartão indisponível no momento. Por favor, pague com PIX.', cartaoIndisponivel: true });
  }

  // Anti card testing: robôs usam formulários de cartão para testar cartões roubados.
  if (!(await dentroDoLimite('cartao', ipDe(request), LIMITE_CARTAO.tentativas, LIMITE_CARTAO.janela))) {
    return json(429, { erro: 'Muitas tentativas com cartão. Aguarde alguns minutos ou pague com PIX.' });
  }

  const corpo = await corpoJson(request);
  const c = corpo.cartao && typeof corpo.cartao === 'object' ? corpo.cartao : {};
  delete corpo.cartao;
  const p = montarPedido(corpo, 'cartao');

  const numero = soDigitos(c.numero);
  const titular = String(c.titular ?? '').replace(/\s+/g, ' ').trim();
  const mes = Number(soDigitos(c.mes));
  let ano = soDigitos(c.ano);
  if (ano.length === 2) ano = '20' + ano;
  const cvv = soDigitos(c.cvv);
  const parcelas = Number(corpo.parcelas ?? 1);

  const campos = {};
  if (numero.length < 13 || numero.length > 19 || !luhnValido(numero)) campos['cartao-numero'] = 'Número do cartão inválido.';
  if (titular.length < 3 || titular.length > 60) campos['cartao-titular'] = 'Informe o nome como está no cartão.';
  const agora = new Date();
  const fimValidade = new Date(Number(ano), mes, 1); // 1º dia do mês seguinte
  if (!(mes >= 1 && mes <= 12) || ano.length !== 4 || fimValidade <= agora || Number(ano) > agora.getFullYear() + 20) {
    campos['cartao-validade'] = 'Validade inválida.';
  }
  if (cvv.length < 3 || cvv.length > 4) campos['cartao-cvv'] = 'CVV inválido.';
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > MAX_PARCELAS) campos['cartao-parcelas'] = 'Número de parcelas inválido.';
  if (Object.keys(campos).length) throw new Falha(422, { erro: 'Confira os dados do cartão.', campos });

  // Pergunta à ZuckPay como o cartão está para estas credenciais. Se ela diz
  // que está desligado, nem tenta cobrar; se informa o endpoint de cobrança,
  // usa exatamente ele.
  const cfg = await configCartao();
  if (cfg.habilitado === false) {
    console.error('[cartao] /card/keys diz que o cartão nacional está desligado:', JSON.stringify(cfg.resumo));
    return json(503, { erro: 'Pagamento com cartão indisponível no momento. Por favor, pague com PIX.', cartaoIndisponivel: true });
  }
  const endpoint = cfg.endpoint || '/card/charge';

  // Grava ANTES de cobrar: numa aprovação imediata o webhook pode chegar antes desta resposta.
  await registrarPedido(p.externalId, {
    plano: p.planoId, metodo: 'cartao', primeiro_nome: primeiroNome(p.nome), extras: p.extrasIds,
    valor: p.centavos / 100, parcelas,
  });

  const { status, dados } = await zuckpay('POST', endpoint, {
    ...p.payload,
    urlnoty: urlWebhook(request),
    currency: 'BRL',
    country: 'BR',
    installments: parcelas,
    card_raw: {
      number: numero,
      holder_name: titular.toUpperCase(),
      exp_month: String(mes).padStart(2, '0'),
      exp_year: ano,
      cvv,
    },
  });

  if (status === 429) return json(429, { erro: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos ou pague com PIX.' });

  // 403: cartão não habilitado na conta ZuckPay ("não está disponível para
  // este vendedor") ou IP bloqueado. Não é culpa do comprador: manda para o PIX.
  if (status === 403) {
    console.error('[cartao] HTTP 403 — cartão indisponível para a conta:', JSON.stringify(dados),
      '| endpoint:', endpoint, '| /card/keys:', JSON.stringify(cfg.resumo));
    return json(503, { erro: 'Pagamento com cartão indisponível no momento. Por favor, pague com PIX.', cartaoIndisponivel: true });
  }

  const situacao = String(dados.status ?? '').toUpperCase();

  // Recusa do banco: o motivo é seguro de mostrar e ajuda o comprador.
  if (situacao === 'FAILED' || situacao === 'REFUSED') {
    let motivo = String(dados.failureMessage ?? '').trim().slice(0, 160);
    if (motivo && !/[.!?]$/.test(motivo)) motivo += '.';
    return json(402, { erro: `Pagamento recusado${motivo ? ': ' + motivo : '.'} Confira os dados, tente outro cartão ou pague com PIX.` });
  }

  if (status !== 200 || !dados.transactionId || !['PAID', 'PENDING', 'PENDING_3DS'].includes(situacao)) {
    const ref = crypto.randomBytes(4).toString('hex');
    // A resposta da ZuckPay não contém o cartão; o payload (que contém) nunca é registrado.
    console.error(`[cartao] ref=${ref} HTTP ${status}`, JSON.stringify(dados));
    return json(502, {
      erro: 'Não foi possível processar o cartão agora. Tente novamente ou pague com PIX.', ref,
      ...detalheDebug({ http: status, resposta: dados }),
    });
  }

  const saida = {
    status: situacao,
    transactionId: String(dados.transactionId),
    valor: Number(dados.amountBrl ?? dados.amount ?? p.centavos / 100),
    parcelas: Number(dados.installments ?? parcelas),
  };

  // 3D Secure: o banco pede autenticação; a página redireciona o comprador.
  if (situacao === 'PENDING_3DS') {
    const url = String(dados.threeDSecureUrl ?? '');
    if (!/^https:\/\//i.test(url)) {
      console.error(`[cartao] PENDING_3DS sem URL https para ${saida.transactionId}`);
      return json(502, { erro: 'Não foi possível concluir a autenticação do cartão. Tente novamente ou pague com PIX.' });
    }
    saida.redirect = url;
  }

  return json(200, saida);
});
