'use strict';
// Small statistics helpers shared by the research-backed modules.

// Spearman rank correlation of two equal-length arrays; null below minN points.
function spearman(xs, ys, minN = 300) {
  const n = xs.length;
  if (n < minN) return null;
  const rank = (a) => {
    const order = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    order.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

module.exports = { spearman };
