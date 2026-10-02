/**
 * Planos, extras (order bumps) e ajustes do checkout.
 *
 * Os PREÇOS ficam aqui, no servidor, em centavos. O navegador envia só os ids
 * do plano e dos extras; um valor vindo do cliente é sempre ignorado — sem
 * isso, bastaria editar o request para pagar R$ 0,01.
 *
 * Os ids e preços precisam bater com PLANOS / EXTRAS do index.html, que só
 * exibe os valores.
 */

// Cada plano e extra tem um código de 1 letra, usado no external_id_client
// para o webhook saber o que foi comprado mesmo sem banco de dados.
export const PLANOS = {
  'pc-essencial': { codigo: 'e', nome: 'Guia +100 Experimentos — Essencial', centavos: 990,  productIdEnv: 'PRODUCT_ID_ESSENCIAL' },
  'pc-completo':  { codigo: 'c', nome: 'Guia +100 Experimentos — Completo',  centavos: 2700, productIdEnv: 'PRODUCT_ID_COMPLETO' },
};

export const EXTRAS = {
  kit:        { codigo: 'k', nome: 'Kit Cientista em Casa',              centavos: 490 },
  atividades: { codigo: 'a', nome: '50 Atividades Educativas Sem Tela',  centavos: 590 },
  desafios:   { codigo: 'd', nome: 'Desafios do Pequeno Cientista',      centavos: 490 },
  caderno:    { codigo: 'n', nome: 'Caderno de Experimentos',            centavos: 390 },
  passaporte: { codigo: 'p', nome: 'Passaporte do Pequeno Cientista',    centavos: 490 },
  cores:      { codigo: 'o', nome: 'Kit Experimentos com Cores',         centavos: 490 },
  natureza:   { codigo: 't', nome: 'Pequeno Cientista — Natureza',       centavos: 490 },
};

// Liga/desliga o cartão no site. Com false, a página mostra só o PIX e
// /api/cartao recusa qualquer tentativa, mesmo que a ZuckPay tenha o cartão
// ativo. Com true, o cartão aparece quando a ZuckPay confirma que está ativo.
export const CARTAO_ATIVO = false;

// Desconto no cartão (sobre o total, extras incluídos). 0.05 = 5%.
export const DESCONTO_CARTAO = 0.05;

// Parcelas oferecidas no cartão (1 a 12). Acima de 1x a operadora cobra
// juros do comprador. Mude também MAX_PARCELAS no index.html.
export const MAX_PARCELAS = 3;

// Anti "card testing": tentativas de cartão por IP dentro da janela (s).
// Só vale com o Redis configurado (ver README).
export const LIMITE_CARTAO = { tentativas: 5, janela: 1800 };

// Prefixo do external_id_client, para separar as vendas nos relatórios.
export const PREFIXO = 'PQC';
