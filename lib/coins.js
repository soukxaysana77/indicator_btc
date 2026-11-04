'use strict';
// Altcoins covered by /alts.html and /coin.html: top market-cap coins that
// have enough Binance history to score, plus PEPE and LUNC by request. (HYPE is
// top-10 but only listed on Binance in Sep 2026 — too little history to score.)
// LUNCUSDT starts on 2022-09-09, after the May 2022 Terra collapse, so its
// all-time high and 2-year average only cover the post-collapse years.
//   cm      CoinMetrics asset id, when its free tier has MVRV for the coin
//   futures Binance USDⓈ-M perpetual symbol (funding rate)
//   etf     has US spot ETFs: the coin page shows their flows (SoSoValue, needs a free API key)

const COINS = [
  { symbol: 'ETH', name: 'Ethereum', cm: 'eth', futures: 'ETHUSDT' },
  { symbol: 'BNB', name: 'BNB', futures: 'BNBUSDT' },
  { symbol: 'XRP', name: 'XRP', cm: 'xrp', futures: 'XRPUSDT', etf: true },
  { symbol: 'SOL', name: 'Solana', futures: 'SOLUSDT' },
  { symbol: 'TRX', name: 'TRON', futures: 'TRXUSDT' },
  { symbol: 'ZEC', name: 'Zcash', futures: 'ZECUSDT' },
  { symbol: 'DOGE', name: 'Dogecoin', cm: 'doge', futures: 'DOGEUSDT' },
  { symbol: 'LINK', name: 'Chainlink', cm: 'link', futures: 'LINKUSDT' },
  { symbol: 'ADA', name: 'Cardano', cm: 'ada', futures: 'ADAUSDT' },
  { symbol: 'PEPE', name: 'Pepe', futures: '1000PEPEUSDT' },
  { symbol: 'LUNC', name: 'Terra Classic', futures: '1000LUNCUSDT' },
];

module.exports = { COINS };
