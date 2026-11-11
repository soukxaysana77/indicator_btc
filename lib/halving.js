'use strict';
// Halving facts for the BTC page: every 210,000 blocks (about 4 years) the new
// BTC paid per block halves. Past halvings are fixed history; the next one is
// estimated from the live block height and the average block time since the
// last halving. Without a live height (offline, first run), the height is
// estimated from the clock at 10 minutes a block and flagged as estimated.
// The price cycles around each halving are worked out in public/halving.js
// from the page's daily history. Context only: not part of any score.

const BLOCKS = 210000;
const MAX_SUPPLY = 21e6;
const TARGET_MIN = 10; // minutes per block the network aims for
// Block time (UTC) of each halving block.
const PAST = [
  { n: 1, height: 210000, time: Date.UTC(2012, 10, 28, 15, 24, 38) },
  { n: 2, height: 420000, time: Date.UTC(2016, 6, 9, 16, 46, 13) },
  { n: 3, height: 630000, time: Date.UTC(2020, 4, 11, 19, 23, 43) },
  { n: 4, height: 840000, time: Date.UTC(2024, 3, 20, 0, 9, 27) },
];

const rewardAt = (height) => 50 / 2 ** Math.floor(height / BLOCKS);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// BTC paid out by blocks 0..height.
function minedAt(height) {
  let total = 0;
  for (let era = 0; era * BLOCKS <= height && era < 64; era++) {
    const from = era * BLOCKS;
    total += (Math.min(height, from + BLOCKS - 1) - from + 1) * (50 / 2 ** era);
  }
  return total;
}

// tip: { height, at, source } from the block-height source, or null.
function buildHalving(tip, now = Date.now()) {
  const last = PAST[PAST.length - 1];
  const live = Number.isInteger(tip?.height) && tip.height > last.height && tip.at > last.time;
  const height = live ? tip.height : last.height + Math.floor((now - last.time) / (TARGET_MIN * 60000));
  const at = live ? tip.at : now;
  // Average minutes per block since the last halving (blocks have run a little
  // faster than 10 minutes as hashrate grew); the clock estimate assumes 10.
  const minutesPerBlock = live ? (at - last.time) / 60000 / (height - last.height) : TARGET_MIN;
  const nextHeight = (Math.floor(height / BLOCKS) + 1) * BLOCKS;
  const blocksLeft = nextHeight - height;
  const nextTime = at + blocksLeft * minutesPerBlock * 60000;
  const reward = rewardAt(height);
  const mined = minedAt(height);
  const perDay = (1440 / minutesPerBlock) * reward;
  return {
    past: PAST.map((h) => ({ n: h.n, height: h.height, date: iso(h.time), from: rewardAt(h.height - 1), to: rewardAt(h.height) })),
    height,
    heightAt: at,
    heightSource: live ? tip.source : null,
    minutesPerBlock: Math.round(minutesPerBlock * 100) / 100,
    reward,
    perDay: Math.round(perDay),
    mined: Math.round(mined),
    minedPct: Math.round((mined / MAX_SUPPLY) * 10000) / 100,
    inflationPct: Math.round(((perDay * 365) / mined) * 10000) / 100,
    next: {
      n: last.n + Math.round((nextHeight - last.height) / BLOCKS),
      height: nextHeight,
      blocksLeft,
      date: iso(nextTime),
      daysLeft: Math.round((nextTime - now) / 86400000),
      to: rewardAt(nextHeight),
    },
  };
}

module.exports = { buildHalving, minedAt };
