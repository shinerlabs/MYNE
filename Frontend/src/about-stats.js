const sampledSeries = new Map();
const MAX_SAMPLES = 36;

const finiteValues = (values) => (values || []).map(Number).filter(Number.isFinite);

/** Convert a numeric series into a compact SVG sparkline path. */
export function sparklinePath(values, width = 112, height = 38, padding = 3) {
  const points = finiteValues(values);
  if (!points.length) return '';
  if (points.length === 1) points.push(points[0]);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  return points.map((value, index) => {
    const x = padding + (index / (points.length - 1)) * (width - padding * 2);
    const y = range === 0
      ? height / 2
      : padding + ((max - value) / range) * (height - padding * 2);
    return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

const sampled = (key, value) => {
  const next = sampledSeries.get(key) || [];
  if (Number.isFinite(value) && next.at(-1) !== value) next.push(value);
  if (next.length > MAX_SAMPLES) next.splice(0, next.length - MAX_SAMPLES);
  sampledSeries.set(key, next);
  return next;
};

/** Paint live values and transparent, data-backed mini charts into the Stats chapter. */
export function renderProtocolStats(root, metrics, updatedAt = Date.now()) {
  if (!root) return;
  root.querySelectorAll('[data-protocol-stat]').forEach((row) => {
    const key = row.dataset.protocolStat;
    const metric = metrics[key];
    const value = row.querySelector('[data-stat-value]');
    const path = row.querySelector('[data-stat-line]');
    const dot = row.querySelector('[data-stat-last]');
    if (!metric) {
      if (value) value.textContent = 'Unavailable';
      row.classList.add('unavailable');
      if (path) path.setAttribute('d', '');
      if (dot) dot.setAttribute('hidden', '');
      row.setAttribute('aria-label', `${row.querySelector('b')?.textContent || key}: unavailable`);
      return;
    }

    row.classList.remove('unavailable');
    if (value) value.textContent = metric.label;
    const history = finiteValues(metric.history);
    const series = history.length ? history : sampled(key, Number(metric.value));
    const d = sparklinePath(series);
    if (path) path.setAttribute('d', d);
    if (dot && d) {
      const last = d.split('L').at(-1).replace(/^M/, '').split(',');
      dot.setAttribute('cx', last[0]);
      dot.setAttribute('cy', last[1]);
      dot.removeAttribute('hidden');
    }
    row.setAttribute('aria-label', `${row.querySelector('b')?.textContent || key}: ${metric.label}`);
  });

  const stamp = root.querySelector('[data-stats-updated]');
  if (stamp) {
    stamp.textContent = `UPDATED ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    stamp.dateTime = new Date(updatedAt).toISOString();
  }
}
